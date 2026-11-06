/**
 * 07 context-mng: REDACT-1 display redaction.
 *
 * The projection never displays or exports raw host content without passing it
 * through this deterministic, dependency-free filter first. REDACT-1 removes
 * recognized credential *values* from display text; it preserves ordinary
 * prose, category-names the replacement as `[REDACTED:<category>]`, and keeps
 * no captured value (not even a readable prefix) in the returned text or in
 * any returned metadata.
 *
 * Recognized shapes (synthetic tests shape, never real credentials):
 *  - PEM private-key blocks (terminated and fail-closed unterminated headers);
 *  - `password`/`token`/`api_key`-style assignments, plain and quoted-key JSON;
 *  - credentials embedded in `scheme://user:password@host` URLs;
 *  - `Bearer` authorization headers;
 *  - JSON Web Tokens (three base64url segments);
 *  - registered provider/key token prefixes (OpenAI, GitHub, Google, AWS,
 *    GitLab, npm, Hugging Face, Slack, Stripe, webhook signing secrets).
 *
 * The filter is display-only: masking here does not and cannot remove content
 * from the session log, the model request or the provider wire. Redaction is
 * idempotent and locale-independent. Nothing in this module logs, throws on
 * content, or touches the network, disk, host or credentials.
 */

import { REDACTION_POLICY_REVISION } from './contracts.mjs';

/** Reviewed list of redaction categories emitted by REDACT-1. */
export const REDACTION_CATEGORIES = Object.freeze([
  'api_key',
  'bearer',
  'jwt',
  'password',
  'private_key',
  'url_password',
]);

/** Keyword list for `name = value` credential assignments. */
const ASSIGNMENT_KEYWORDS =
  '(?:password|passwd|pwd|passphrase|secret|token|apikey|api[-_]?key|access[-_]?token|auth[-_]?token|client[-_]?secret|private[-_]?key)';

/** Value forms after an assignment separator: quoted first, then bare token. */
const ASSIGNMENT_VALUE = '(?:"[^"\\r\\n]{1,512}"|\'[^\'\\r\\n]{1,512}\'|(?!\\[REDACTED:)[^\\s,;}]{1,512})';

/**
 * Ordered REDACT-1 rules. Order matters: private keys and assignments consume
 * whole secret values before narrower token prefixes can match their interior,
 * so one credential is counted once and the placeholder is never re-redacted.
 *
 * @type {ReadonlyArray<{category: string, pattern: RegExp, replacement: string}>}
 */
const RULES = Object.freeze([
  {
    category: 'private_key',
    pattern: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g,
    replacement: '[REDACTED:private_key]',
  },
  {
    // Fail closed for a truncated key header: everything after it is key body.
    category: 'private_key',
    pattern: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*/g,
    replacement: '[REDACTED:private_key]',
  },
  {
    category: 'password',
    pattern: new RegExp(
      `((["'])${ASSIGNMENT_KEYWORDS}\\2)(\\s*[:=]\\s*)${ASSIGNMENT_VALUE}`,
      'gi',
    ),
    replacement: '$1$3[REDACTED:password]',
  },
  {
    category: 'password',
    pattern: new RegExp(
      `((?:${ASSIGNMENT_KEYWORDS})\\b)(\\s*[:=]\\s*)${ASSIGNMENT_VALUE}`,
      'gi',
    ),
    replacement: '$1$2[REDACTED:password]',
  },
  {
    category: 'url_password',
    // Brackets are excluded from both URL parts and the guard keeps the rule
    // idempotent: a redaction placeholder in the password position (which
    // itself contains a colon) is not a credential to redact again.
    pattern: /([A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@[\]]*:)(?!\[REDACTED:)([^/\s@[\]]{1,512})(@)/g,
    replacement: '$1[REDACTED:url_password]$3',
  },
  {
    category: 'bearer',
    pattern: /(\bBearer\s+)([A-Za-z0-9._~+/=-]{16,})/gi,
    replacement: '$1[REDACTED:bearer]',
  },
  {
    category: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replacement: '[REDACTED:jwt]',
  },
  {
    category: 'api_key',
    pattern:
      /(?:sk-[A-Za-z0-9_-]{16,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}|AIza[A-Za-z0-9_-]{30,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|(?:AKIA|ASIA|LTAI|AKID)[A-Z0-9]{12,20}|xox[abprs]-[A-Za-z0-9-]{10,}|whsec_[A-Za-z0-9]{16,})/g,
    replacement: '[REDACTED:api_key]',
  },
]);

/**
 * Count then apply one rule. A rule that matches contributes its category and
 * one count per occurrence.
 *
 * @param {string} text current text.
 * @param {{category: string, pattern: RegExp, replacement: string}} rule rule to apply.
 * @param {Set<string>} categories accumulator for matched categories.
 * @returns {{text: string, count: number}} updated text and occurrence count.
 */
function applyRule(text, rule, categories) {
  rule.pattern.lastIndex = 0;
  const matches = text.match(rule.pattern);
  if (matches === null || matches.length === 0) return { text, count: 0 };
  categories.add(rule.category);
  return { text: text.replace(rule.pattern, rule.replacement), count: matches.length };
}

/**
 * Create the REDACT-1 redactor.
 *
 * The redactor is stateless: `redactText` is deterministic, idempotent, and
 * never logs or retains the captured values. The policy revision is carried
 * into observations/reports so a reader knows which filter shape was applied.
 *
 * @param {{policyRevision?: string}} [options] optional policy revision override.
 * @returns {{policyRevision: string, redactText: (text: unknown) => {text: string, count: number, categories: string[]}}}
 *   frozen redactor interface.
 */
export function createRedactor({ policyRevision = REDACTION_POLICY_REVISION } = {}) {
  const revision =
    typeof policyRevision === 'string' && policyRevision.length >= 1 && policyRevision.length <= 128
      ? policyRevision
      : REDACTION_POLICY_REVISION;

  /**
   * Filter one text value. Non-string input is treated as empty text; content
   * is never logged, thrown on, or echoed in metadata.
   *
   * @param {unknown} text text to filter.
   * @returns {{text: string, count: number, categories: string[]}} filtered
   *   text, number of removed occurrences, sorted matched categories.
   */
  function redactText(text) {
    let output = typeof text === 'string' ? text : '';
    if (output.length === 0) return { text: '', count: 0, categories: [] };
    const categories = new Set();
    let count = 0;
    for (const rule of RULES) {
      const result = applyRule(output, rule, categories);
      output = result.text;
      count += result.count;
    }
    return {
      text: output,
      count,
      categories: [...categories].sort((left, right) => (left === right ? 0 : left < right ? -1 : 1)),
    };
  }

  return Object.freeze({ policyRevision: revision, redactText });
}
