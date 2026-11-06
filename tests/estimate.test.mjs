/**
 * UTF-8 byte estimate tests (`utf8_bytes_estimate_v1`).
 *
 * The estimate is a conservative display count, not a tokenizer: tokens equal
 * the UTF-8 byte length of the redacted text. No network or model is used.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ESTIMATE_METHOD,
  combineEstimates,
  estimateGroupText,
  utf8Bytes,
} from '../src/estimate.mjs';
import { ESTIMATE_METHOD as CONTRACT_METHOD, validateEstimate } from '../src/contracts.mjs';

test('exported method matches the frozen contract method', () => {
  assert.equal(ESTIMATE_METHOD, 'utf8_bytes_estimate_v1');
  assert.equal(ESTIMATE_METHOD, CONTRACT_METHOD);
});

test('utf8Bytes counts UTF-8 bytes, not UTF-16 code units', () => {
  assert.equal(utf8Bytes(''), 0);
  assert.equal(utf8Bytes('abc'), 3);
  assert.equal(utf8Bytes('中文'), 6);
  assert.equal(utf8Bytes('a😀'), 5);
  assert.equal(utf8Bytes(String('x'.repeat(1024))), 1024);
});

test('estimateGroupText returns method, byte tokens and characters', () => {
  assert.deepEqual(estimateGroupText('hello'), {
    method: 'utf8_bytes_estimate_v1',
    tokens: 5,
    characters: 5,
  });
  assert.deepEqual(estimateGroupText('中文'), {
    method: 'utf8_bytes_estimate_v1',
    tokens: 6,
    characters: 2,
  });
  assert.deepEqual(estimateGroupText(''), {
    method: 'utf8_bytes_estimate_v1',
    tokens: 0,
    characters: 0,
  });
});

test('estimateGroupText tokens always equal utf8Bytes of the same text', () => {
  for (const sample of ['plain', 'multi\nline', '中文段落', 'emoji 😀🎯', '']) {
    assert.equal(estimateGroupText(sample).tokens, utf8Bytes(sample));
  }
});

test('combineEstimates of no parts is a complete zero estimate', () => {
  const combined = combineEstimates([]);
  assert.deepEqual(combined, {
    method: 'utf8_bytes_estimate_v1',
    tokenizer_ref: null,
    tokens: 0,
    complete: true,
    unpriced_modalities: [],
  });
  assert.equal(validateEstimate(combined).ok, true);
});

test('combineEstimates sums priced parts and stays complete', () => {
  const combined = combineEstimates([
    { tokens: 10, truncated: false, unpriced_modalities: [] },
    { tokens: 5, truncated: false, unpriced_modalities: [] },
  ]);
  assert.equal(combined.tokens, 15);
  assert.equal(combined.complete, true);
  assert.deepEqual(combined.unpriced_modalities, []);
  assert.equal(validateEstimate(combined).ok, true);
});

test('an unknown (null) part forces an unknown total and incomplete estimate', () => {
  const combined = combineEstimates([
    { tokens: 10, truncated: false, unpriced_modalities: [] },
    { tokens: null, truncated: false, unpriced_modalities: ['image'] },
  ]);
  assert.equal(combined.tokens, null);
  assert.equal(combined.complete, false);
  assert.deepEqual(combined.unpriced_modalities, ['image']);
  assert.equal(validateEstimate(combined).ok, true);
});

test('unpriced modalities are unioned and sorted deterministically', () => {
  const combined = combineEstimates([
    { tokens: null, truncated: false, unpriced_modalities: ['image'] },
    { tokens: null, truncated: false, unpriced_modalities: ['file', 'image'] },
  ]);
  assert.deepEqual(combined.unpriced_modalities, ['file', 'image']);
});

test('a truncated part keeps its known count but flags the estimate incomplete', () => {
  const combined = combineEstimates([{ tokens: 40, truncated: true, unpriced_modalities: [] }]);
  assert.equal(combined.tokens, 40);
  assert.equal(combined.complete, false);
  assert.equal(validateEstimate(combined).ok, true);
});

test('combineEstimates output always validates', () => {
  const samples = [
    [],
    [{ tokens: 0, truncated: false, unpriced_modalities: [] }],
    [{ tokens: null, truncated: true, unpriced_modalities: ['image', 'file'] }],
  ];
  for (const parts of samples) assert.equal(validateEstimate(combineEstimates(parts)).ok, true);
});
