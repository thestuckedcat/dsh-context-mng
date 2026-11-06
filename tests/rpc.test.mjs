/** CTX-RPC-01 boundary: fixed envelopes, caller from peer, no raw error leakage. */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ContractError, responseForReason } from '../src/contracts.mjs';
import { createRpcHandler, callerFromPeer, validateListEnvelope, mapErrorReason } from '../src/rpc.mjs';

const OWNER_PEER = Object.freeze({ id: 'peer-1', principal: Object.freeze({ kind: 'owner' }), signal: Object.freeze({ aborted: false }) });
const NOW = '2026-11-07T00:00:00.000Z';

function baseRequest(overrides = {}) {
  return {
    schema_version: 1,
    operation_id: 'op-1',
    context_ref: 'ctx-a',
    expected_scope_generation: 3,
    view_epoch: 9,
    input: { stage: 'session_surface' },
    ...overrides,
  };
}

function makeHandler(serviceOverrides = {}) {
  const calls = [];
  const service = {
    listContexts({ caller }) {
      calls.push(['listContexts', caller]);
      return { contexts: [{ context_ref: 'ctx-a', session_ref: 'session-a', scope_id: 'project-a', generation: 3, read: true, export_root_refs: ['reports'] }] };
    },
    async getObservation(args) {
      calls.push(['getObservation', args]);
      return { changed: true, observation: { observation_id: 'obs-1', revision: 1 }, current_revision: 1 };
    },
    async getGroupText(args) {
      calls.push(['getGroupText', args]);
      return { text: 'text', next_offset: null, revision: 1 };
    },
    async exportReport(args) {
      calls.push(['exportReport', args]);
      return { status: 'saved', report_ref: 'reports/x.json', digest: 'a'.repeat(64) };
    },
    ...serviceOverrides,
  };
  const handler = createRpcHandler({ service, logger: { warn() {} } });
  return { handler, calls };
}

async function invoke(handler, endpoint, payload, peer = OWNER_PEER, signal = undefined) {
  const result = await handler(endpoint, payload, signal, peer);
  assert.equal(result.ok, true, 'handler must always return an RpcResult');
  assert.equal(typeof result.value, 'object');
  return result;
}

test('observation.get returns a BusinessResponse echoing correlation ids', async () => {
  const { handler, calls } = makeHandler();
  const result = await invoke(handler, 'observation.get', baseRequest());
  assert.equal(result.value.status, 'ok');
  assert.equal(result.value.operation_id, 'op-1');
  assert.equal(result.value.view_epoch, 9);
  assert.equal(result.value.scope_generation, 3);
  assert.equal(result.value.data.changed, true);
  assert.equal(calls[0][0], 'getObservation');
  assert.equal(calls[0][1].caller.kind, 'owner');
  assert.equal(calls[0][1].contextRef, 'ctx-a');
});

test('caller comes from the peer, never from the payload', async () => {
  const { handler, calls } = makeHandler();
  const forged = baseRequest({ caller: { kind: 'owner', grant: 'all' }, principal: { kind: 'owner' } });
  const result = await invoke(handler, 'observation.get', forged);
  assert.equal(result.value.status, 'invalid');
  assert.equal(result.value.reason_code, 'INVALID_REQUEST');
  assert.equal(calls.length, 0);
});

test('non-owner or dead peers are denied and never reach the service', async () => {
  const { handler, calls } = makeHandler();
  const apiPeer = { id: 'p2', principal: { kind: 'api' }, signal: { aborted: false } };
  const denied = await invoke(handler, 'observation.get', baseRequest(), apiPeer);
  assert.equal(denied.value.status, 'denied');
  assert.equal(denied.value.reason_code, 'OWNER_REQUIRED');

  const dead = { id: 'p3', principal: { kind: 'owner' }, signal: { aborted: true } };
  const deadResult = await invoke(handler, 'observation.get', baseRequest(), dead);
  assert.equal(deadResult.value.reason_code, 'OWNER_REQUIRED');
  assert.equal(calls.length, 0);
});

test('context.list uses its own envelope and rejects a forged envelope field', async () => {
  const { handler } = makeHandler();
  const ok = await invoke(handler, 'context.list', { schema_version: 1, operation_id: 'op-list', view_epoch: 4, input: {} });
  assert.equal(ok.value.status, 'ok');
  assert.equal(ok.value.scope_generation, 0);
  assert.equal(ok.value.data.contexts.length, 1);

  const withContextRef = await invoke(handler, 'context.list', {
    schema_version: 1, operation_id: 'op-list', view_epoch: 4, context_ref: 'ctx-a', input: {},
  });
  assert.equal(withContextRef.value.reason_code, 'INVALID_REQUEST');

  const withCaller = await invoke(handler, 'context.list', {
    schema_version: 1, operation_id: 'op-list', view_epoch: 4, input: { caller: { kind: 'owner' } },
  });
  assert.equal(withCaller.value.reason_code, 'INVALID_REQUEST');
});

test('unknown endpoints and malformed inputs are fixed invalid responses', async () => {
  const { handler } = makeHandler();
  const unknown = await invoke(handler, 'maintenance.apply', baseRequest());
  assert.equal(unknown.value.status, 'invalid');
  assert.equal(unknown.value.reason_code, 'UNKNOWN_ENDPOINT');

  const badStage = await invoke(handler, 'observation.get', baseRequest({ input: { stage: 'wire' } }));
  assert.equal(badStage.value.reason_code, 'INVALID_REQUEST');

  const badLimit = await invoke(handler, 'group.read', baseRequest({ input: { observation_id: 'obs-1', group_id: 'g', offset: 0, limit: 999999 } }));
  assert.equal(badLimit.value.reason_code, 'INVALID_REQUEST');

  const missingRevision = await invoke(handler, 'report.export', baseRequest({ input: { observation_id: 'obs-1', output_ref: 'reports' } }));
  assert.equal(missingRevision.value.reason_code, 'INVALID_REQUEST');
});

