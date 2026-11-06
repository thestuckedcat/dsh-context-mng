/**
 * 07 context-mng: bounded, redacted, deterministic context projection.
 *
 * This is the pure core between an authorized rc.5 session surface and the
 * observation/report contracts. It never reads a session itself: the caller
 * (capture layer) passes the messages it already read under a trusted access
 * binding, so the projection can only ever describe the surface it was given.
 *
 * Honesty rules enforced here (docs/software-design.md §4, CTX-01/CTX-02):
 *  - provenance comes from `classify.mjs`; body text never decides a category;
 *  - every displayed text is redacted before counting, previewing or hashing;
 *  - estimates are UTF-8 byte counts of redacted text, never provider usage;
 *  - images/files/unknown blocks keep `estimated_tokens:null` and are listed
 *    in `unpriced_modalities` until a priced tokenizer exists;
 *  - oversized text is truncated at message/group limits with
 *    `truncated`/`omitted_bytes` flags instead of being silently dropped;
 *  - group ids are deterministic from provenance (`category|source_kind|source_ref`),
 *    so a later re-read of the same surface addresses the same groups;
 *  - `observed_digest` hashes only the redacted projection (no raw text, no
 *    message ids, no timestamps/request refs), so it is stable for the same
 *    content and does not leak a hash oracle over raw content.
 *
 * Provider-reported usage never enters this module: the observation assembler
 * (capture layer) keeps `reported_usage` in its own field, and group estimates
 * are never apportioned from it.
 */

import {
  LIMITS,
  REDACTION_POLICY_REVISION,
  canonicalJson,
  isPlainObject,
  sha256Hex,
} from './contracts.mjs';
import { classifyMessage } from './classify.mjs';
import { createRedactor } from './redact.mjs';
import { combineEstimates, utf8Bytes } from './estimate.mjs';

/** Fixed display order of composition categories (product journey order). */
const CATEGORY_ORDER = Object.freeze([
  'system',
  'developer',
  'user',
  'assistant',
  'tools',
  'tool_result',
  'memory',
  'unknown',
]);

/** Synthetic provenance kind for the tool-definition group. */
const TOOL_DEFINITION_SOURCE_KIND = 'tool-definition';

/** Contract bound for one group's `message_refs` array. */
const MAX_MESSAGE_REFS = 10000;

/** Budget for one provenance component of a deterministic group id. */
const GROUP_ID_COMPONENT_MAX = 48;
const GROUP_ID_COMPONENT_HASH_HEX = 24;

/** Shared default redactor (stateless) plus per-revision instances. */
const DEFAULT_REDACTOR = createRedactor();
const REDACTORS = new Map([[REDACTION_POLICY_REVISION, DEFAULT_REDACTOR]]);

/**
 * Resolve the redaction policy object. A caller may inject a redactor (for
 * capture-level reuse/tests); otherwise a deterministic REDACT-1 redactor is
 * used for the requested revision.
 *
 * @param {{redactionPolicyRevision?: string, redactor?: {redactText: Function}}|undefined} policy
 *   policy object.
 * @returns {{redactionPolicyRevision: string, redactor: {redactText: Function}}} resolved policy.
 */
function resolvePolicy(policy) {
  const revisionRaw = isPlainObject(policy) ? policy.redactionPolicyRevision : undefined;
  const revision =
    typeof revisionRaw === 'string' && revisionRaw.length >= 1 && revisionRaw.length <= 128
      ? revisionRaw
      : REDACTION_POLICY_REVISION;
  const injected = isPlainObject(policy) ? policy.redactor : undefined;
  if (injected !== undefined && injected !== null && typeof injected.redactText === 'function') {
    return { redactionPolicyRevision: revision, redactor: injected };
  }
  let redactor = REDACTORS.get(revision);
  if (redactor === undefined) {
    redactor = createRedactor({ policyRevision: revision });
    REDACTORS.set(revision, redactor);
  }
  return { redactionPolicyRevision: revision, redactor };
}

/**
 * Resolve projection bounds over the contract defaults, clamped to the frozen
 * engineering limits so a caller cannot configure an unbounded projection or
 * an invalid preview size.
 *
 * @param {object|undefined} limits caller overrides (`maxPreviewChars`,
 *   `maxTextCharsPerGroup`, `maxGroups`).
 * @returns {{maxPreviewChars: number, maxTextCharsPerGroup: number, maxGroups: number}}
 *   resolved (possibly reduced) limits.
 */
