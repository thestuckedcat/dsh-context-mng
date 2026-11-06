/**
 * REDACT-1 unit tests.
 *
 * All "secrets" here are synthetic values shaped like real credential formats.
 * No real credential, session, network call or model is involved.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createRedactor } from '../src/redact.mjs';
import { REDACTION_POLICY_REVISION } from '../src/contracts.mjs';

const OPENAI_KEY = 'sk-proj-FAKEfake0123456789abcdefABCDEF';
const GITHUB_TOKEN = 'ghp_FAKEfake0123456789abcdefghij';
const AWS_ACCESS_KEY = 'AKIAFAKEFAKEFAKE1234';
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.FAKEsignatureFAKEsignature';
const BEARER_TOKEN = 'FAKEbearerTOKEN0123456789abcdef';
const PASSWORD_VALUE = 'Synthetic-Passw0rd-42';
const URL_PASSWORD = 'Synthetic%40Pass42';
const PRIVATE_KEY_BODY = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDFAKEfakeKEYfake';
const PRIVATE_KEY_BLOCK = [
  '-----BEGIN PRIVATE KEY-----',
  PRIVATE_KEY_BODY,
  'FAKEfakeKEYfakeFAKEfakeKEYfakeFAKEfakeKEYfakeFAKEfakeKEYfakeAA==',
  '-----END PRIVATE KEY-----',
].join('\n');

const CASES = [
  {
    category: 'api_key',
    label: 'OpenAI-style key',
    text: `Call the synthetic endpoint with ${OPENAI_KEY} as the key.`,
    leaked: [OPENAI_KEY, 'FAKEfake0123456789'],
  },
  {
    category: 'api_key',
    label: 'GitHub token',
    text: `remote=https://${GITHUB_TOKEN}@github.example.test/synthetic/repo.git`,
    leaked: [GITHUB_TOKEN],
  },
  {
    category: 'api_key',
    label: 'AWS access key id',
    text: `aws_access_key_id = ${AWS_ACCESS_KEY}`,
    leaked: [AWS_ACCESS_KEY],
  },
  {
    category: 'jwt',
    label: 'JSON Web Token',
    text: `cookie: session=${JWT}; done`,
    leaked: [JWT, 'FAKEsignatureFAKEsignature'],
  },
  {
    category: 'bearer',
    label: 'Bearer header',
    text: `authorization: Bearer ${BEARER_TOKEN}`,
    leaked: [BEARER_TOKEN],
  },
  {
    category: 'private_key',
    label: 'PEM private key block',
    text: `key material follows\n${PRIVATE_KEY_BLOCK}\nend`,
    leaked: [PRIVATE_KEY_BODY, 'FAKEfakeKEYfakeFAKE', '-----END PRIVATE KEY-----'],
  },
  {
    category: 'password',
    label: 'password assignment',
    text: `Set password = "${PASSWORD_VALUE}" before the synthetic deploy.`,
    leaked: [PASSWORD_VALUE],
  },
  {
    category: 'password',
    label: 'API key assignment',
    text: 'API_KEY=FAKEfake1234567890abcdef',
    leaked: ['FAKEfake1234567890abcdef'],
  },
  {
    category: 'url_password',
    label: 'database URL password',
    text: `DATABASE_URL=postgres://appuser:${URL_PASSWORD}@db.synthetic.test:5432/app`,
    leaked: [URL_PASSWORD],
  },
];

test('factory reports the REDACT-1 policy revision by default', () => {
  const redactor = createRedactor();
  assert.equal(redactor.policyRevision, REDACTION_POLICY_REVISION);
  assert.equal(REDACTION_POLICY_REVISION, 'REDACT-1');
});

test('factory honors an explicit policy revision', () => {
  assert.equal(createRedactor({ policyRevision: 'REDACT-TEST-9' }).policyRevision, 'REDACT-TEST-9');
});

test('factory exposes only redactText and the revision', () => {
  const redactor = createRedactor();
  assert.deepEqual(Object.keys(redactor).sort(), ['policyRevision', 'redactText']);
  assert.equal(typeof redactor.redactText, 'function');
});

test('redacts every registered synthetic secret category', () => {
  const redactor = createRedactor();
  for (const entry of CASES) {
    const result = redactor.redactText(entry.text);
    assert.ok(result.count >= 1, `${entry.label}: expected at least one redaction`);
    assert.ok(result.categories.includes(entry.category), `${entry.label}: expected category ${entry.category}, got ${result.categories.join(',')}`);
    for (const leaked of entry.leaked) {
      assert.ok(!result.text.includes(leaked), `${entry.label}: leaked ${leaked.slice(0, 24)}`);
    }
  }
});

test('placeholder names the category and never keeps the captured value', () => {
  const redactor = createRedactor();
  const result = redactor.redactText(`token ${OPENAI_KEY}`);
  assert.equal(result.text, 'token [REDACTED:api_key]');
  assert.equal(result.count, 1);
});

test('password assignment keeps the key name but removes the value', () => {
  const result = createRedactor().redactText(`password = "${PASSWORD_VALUE}"`);
  assert.ok(result.text.includes('password'));
  assert.ok(!result.text.includes(PASSWORD_VALUE));
  assert.ok(result.text.includes('[REDACTED:password]'));
});

test('counts every occurrence and reports all categories', () => {
  const text = `first ${OPENAI_KEY}\nsecond ${GITHUB_TOKEN}\njwt ${JWT}`;
  const result = createRedactor().redactText(text);
  assert.equal(result.count, 3);
  assert.deepEqual(result.categories, ['api_key', 'jwt']);
  assert.ok(!result.text.includes(OPENAI_KEY));
  assert.ok(!result.text.includes(GITHUB_TOKEN));
  assert.ok(!result.text.includes(JWT));
});

test('ordinary prose is byte-for-byte unchanged', () => {
  const prose = [
    'The password field is documented; Bearer auth is explained, and sk- prefixes are only examples.',
    'Memory injection and system prompt words are ordinary prose here, not provenance.',
    '普通中文段落：这不是密钥，也不是令牌。',
  ].join('\n');
  const result = createRedactor().redactText(prose);
  assert.deepEqual(result, { text: prose, count: 0, categories: [] });
});

test('short lookalike prefixes and bare scheme names stay readable', () => {
  const text = 'Use sk-... placeholders, the Bearer scheme, ghp_ examples and password rules.';
  const result = createRedactor().redactText(text);
  assert.equal(result.text, text);
  assert.equal(result.count, 0);
});

test('redaction is deterministic for the same input', () => {
  const text = `${OPENAI_KEY} and ${JWT} and password = "${PASSWORD_VALUE}"`;
  const first = createRedactor().redactText(text);
  const second = createRedactor().redactText(text);
  assert.deepEqual(first, second);
});

test('redaction is idempotent: a second pass finds nothing', () => {
  const text = CASES.map((entry) => entry.text).join('\n');
  const redactor = createRedactor();
  const once = redactor.redactText(text);
  const twice = redactor.redactText(once.text);
  assert.equal(twice.count, 0);
  assert.deepEqual(twice.categories, []);
  assert.equal(twice.text, once.text);
});

test('empty input yields an empty result', () => {
  assert.deepEqual(createRedactor().redactText(''), { text: '', count: 0, categories: [] });
});

test('redaction never logs the captured text', () => {
  const calls = [];
  const originals = {};
  for (const name of ['log', 'info', 'warn', 'error', 'debug']) {
    originals[name] = console[name];
    console[name] = (...args) => calls.push({ name, args });
  }
  try {
    const redactor = createRedactor();
    const result = redactor.redactText(`password = "${PASSWORD_VALUE}" token=${OPENAI_KEY} jwt=${JWT}`);
    assert.ok(!JSON.stringify(result).includes(PASSWORD_VALUE));
    assert.ok(!JSON.stringify(result).includes(OPENAI_KEY));
  } finally {
    for (const name of Object.keys(originals)) console[name] = originals[name];
  }
  assert.deepEqual(calls, []);
});
