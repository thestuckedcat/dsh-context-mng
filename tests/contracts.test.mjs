/** Strict contract/config tests: fail closed, no implicit grants, wire-size bounds. */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ContractError,
  LIMITS,
  STATUS_FOR_REASON,
  canonicalJson,
  jsonByteLength,
  normalizeConfig,
  okResponse,
  rejectResponse,
  responseForReason,
  validateBusinessResponse,
  validateObservation,
  validateRpcRequest,
  validateReport,
} from '../src/contracts.mjs';
import { boundary, group, observation, registry, report, scopeRef } from './helpers.mjs';

function errorsOf(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ContractError, `expected ContractError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected a ContractError');
}

test('default config is read-only and has an empty registry', () => {
  const config = normalizeConfig(undefined);
  assert.deepEqual(config.maintenance, { enabled: false });
  assert.equal(config.access.registry.bindings.length, 0);
  assert.equal(config.access.registry.export_roots.length, 0);
  assert.equal(config.capture.autoSampleSurface, true);
  assert.equal(config.capture.coalesceWindowMs, 100);
});

test('maintenance cannot be enabled in the read-only first version', () => {
  const error = errorsOf(() => normalizeConfig({ maintenance: { enabled: true } }));
  assert.equal(error.reasonCode, 'INVALID_REQUEST');
  assert.equal(JSON.stringify(error.details).includes('disabled'), true);
});

test('unknown config keys and bad ranges fail closed', () => {
  assert.equal(errorsOf(() => normalizeConfig({ access: { registry: registry(), extra: 1 } })).reasonCode, 'INVALID_REQUEST');
  assert.equal(errorsOf(() => normalizeConfig({ capture: { coalesceWindowMs: 1 } })).reasonCode, 'INVALID_REQUEST');
  assert.equal(errorsOf(() => normalizeConfig({ capture: { maxRefreshHz: 1000 } })).reasonCode, 'INVALID_REQUEST');
  assert.equal(errorsOf(() => normalizeConfig({ capture: { autoSampleSurface: 'yes' } })).reasonCode, 'INVALID_REQUEST');
});

test('an invalid registry prevents plugin activation (no implicit fallback)', () => {
  const invalid = registry();
  invalid.bindings[0].scope.identity_digest = 'not-hex';
  const error = errorsOf(() => normalizeConfig({ access: { registry: invalid } }));
  assert.equal(error.reasonCode, 'INVALID_REQUEST');
});

test('config normalization is a detached copy, not a live reference', () => {
  const input = registry();
  const config = normalizeConfig({ access: { registry: input } });
  input.bindings[0].context_ref = 'mutated-after-load';
  assert.equal(config.access.registry.bindings[0].context_ref, 'ctx-a');
});

test('scope/boundary/observation/report validators accept the fixtures', () => {
  assert.equal(validateObservation(observation()).ok, true);
  assert.equal(validateReport(report()).ok, true);
  const badScope = scopeRef();
  badScope.generation = -1;
  assert.equal(validateObservation(observation({ boundary: boundary({ scope: badScope }) })).ok, false);
  assert.equal(validateObservation(observation({ groups: [group({ category: 'secret' })] })).ok, false);
  assert.equal(validateObservation(observation({ groups: [group({ preview: 'x'.repeat(LIMITS.maxPreviewChars + 1) })] })).ok, false);
  assert.equal(validateObservation(observation({ groups: [group({ estimated_tokens: null })] })).ok, true);
  assert.equal(validateObservation(observation({ wire_verified: true })).ok, false);
});

test('observation rejects unknown extra fields and a wrong schema version', () => {
  const extra = observation();
  extra.hidden_body = 'secret';
  assert.equal(validateObservation(extra).ok, false);
  assert.equal(validateObservation(observation({ schema_version: 2 })).ok, false);
});

test('report validators require the 07 capability and valid nested observation', () => {
  assert.equal(validateReport(report({ capability: '05' })).ok, false);
  assert.equal(validateReport(report({ observation: { schema_version: 1 } })).ok, false);
  assert.equal(validateReport(report({ redaction_policy_revision: '' })).ok, false);
});

test('rpc request envelope is strict', () => {
  const good = {
    schema_version: 1,
    operation_id: 'op-1',
    context_ref: 'ctx-a',
    expected_scope_generation: 3,
    view_epoch: 1,
    input: { stage: 'session_surface' },
  };
  assert.equal(validateRpcRequest(good).ok, true);
  const extra = { ...good, caller: { kind: 'owner' } };
  assert.equal(validateRpcRequest(extra).ok, false);
  assert.equal(validateRpcRequest({ ...good, expected_scope_generation: -1 }).ok, false);
  assert.equal(validateRpcRequest({ ...good, operation_id: '' }).ok, false);
  assert.equal(validateRpcRequest({ ...good, input: null }).ok, false);
});

test('business responses are a closed union', () => {
  const ok = okResponse({ operationId: 'op-1', viewEpoch: 1, scopeGeneration: 3, data: { changed: false } });
  assert.equal(validateBusinessResponse(ok).ok, true);
  assert.equal(validateBusinessResponse({ ...ok, reason_code: 'X' }).ok, false);
  const failure = responseForReason({ operationId: 'op-1', viewEpoch: 1, scopeGeneration: 3, reasonCode: 'CONTEXT_UNBOUND' });
  assert.equal(validateBusinessResponse(failure).ok, true);
  assert.equal(failure.status, 'denied');
  assert.equal(validateBusinessResponse({ ...failure, data: {} }).ok, false);
  assert.equal(validateBusinessResponse(rejectResponse({ operationId: 'op-1', viewEpoch: 1, scopeGeneration: 3, status: 'denied', reasonCode: 'NOT_REGISTERED' })).ok, false);
});

test('all failure reason codes map to a registered business status', () => {
  for (const [reason, status] of Object.entries(STATUS_FOR_REASON)) {
    const response = responseForReason({ operationId: 'op', viewEpoch: 0, scopeGeneration: 0, reasonCode: reason });
    assert.equal(response.reason_code, reason);
    assert.equal(response.status, status);
    assert.equal(validateBusinessResponse(response).ok, true);
  }
});

test('canonical JSON is key-order independent and UTF-8 byte counting is exact', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }), canonicalJson({ a: [2, { c: 3, d: 4 }], b: 1 }));
  assert.equal(jsonByteLength({ a: '中' }), Buffer.byteLength('{"a":"中"}', 'utf8'));
});