function resolveLimits(limits) {
  const source = isPlainObject(limits) ? limits : {};
  const bounded = (key, min, fallback) => {
    const value = source[key];
    const base = Number.isSafeInteger(value) ? value : fallback;
    return Math.min(Math.max(base, min), LIMITS[key]);
  };
  return {
    maxPreviewChars: bounded('maxPreviewChars', 0, LIMITS.maxPreviewChars),
    maxTextCharsPerGroup: bounded('maxTextCharsPerGroup', 0, LIMITS.maxTextCharsPerGroup),
    maxGroups: bounded('maxGroups', 1, LIMITS.maxGroups),
  };
}

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
 * Bound one provenance component for use in a group id (1..128 chars total).
 * Long labels keep a readable prefix plus a digest suffix, so different long
 * labels cannot collapse into one id. Empty/absent labels become ''.
 *
 * @param {unknown} value candidate provenance value.
 * @returns {string} bounded component (possibly empty).
 */
function boundIdComponent(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  if (value.length <= GROUP_ID_COMPONENT_MAX) return value;
  const prefixLength = GROUP_ID_COMPONENT_MAX - GROUP_ID_COMPONENT_HASH_HEX - 1;
  return `${value.slice(0, prefixLength)}#${sha256Hex(value).slice(0, GROUP_ID_COMPONENT_HASH_HEX)}`;
}

/**
 * Build the deterministic group id for one provenance bucket.
 *
 * @param {string} category composition category.
 * @param {string|null} sourceKind bounded provenance kind.
 * @param {string|null} sourceRef bounded provenance reference.
 * @returns {string} group id (`category|source_kind|source_ref`).
 */
function makeGroupId(category, sourceKind, sourceRef) {
  return `${category}|${boundIdComponent(sourceKind)}|${boundIdComponent(sourceRef)}`;
}

/**
 * Bound a message reference for `group.message_refs`. Real rc.5 ids are kept;
 * malformed/missing ids become deterministic positional refs for the same
 * input array.
 *
 * @param {unknown} message candidate message.
 * @param {number} index position in the projected message array.
 * @returns {string} bounded message reference.
 */
function messageRef(message, index) {
  const id = message !== null && typeof message === 'object' ? message.id : undefined;
  if (typeof id === 'string' && id.length >= 1 && id.length <= LIMITS.maxIdChars) return id;
  return `idx:${index}`;
}

/**
 * Slice length that never splits a UTF-16 surrogate pair.
 *
 * @param {string} text text to slice.
 * @param {number} maxChars requested maximum length.
 * @returns {number} safe slice length (0..text.length).
 */
function safeCut(text, maxChars) {
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) return 0;
  if (text.length <= maxChars) return text.length;
  let cut = maxChars;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return cut;
}

/**
 * Aggregate per-bucket certainties into the single contract value.
 *
 * @param {Set<string>} certainties message certainties in the bucket.
 * @returns {'identified'|'heuristic'|'unknown'} bucket certainty.
 */
function certaintyFrom(certainties) {
  if (certainties.has('unknown')) return 'unknown';
  if (certainties.has('heuristic')) return 'heuristic';
  return 'identified';
}

/**
 * Compare two provenance buckets into the fixed display order.
 *
 * @param {object} left first bucket.
 * @param {object} right second bucket.
 * @returns {number} comparator result.
 */
function compareBuckets(left, right) {
  const categoryDiff = CATEGORY_ORDER.indexOf(left.category) - CATEGORY_ORDER.indexOf(right.category);
  if (categoryDiff !== 0) return categoryDiff;
  const kindDiff = compareNullable(left.source_kind, right.source_kind);
  if (kindDiff !== 0) return kindDiff;
  return compareNullable(left.source_ref, right.source_ref);
}

/**
 * Compare nullable provenance values with null last.
 *
 * @param {string|null} left first value.
 * @param {string|null} right second value.
 * @returns {number} comparator result.
 */
function compareNullable(left, right) {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return compareStrings(left, right);
}

/**
 * Create one empty provenance bucket.
 *
 * @param {string} groupId deterministic group id.
 * @param {string} category composition category.
 * @param {string|null} sourceKind bounded provenance kind.
 * @param {string|null} sourceRef bounded provenance reference.
 * @returns {object} internal bucket.
 */
function createBucket(groupId, category, sourceKind, sourceRef) {
  return {
    group_id: groupId,
    category,
    source_kind: sourceKind,
    source_ref: sourceRef,
    message_refs: [],
    parts: [],
    redaction_count: 0,
    modalities: new Set(),
    certainties: new Set(),
    truncated: false,
    omitted_bytes: 0,
  };
}

