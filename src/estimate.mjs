/**
 * 07 context-mng: deterministic UTF-8 byte estimate (`utf8_bytes_estimate_v1`).
 *
 * v1 deliberately does not tokenize. It uses the UTF-8 byte length of the
 * already-redacted display text as a conservative, replaceable count and always
 * labels it "UTF-8 byte estimate". It is not a mathematical bound for any
 * tokenizer, is never presented as provider billing, and is never mixed with
 * provider-reported usage. Unknown modalities (images, files, unknown blocks)
 * stay unknown: their counts are `null` and are listed in `unpriced_modalities`,
 * never priced from unrelated text.
 *
 * `characters` is the JavaScript string length (UTF-16 code units), the same
 * offset unit used by the group pagination (`group.read`) contract.
 */

import { ESTIMATE_METHOD as CONTRACT_ESTIMATE_METHOD } from './contracts.mjs';

/** Frozen estimate method name shared with the wire contract. */
export const ESTIMATE_METHOD = CONTRACT_ESTIMATE_METHOD;

/**
 * UTF-8 byte length of a value. Non-string values are stringified defensively;
 * `null`/`undefined` count as the empty string.
 *
 * @param {unknown} text value to measure.
 * @returns {number} UTF-8 byte length.
 */
export function utf8Bytes(text) {
  if (typeof text !== 'string') return 0;
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Price one group's display text with the byte estimate.
 *
 * @param {string} text redacted group text.
 * @returns {{method: string, tokens: number, characters: number}} method,
 *   conservative byte count and UTF-16 character count.
 */
export function estimateGroupText(text) {
  const value = typeof text === 'string' ? text : '';
  return {
    method: ESTIMATE_METHOD,
    tokens: utf8Bytes(value),
    characters: value.length,
  };
}

/**
 * Combine per-part estimates into one contract-valid estimate.
 *
 * A part is `{tokens, truncated, unpriced_modalities}` where `tokens` is the
 * known text byte count or `null` when the part contains an unpriced modality.
 * The combined `tokens` is only a number when every part is priced; otherwise
 * it is `null` and `complete` is false. Unpriced modality names are unioned
 * and sorted so the result is deterministic.
 *
 * @param {Array<{tokens: number|null, truncated?: boolean, unpriced_modalities?: string[]}>} parts
 *   per-group estimates.
 * @returns {{method: string, tokenizer_ref: null, tokens: number|null, complete: boolean, unpriced_modalities: string[]}}
 *   contract-valid estimate object.
 */
export function combineEstimates(parts = []) {
  const list = Array.isArray(parts) ? parts : [];
  let tokens = 0;
  let complete = true;
  const modalities = new Set();
  for (const part of list) {
    if (part === null || typeof part !== 'object') {
      tokens = null;
      complete = false;
      continue;
    }
    if (part.tokens === null || part.tokens === undefined || !Number.isSafeInteger(part.tokens) || part.tokens < 0) {
      tokens = null;
      complete = false;
    } else if (tokens !== null) {
      tokens += part.tokens;
    }
    if (part.truncated === true) complete = false;
    for (const modality of part.unpriced_modalities ?? []) {
      if (typeof modality === 'string' && modality.length > 0) modalities.add(modality);
    }
  }
  const unpriced = [...modalities].sort(compareStrings);
  if (unpriced.length > 0) {
    // An unknown modality makes the aggregate count unknown, not a text-only
    // number that silently understates the context.
    tokens = null;
    complete = false;
  }
  return {
    method: ESTIMATE_METHOD,
    tokenizer_ref: null,
    tokens,
    complete,
    unpriced_modalities: unpriced,
  };
}

/**
 * Locale-independent deterministic string ordering.
 *
 * @param {string} left first value.
 * @param {string} right second value.
 * @returns {number} negative, zero or positive like a comparator.
 */
function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
