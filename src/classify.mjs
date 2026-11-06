/**
 * 07 context-mng: message provenance classification.
 *
 * Classification precedence (docs/software-design.md §4), in order:
 *  1. a trusted rc.5 Host source label / tool type from a reviewed whitelist;
 *  2. a trusted 05 injection-marker whitelist (explicit source-kind prefixes);
 *  3. a role/structure heuristic from the message role only;
 *  4. `unknown`.
 *
 * The message body is NEVER used to decide category or permission. Text that
 * says "system prompt", "memory", "secret" or "skill" is ordinary content; a
 * body cannot promote a message into another source, and an unrecognized
 * source never becomes "skill" because the text looks like a skill. Unknown
 * things stay unknown, and untrusted labels are recorded with `heuristic`
 * certainty rather than being trusted.
 *
 * Text extraction is separate from classification: every text-bearing content
 * block is returned for counting/redaction, and non-text modalities (image,
 * file, or merge-extensible unknown blocks) are reported as unpriced instead
 * of being guessed or counted as zero.
 *
 * Message/ContentBlock/MessageSource shapes are the verified rc.5 shapes
 * documented in docs/compatibility.md §5. This module has no dependencies
 * beyond the pure contract helpers and never touches the host, disk or network.
 */

import { canonicalJson, sha256Hex } from './contracts.mjs';
import { utf8Bytes } from './estimate.mjs';

/**
 * Trusted rc.5 `message.source.kind` -> composition category.
 *
 * Only reviewed labels are listed. `compact-checkpoint` has no v1 composition
 * bucket (it is a compaction summary, not system/developer/user/tools/memory),
 * so it keeps `category:'unknown'` while recording `certainty:'identified'`:
 * the source is known, the bucket is not.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const TRUSTED_SOURCE_CATEGORIES = Object.freeze({
  user: 'user',
  'user-question-reply': 'user',
  webhook: 'user',
  'agent-message': 'user',
  'team-message': 'user',
  'system-prompt': 'system',
  tool: 'tool_result',
  model: 'assistant',
  'skill-invocation': 'developer',
  'model-selection': 'developer',
  'runtime-context': 'developer',
  'working-directory': 'developer',
  'user-approval': 'developer',
  'ptc-mode': 'developer',
  'tool-registry': 'developer',
  'plan-mode': 'developer',
  schedule: 'developer',
  goal: 'developer',
  'cordis-host-runner': 'developer',
  'subagent-settled': 'developer',
  'session-reference': 'memory',
  'compact-checkpoint': 'unknown',
});

/**
 * Explicit 05 injection/recall marker whitelist. Only these prefixes make a
 * message `memory`; any other 05-looking name falls through to the role
 * heuristic. See docs/compatibility.md §5 ("no unified marker standard").
 */
export const MEMORY_SOURCE_MARKER_PREFIXES = Object.freeze(['memory-injection', 'memory-recall']);

/** rc.5 role -> category used only by the structural heuristic. */
const ROLE_CATEGORIES = Object.freeze({
  system: 'system',
  developer: 'developer',
  user: 'user',
  assistant: 'assistant',
  tool: 'tool_result',
});

/**
 * Deterministic, locale-independent string comparator.
 *
 * @param {string} left first value.
 * @param {string} right second value.
 * @returns {number} comparator result.
 */
function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Bound a label to the 1..128 character contract, deterministically.
 * Long labels keep a readable prefix plus a digest suffix so two different
 * long labels cannot collapse into one provenance group.
 *
 * @param {unknown} value candidate label.
 * @returns {string|null} bounded label or null.
 */
export function boundLabel(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length <= 128) return value;
  return `${value.slice(0, 96)}#${sha256Hex(value).slice(0, 16)}`;
}

/**
 * Bound an unpriced-modality name to the 1..64 character contract.
 *
 * @param {unknown} value candidate name.
 * @returns {string} bounded modality name.
 */
function boundModality(value) {
  if (typeof value !== 'string' || value.length === 0) return 'unknown_block';
  return value.length <= 64 ? value : value.slice(0, 64);
}

/**
 * Extract text-bearing blocks and unpriced modalities from one rc.5 message.
 * Never throws: malformed content degrades to an unknown (unpriced) block.
 *
 * @param {unknown} message candidate rc.5 message.
 * @returns {{text_blocks: Array<{kind: string, text: string, characters: number, bytes: number}>, unpriced_modalities: string[]}}
 *   extracted display text and unpriced modalities sorted deterministically.
 */