/**
 * Group one redacted message text into its provenance bucket. Content that
 * exceeds the message-reference cap is omitted with flags, never silently
 * dropped and never counted as priced text.
 *
 * @param {object} bucket destination bucket.
 * @param {string} redactedText already redacted message text ('' when none).
 * @param {number} redactions redaction occurrences in that text.
 * @param {{certainty: string, unpriced_modalities: string[]}} classified classification result.
 * @param {string} ref bounded message reference.
 */
function appendBucketText(bucket, redactedText, redactions, classified, ref) {
  if (bucket.message_refs.length >= MAX_MESSAGE_REFS) {
    bucket.truncated = true;
    bucket.omitted_bytes += utf8Bytes(redactedText);
    return;
  }
  bucket.message_refs.push(ref);
  if (redactedText.length > 0) bucket.parts.push(redactedText);
  bucket.redaction_count += redactions;
  bucket.certainties.add(classified.certainty);
  for (const modality of classified.unpriced_modalities) {
    if (typeof modality === 'string' && modality.length > 0) bucket.modalities.add(modality);
  }
}

/**
 * Build every provenance bucket for the passed surface.
 *
 * @param {object} input projection input.
 * @param {unknown[]} input.messages rc.5-shaped messages of the authorized surface.
 * @param {unknown} input.tool_definitions rc.5 tool schemas of the same surface.
 * @param {{redactText: Function}} input.redactor active redactor.
 * @returns {Map<string, object>} buckets keyed by deterministic group id.
 */
function buildBuckets({ messages, tool_definitions, redactor }) {
  /** @type {Map<string, object>} */
  const buckets = new Map();
  const list = Array.isArray(messages) ? messages : [];

  for (let index = 0; index < list.length; index += 1) {
    const message = list[index];
    const classified = classifyMessage(message);
    const groupId = makeGroupId(classified.category, classified.source_kind, classified.source_ref);
    let bucket = buckets.get(groupId);
    if (bucket === undefined) {
      bucket = createBucket(
        groupId,
        classified.category,
        boundIdComponent(classified.source_kind) || null,
        boundIdComponent(classified.source_ref) || null,
      );
      buckets.set(groupId, bucket);
    }
    const rawText = classified.text_blocks
      .map((block) => block.text)
      .filter((text) => text.length > 0)
      .join('\n');
    const redacted = rawText.length === 0 ? { text: '', count: 0 } : redactor.redactText(rawText);
    const redactedText = typeof redacted.text === 'string' ? redacted.text : '';
    const redactionCount =
      Number.isSafeInteger(redacted.count) && redacted.count >= 0 ? redacted.count : 0;
    appendBucketText(bucket, redactedText, redactionCount, classified, messageRef(message, index));
  }

  if (Array.isArray(tool_definitions) && tool_definitions.length > 0) {
    const groupId = makeGroupId('tools', TOOL_DEFINITION_SOURCE_KIND, null);
    const bucket = createBucket(groupId, 'tools', TOOL_DEFINITION_SOURCE_KIND, null);
    bucket.certainties.add('identified');
    let rawText = '';
    try {
      rawText = canonicalJson(tool_definitions);
    } catch {
      bucket.modalities.add('unknown_block:tool-definition');
      rawText = '';
    }
    const redacted = rawText.length === 0 ? { text: '', count: 0 } : redactor.redactText(rawText);
    bucket.redaction_count +=
      typeof redacted.count === 'number' && Number.isSafeInteger(redacted.count) && redacted.count >= 0
        ? redacted.count
        : 0;
    const redactedText = typeof redacted.text === 'string' ? redacted.text : '';
    if (redactedText.length > 0) bucket.parts.push(redactedText);
    buckets.set(groupId, bucket);
  }

  return buckets;
}

/**
 * Finalize buckets into contract-shaped group summaries plus the matching full
 * redacted texts, applying the per-group character bound.
 *
 * @param {Map<string, object>} buckets provenance buckets.
 * @param {{maxPreviewChars: number, maxTextCharsPerGroup: number}} limits resolved limits.
 * @returns {{entries: Array<{group: object, text: string, modalities: string[]}>, truncated: boolean, omitted_bytes: number}}
 *   finalized entries in deterministic display order.
 */