test('contract errors map to their registered reason code, other errors become INTERNAL_FAILURE', async () => {
  const { handler } = makeHandler({
    async getObservation() {
      throw new ContractError('context is not registered', 'CONTEXT_UNBOUND');
    },
  });
  const mapped = await invoke(handler, 'observation.get', baseRequest());
  assert.equal(mapped.value.status, 'denied');
  assert.equal(mapped.value.reason_code, 'CONTEXT_UNBOUND');

  const secret = 'sk-live-SUPERSECRET-do-not-leak';
  const leaking = makeHandler({
    async getObservation() {
      throw new Error(`handler failure: C:/Users/private/${secret}`);
    },
  });
  const fixed = await invoke(leaking.handler, 'observation.get', baseRequest());
  assert.equal(fixed.value.status, 'failed');
  assert.equal(fixed.value.reason_code, 'INTERNAL_FAILURE');
  const wire = JSON.stringify(fixed);
  assert.equal(wire.includes(secret), false);
  assert.equal(wire.includes('C:/Users/private'), false);
  assert.equal(wire.includes('handler failure'), false);
});

test('oversized requests are refused before parsing', async () => {
  const { handler, calls } = makeHandler();
  const huge = baseRequest({ input: { stage: 'session_surface', pad: 'x'.repeat(70 * 1024) } });
  const result = await invoke(handler, 'observation.get', huge);
  assert.equal(result.value.reason_code, 'LIMIT_EXCEEDED');
  assert.equal(calls.length, 0);
});

test('oversized responses are replaced by a fixed failure, never truncated data', async () => {
  const { handler } = makeHandler({
    async getObservation() {
      return { changed: true, blob: 'y'.repeat(3 * 1024 * 1024), current_revision: 1 };
    },
  });
  const result = await invoke(handler, 'observation.get', baseRequest());
  assert.equal(result.value.reason_code, 'LIMIT_EXCEEDED');
  assert.equal(JSON.stringify(result).length < 4096, true);
});

test('handler never throws even when service is catastrophically broken', async () => {
  const handler = createRpcHandler({
    service: {
      getObservation() { throw new Error('explode'); },
      listContexts() { throw new Error('explode'); },
      getGroupText() { throw new Error('explode'); },
      exportReport() { throw new Error('explode'); },
    },
    logger: { warn() { throw new Error('logger also broken'); } },
  });
  for (const [endpoint, payload] of [
    ['observation.get', baseRequest()],
    ['context.list', { schema_version: 1, operation_id: 'op', view_epoch: 1, input: {} }],
    ['group.read', baseRequest({ input: { observation_id: 'o', group_id: 'g', offset: 0 } })],
    ['report.export', baseRequest({ input: { observation_id: 'o', output_ref: 'reports', expected_revision: 1 } })],
  ]) {
    const result = await handler(endpoint, payload, undefined, OWNER_PEER);
    assert.equal(result.ok, true);
    assert.equal(result.value.status, 'failed');
    assert.equal(result.value.reason_code, 'INTERNAL_FAILURE');
  }
});

test('callerFromPeer rejects malformed peers and mapErrorReason keeps the allow-list', () => {
  assert.throws(() => callerFromPeer(undefined), /owner principal required/);
  assert.throws(() => callerFromPeer({ principal: { kind: 'api' } }), /owner principal required/);
  assert.deepEqual(callerFromPeer(OWNER_PEER), { kind: 'owner', peer_id: 'peer-1' });
  assert.equal(mapErrorReason(new ContractError('x', 'STALE_OBSERVATION')), 'STALE_OBSERVATION');
  assert.equal(mapErrorReason(Object.assign(new Error('x'), { reasonCode: 'EVIL' })), 'INTERNAL_FAILURE');
  assert.equal(mapErrorReason(new Error('x')), 'INTERNAL_FAILURE');
});

test('validateListEnvelope requires the list-shaped envelope only', () => {
  assert.throws(() => validateListEnvelope({ schema_version: 1, operation_id: 'op', view_epoch: 0, input: {}, context_ref: 'x' }), /invalid context.list request/);
  assert.throws(() => validateListEnvelope({ schema_version: 1, operation_id: '', view_epoch: 0, input: {} }), /invalid context.list request/);
  assert.throws(() => validateListEnvelope({ schema_version: 1, operation_id: 'op', view_epoch: -1, input: {} }), /invalid context.list request/);
  const ok = validateListEnvelope({ schema_version: 1, operation_id: 'op', view_epoch: 0, input: {} });
  assert.deepEqual(ok.input, {});
});

test('business failure responses are well-formed and carry no data field', async () => {
  const response = responseForReason({ operationId: 'op-1', viewEpoch: 2, scopeGeneration: 3, reasonCode: 'CONTEXT_UNBOUND' });
  assert.deepEqual(Object.keys(response).sort(), ['operation_id', 'reason_code', 'schema_version', 'scope_generation', 'status', 'view_epoch']);
  assert.equal(response.status, 'denied');
  assert.equal('data' in response, false);
});