export function extractTextBlocks(message) {
  const content = message !== null && typeof message === 'object' ? message.content : undefined;
  /** @type {unknown[]} */
  let blocks;
  if (typeof content === 'string') {
    // Defensive legacy shape: a bare string is one text block, never inferred
    // into any other category.
    blocks = [{ type: 'text', text: content }];
  } else if (Array.isArray(content)) {
    blocks = content;
  } else {
    blocks = [];
  }

  const text_blocks = [];
  const unpriced = new Set();
  for (const block of blocks) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) {
      unpriced.add('unknown_block');
      continue;
    }
    const type = typeof block.type === 'string' && block.type.length > 0 ? block.type : 'unknown';
    switch (type) {
      case 'text':
      case 'reasoning': {
        if (typeof block.text !== 'string') {
          unpriced.add(`unknown_block:${boundModality(type)}`);
          break;
        }
        text_blocks.push({
          kind: type,
          text: block.text,
          characters: block.text.length,
          bytes: utf8Bytes(block.text),
        });
        break;
      }
      case 'tool-call': {
        let text;
        if (typeof block.arguments === 'string') {
          text = block.arguments;
        } else if (block.arguments === undefined || block.arguments === null) {
          text = '';
        } else {
          try {
            text = canonicalJson(block.arguments);
          } catch {
            unpriced.add('unknown_block:tool-call');
            break;
          }
        }
        text_blocks.push({ kind: 'tool-call', text, characters: text.length, bytes: utf8Bytes(text) });
        break;
      }
      case 'tool-addition':
      case 'tool-removal': {
        if (typeof block.toolName !== 'string') {
          unpriced.add(`unknown_block:${boundModality(type)}`);
          break;
        }
        text_blocks.push({
          kind: type,
          text: block.toolName,
          characters: block.toolName.length,
          bytes: utf8Bytes(block.toolName),
        });
        break;
      }
      case 'image':
        unpriced.add('image');
        break;
      case 'file':
        unpriced.add('file');
        break;
      default:
        unpriced.add(`unknown_block:${boundModality(type)}`);
        break;
    }
  }
  return { text_blocks, unpriced_modalities: [...unpriced].sort(compareStrings) };
}

/**
 * Stable source reference for provenance display. Only trusted, non-content
 * identifiers are used; other labels intentionally stay null.
 *
 * @param {string} sourceKind trusted rc.5 source kind.
 * @param {object} source rc.5 source object.
 * @returns {string|null} bounded reference or null.
 */
function sourceReference(sourceKind, source) {
  if (sourceKind === 'skill-invocation') return boundLabel(source.name);
  if (sourceKind === 'compact-checkpoint') return boundLabel(source.compactionId);
  return null;
}

/**
 * Classify one rc.5-shaped message by provenance only.
 *
 * `toolNames` is accepted for call-site symmetry with projection's tool
 * definition group; it deliberately does not influence message classification,
 * because categories must not depend on unrelated tool names or body text.
 *
 * @param {{id?: unknown, role?: unknown, content?: unknown, source?: unknown}} message
 *   candidate rc.5 message.
 * @param {{toolNames?: Iterable<string>}} [options] reserved tool registry names.
 * @returns {{category: string, source_kind: string|null, source_ref: string|null, certainty: 'identified'|'heuristic'|'unknown', text_blocks: Array<{kind: string, text: string, characters: number, bytes: number}>, unpriced_modalities: string[]}}
 *   provenance classification plus extracted text.
 */
export function classifyMessage(message, { toolNames: _toolNames } = {}) {
  const { text_blocks, unpriced_modalities } = extractTextBlocks(message);
  const rawSource = message !== null && typeof message === 'object' ? message.source : undefined;
  const sourceKind =
    rawSource !== null && typeof rawSource === 'object' && !Array.isArray(rawSource) && typeof rawSource.kind === 'string'
      ? rawSource.kind
      : null;
  const boundedKind = boundLabel(sourceKind);

  // 1. Trusted rc.5 Host source label / tool type.
  if (sourceKind !== null && Object.prototype.hasOwnProperty.call(TRUSTED_SOURCE_CATEGORIES, sourceKind)) {
    return {
      category: TRUSTED_SOURCE_CATEGORIES[sourceKind],
      source_kind: boundedKind,
      source_ref: sourceReference(sourceKind, rawSource),
      certainty: 'identified',
      text_blocks,
      unpriced_modalities,
    };
  }

  // 2. Trusted 05 injection-marker whitelist (explicit prefixes only).
  if (sourceKind !== null && MEMORY_SOURCE_MARKER_PREFIXES.some((prefix) => sourceKind === prefix || sourceKind.startsWith(`${prefix}-`))) {
    return {
      category: 'memory',
      source_kind: boundedKind,
      source_ref: null,
      certainty: 'identified',
      text_blocks,
      unpriced_modalities,
    };
  }

  // 3. Role/structure heuristic: role only, never body words.
  const role = message !== null && typeof message === 'object' && typeof message.role === 'string' ? message.role : null;
  if (role !== null && Object.prototype.hasOwnProperty.call(ROLE_CATEGORIES, role)) {
    return {
      category: ROLE_CATEGORIES[role],
      source_kind: boundedKind,
      source_ref: null,
      certainty: 'heuristic',
      text_blocks,
      unpriced_modalities,
    };
  }

  // 4. Unknown: no trusted label and no recognized role. The label (if any) is
  // recorded as untrusted provenance, but it never becomes a category guess.
  return {
    category: 'unknown',
    source_kind: boundedKind,
    source_ref: null,
    certainty: 'unknown',
    text_blocks,
    unpriced_modalities,
  };
}