function finalizeBuckets(buckets, limits) {
  const entries = [];
  let truncated = false;
  let omittedBytes = 0;
  const ordered = [...buckets.values()].sort(compareBuckets);

  for (const bucket of ordered) {
    let text = bucket.parts.join('\n');
    let groupTruncated = bucket.truncated;
    let groupOmitted = bucket.omitted_bytes;
    if (text.length > limits.maxTextCharsPerGroup) {
      const cut = safeCut(text, limits.maxTextCharsPerGroup);
      groupOmitted += utf8Bytes(text) - utf8Bytes(text.slice(0, cut));
      text = text.slice(0, cut);
      groupTruncated = true;
    }
    const modalities = [...bucket.modalities].sort(compareStrings);
    const characters = text.length;
    const bytes = utf8Bytes(text);
    const group = {
      group_id: bucket.group_id,
      category: bucket.category,
      source_ref: bucket.source_ref,
      source_kind: bucket.source_kind,
      message_refs: bucket.message_refs,
      characters,
      bytes,
      estimated_tokens: modalities.length > 0 ? null : bytes,
      certainty: certaintyFrom(bucket.certainties),
      preview: text.slice(0, safeCut(text, limits.maxPreviewChars)),
      truncated: groupTruncated,
      redaction_count: bucket.redaction_count,
    };
    entries.push({ group, text, modalities });
    truncated = truncated || groupTruncated;
    omittedBytes += groupOmitted;
  }

  return { entries, truncated, omitted_bytes: omittedBytes };
}

/**
 * Run the shared projection pipeline for both public entry points.
 *
 * @param {object} input projection input.
 * @param {unknown[]} input.messages rc.5-shaped messages of one authorized surface.
 * @param {unknown} [input.tool_definitions] rc.5 tool schemas of that surface.
 * @param {{redactionPolicyRevision?: string, redactor?: {redactText: Function}}} [input.policy]
 *   redaction policy.
 * @param {object} [input.limits] optional bounds overrides.
 * @returns {{entries: Array<object>, totals: {characters: number, bytes: number}, truncated: boolean, omitted_bytes: number, unpriced_modalities: string[], estimate: object, redaction_total: number}}
 *   projection state.
 */
function runProjection({ messages, tool_definitions, policy, limits } = {}) {
  const resolvedPolicy = resolvePolicy(policy);
  const resolvedLimits = resolveLimits(limits);
  const buckets = buildBuckets({
    messages,
    tool_definitions,
    redactor: resolvedPolicy.redactor,
  });
  const finalized = finalizeBuckets(buckets, resolvedLimits);

  let entries = finalized.entries;
  let truncated = finalized.truncated;
  let omittedBytes = finalized.omitted_bytes;
  if (entries.length > resolvedLimits.maxGroups) {
    const dropped = entries.slice(resolvedLimits.maxGroups);
    entries = entries.slice(0, resolvedLimits.maxGroups);
    truncated = true;
    for (const entry of dropped) omittedBytes += entry.group.bytes;
  }

  const groups = entries.map((entry) => entry.group);
  const totals = {
    characters: groups.reduce((sum, group) => sum + group.characters, 0),
    bytes: groups.reduce((sum, group) => sum + group.bytes, 0),
  };
  const modalitySet = new Set();
  for (const entry of entries) for (const modality of entry.modalities) modalitySet.add(modality);
  const unpriced = [...modalitySet].sort(compareStrings);
  const estimate = combineEstimates(
    entries.map((entry) => ({
      tokens: entry.group.estimated_tokens,
      truncated: entry.group.truncated,
      unpriced_modalities: entry.modalities,
    })),
  );
  if (truncated && estimate.complete) estimate.complete = false;
  const redactionTotal = groups.reduce((sum, group) => sum + group.redaction_count, 0);

  return {
    entries,
    groups,
    totals,
    truncated,
    omitted_bytes: omittedBytes,
    unpriced_modalities: unpriced,
    estimate,
    redaction_total: redactionTotal,
  };
}

/**
 * Strip the fields that are not part of the redacted content digest. Message
 * ids, ordering metadata, timestamps and request refs stay outside it: the
 * digest identifies redacted content, never raw text or an arbitrary hash
 * oracle over the original content.
 *
 * @param {object[]} groups group summaries.
 * @returns {object[]} digest-safe group summaries.
 */
function digestGroups(groups) {
  return groups.map((group) => ({
    category: group.category,
    certainty: group.certainty,
    bytes: group.bytes,
    characters: group.characters,
    estimated_tokens: group.estimated_tokens,
    group_id: group.group_id,
    preview: group.preview,
    redaction_count: group.redaction_count,
    source_kind: group.source_kind,
    source_ref: group.source_ref,
    truncated: group.truncated,
  }));
}

/**
 * Safe non-negative count coercion for digest inputs.
 *
 * @param {unknown} value candidate count.
 * @returns {number} a valid non-negative safe integer, else 0.
 */
function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Compute the deterministic observed digest over a redacted projection
 * fragment. Exposed so the capture/store layer can re-hash a fragment after a
 * defense-in-depth trim (and never store trimmed groups under an untrimmed
 * digest).
 *
 * @param {{groups?: object[], estimate?: object, totals?: {characters: number, bytes: number}, truncated?: boolean, omitted_bytes?: number, redaction_total?: number, unpriced_modalities?: string[]}} fragment
 *   projection fragment (an extra `observed_digest` field is ignored).
 * @returns {string} 64 lowercase hex SHA-256 of the canonical redacted content.
 */
export function computeObservedDigest(fragment) {
  const source = isPlainObject(fragment) ? fragment : {};
  const groups = Array.isArray(source.groups) ? source.groups.filter(isPlainObject) : [];
  const material = {
    estimate: isPlainObject(source.estimate) ? source.estimate : null,
    groups: digestGroups(groups),
    omitted_bytes: safeCount(source.omitted_bytes),
    redaction_total: safeCount(source.redaction_total),
    totals: isPlainObject(source.totals)
      ? { characters: safeCount(source.totals.characters), bytes: safeCount(source.totals.bytes) }
      : { characters: 0, bytes: 0 },
    truncated: source.truncated === true,
    unpriced_modalities: Array.isArray(source.unpriced_modalities)
      ? source.unpriced_modalities.filter((item) => typeof item === 'string')
      : [],
  };
  return sha256Hex(canonicalJson(material));
}

/**
 * Project one authorized rc.5 surface into a bounded, redacted observation
 * fragment.
 *
 * The caller must have applied access control before reading the surface; this
 * function only ever describes the messages/tool definitions it is given. Its
 * output contains no provider usage: `capture` keeps `reported_usage` in the
 * separate observation field and never apportions it back into groups.
 *
 * @param {object} input projection input.
 * @param {unknown[]} input.messages rc.5-shaped messages of one authorized surface.
 * @param {unknown} [input.tool_definitions] rc.5 tool schemas of that surface.
 * @param {{redactionPolicyRevision?: string, redactor?: {redactText: Function}}} [input.policy]
 *   redaction policy (revision recorded by the report; injected redactor honored).
 * @param {{maxPreviewChars?: number, maxTextCharsPerGroup?: number, maxGroups?: number}} [input.limits]
 *   optional clamped overrides of the contract engineering limits.
 * @returns {{groups: object[], estimate: object, totals: {characters: number, bytes: number}, truncated: boolean, omitted_bytes: number, unpriced_modalities: string[], observed_digest: string, redaction_total: number}}
 *   contract-valid observation fragment.
 */
export function projectMessages({ messages, tool_definitions, policy, limits } = {}) {
  const state = runProjection({ messages, tool_definitions, policy, limits });
  const fragment = {
    groups: state.groups,
    estimate: state.estimate,
    totals: state.totals,
    truncated: state.truncated,
    omitted_bytes: state.omitted_bytes,
    unpriced_modalities: state.unpriced_modalities,
    redaction_total: state.redaction_total,
  };
  return { ...fragment, observed_digest: computeObservedDigest(fragment) };
}

/**
 * Rebuild the full redacted group texts for an already projected (or re-read)
 * surface. Group ids and boundaries match {@link projectMessages} for the same
 * input; the capture layer re-reads the live surface and returns these texts
 * for paginated `group.read`, or reports stale when ids/boundary no longer
 * match the stored observation.
 *
 * @param {object} input projection input.
 * @param {unknown[]} input.messages rc.5-shaped messages of one authorized surface.
 * @param {unknown} [input.tool_definitions] rc.5 tool schemas of that surface.
 * @param {{redactionPolicyRevision?: string, redactor?: {redactText: Function}}} [input.policy]
 *   redaction policy (must match the policy used for the observation).
 * @param {{maxPreviewChars?: number, maxTextCharsPerGroup?: number, maxGroups?: number}} [input.limits]
 *   optional clamped overrides (must match the observation bounds).
 * @returns {{groups: Map<string, {text: string, characters: number, bytes: number, redaction_count: number}>, truncated: boolean}}
 *   full redacted texts keyed by deterministic group id.
 */
export function collectGroupTexts({ messages, tool_definitions, policy, limits } = {}) {
  const state = runProjection({ messages, tool_definitions, policy, limits });
  const groups = new Map();
  for (const entry of state.entries) {
    const { group } = entry;
    groups.set(group.group_id, {
      text: entry.text,
      characters: group.characters,
      bytes: group.bytes,
      redaction_count: group.redaction_count,
    });
  }
  return { groups, truncated: state.truncated };
}
