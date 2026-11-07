/** CTX-RPC-03 transport: exact rc.5 Fetch routes with fixed business envelopes. */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createRpcHandler } from '../src/rpc.mjs';
import { LIMITS } from '../src/contracts.mjs';
import { API_BASE, API_ROUTE_PATHS, createContextFetchTransport, readJsonBody } from '../src/transport.mjs';

const OWNER_PEER = Object.freeze({ id: 'peer-1', principal: Object.freeze({ kind: 'owner' }), signal: Object.freeze({ aborted: false }) });
const API_PEER = Object.freeze({ id: 'peer-2', principal: Object.freeze({ kind: 'api' }), signal: Object.freeze({ aborted: false }) });

function fakeService() {
  return {
    calls: [],
    listContexts({ caller }) {
      this.calls.push(['listContexts', caller]);
      return { contexts: [{ context_ref: 'ctx-a', session_ref: 'session-a', scope_id: 'project-a', generation: 3, read: true, export_root_refs: [] }] };
    },
    async getObservation(args) {
      this.calls.push(['getObservation', args]);
      return { changed: false, current_revision: 0 };
    },
    async getGroupText() {
      return { text: '', next_offset: null, revision: 1 };
    },
    async exportReport() {
      return { status: 'conflict' };
    },
  };
}

function fakeConnection() {
  const routes = new Map();
  const disposers = [];
  const fetchService = {
    register(route) {
      routes.set(route.path, route);
      const dispose = () => routes.delete(route.path);
      disposers.push(dispose);
      return dispose;
    },
  };
  return { routes, disposers, fetch: fetchService };
}

function makeTransport(serviceOverrides = {}) {
  const service = { ...fakeService(), ...serviceOverrides };
  const connection = fakeConnection();
  const rpcHandler = createRpcHandler({ service, logger: { warn() {} } });
  const dispose = createContextFetchTransport({ connection, rpcHandler, logger: { warn() {} } });
  return { connection, dispose, service };
}

function request(path, { body = undefined, contentType = 'application/json', method = 'POST' } = {}) {
  const headers = {};
  if (contentType !== null) headers['content-type'] = contentType;
  return new Request(`http://127.0.0.1:1234${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

async function jsonOf(response) {
  assert.equal(response.status, 200);
  return JSON.parse(await response.text());
}

test('registers one exact POST route per business endpoint under /api', () => {
  const { connection } = makeTransport();
  assert.deepEqual([...connection.routes.keys()].sort(), Object.values(API_ROUTE_PATHS).sort());
  for (const route of connection.routes.values()) {
    assert.deepEqual(route.methods, ['POST']);
    // Non-"buffered" is the rc.5 bridge's streaming branch: the Host does not
    // buffer the body, so our bounded reader is the transport-level bound.
    assert.equal(route.requestBody, 'streaming');
    assert.equal(typeof route.fetch, 'function');
    assert.equal(route.path.startsWith(`${API_BASE}/`), true);
  }
});

test('context.list answers with a direct BusinessResponse and owner caller', async () => {
  const { connection, service } = makeTransport();
  const route = connection.routes.get(API_ROUTE_PATHS['context.list']);
  const response = await route.fetch(
    request(API_ROUTE_PATHS['context.list'], { body: { schema_version: 1, operation_id: 'op-list', view_epoch: 4, input: {} } }),
    OWNER_PEER,
  );
  const body = await jsonOf(response);
  assert.equal(body.status, 'ok');
  assert.equal(body.operation_id, 'op-list');
  assert.equal(body.view_epoch, 4);
  assert.equal(body.data.contexts.length, 1);
  assert.equal(service.calls[0][0], 'listContexts');
  assert.equal(service.calls[0][1].kind, 'owner');
});

test('observation.get and unknown endpoints follow the fixed mapping', async () => {
  const { connection } = makeTransport();
  const rpc = connection.routes.get(API_ROUTE_PATHS['observation.get']);
  const envelope = {
    schema_version: 1,
    operation_id: 'op-obs',
    context_ref: 'ctx-a',
    expected_scope_generation: 3,
    view_epoch: 2,
    input: { stage: 'session_surface' },
  };
  const ok = await jsonOf(await rpc.fetch(request(API_ROUTE_PATHS['observation.get'], { body: envelope }), OWNER_PEER));
  assert.equal(ok.status, 'ok');
  assert.equal(ok.data.changed, false);

  // unknown endpoint is not routed at all (Host shared handler 404); the known
  // route still rejects a mismatched envelope shape as invalid.
  const invalid = await jsonOf(await rpc.fetch(request(API_ROUTE_PATHS['observation.get'], { body: { ...envelope, caller: { kind: 'owner' } } }), OWNER_PEER));
  assert.equal(invalid.status, 'invalid');
  assert.equal(invalid.reason_code, 'INVALID_REQUEST');
});

test('rc.5 exact routes pass no peer: the Host owner gate is the recorded caller', async () => {
  const { connection, service } = makeTransport();
  const route = connection.routes.get(API_ROUTE_PATHS['context.list']);
  // Real rc.5 invokes route.fetch(request) without a peer argument.
  const body = await jsonOf(await route.fetch(
    request(API_ROUTE_PATHS['context.list'], { body: { schema_version: 1, operation_id: 'op-gate', view_epoch: 2, input: {} } }),
  ));
  assert.equal(body.status, 'ok');
  assert.equal(body.operation_id, 'op-gate');
  assert.equal(service.calls[0][0], 'listContexts');
  assert.equal(service.calls[0][1].kind, 'owner');
  assert.equal(service.calls[0][1].peer_id, 'host-owner-gate');
});

test('non-owner peers are denied by the peer-derived caller, never granted', async () => {
  const { connection, service } = makeTransport();
  const route = connection.routes.get(API_ROUTE_PATHS['context.list']);
  const body = await jsonOf(await route.fetch(
    request(API_ROUTE_PATHS['context.list'], { body: { schema_version: 1, operation_id: 'op', view_epoch: 0, input: {} } }),
    API_PEER,
  ));
  assert.equal(body.status, 'denied');
  assert.equal(body.reason_code, 'OWNER_REQUIRED');
  assert.equal(service.calls.length, 0);
});

test('wrong content type, malformed JSON and oversized payloads are fixed invalid responses', async () => {
  const { connection } = makeTransport();
  const route = connection.routes.get(API_ROUTE_PATHS['context.list']);
  const wrongType = await jsonOf(await route.fetch(request(API_ROUTE_PATHS['context.list'], { body: '{}', contentType: 'text/plain' }), OWNER_PEER));
  assert.equal(wrongType.reason_code, 'INVALID_REQUEST');

  const malformed = await jsonOf(await route.fetch(request(API_ROUTE_PATHS['context.list'], { body: '{not json' }), OWNER_PEER));
  assert.equal(malformed.reason_code, 'INVALID_REQUEST');

  const huge = await jsonOf(await route.fetch(request(API_ROUTE_PATHS['context.list'], {
    body: { schema_version: 1, operation_id: 'op', view_epoch: 0, input: { pad: 'x'.repeat(70 * 1024) } },
  }), OWNER_PEER));
  assert.equal(huge.reason_code, 'LIMIT_EXCEEDED');
});

test('a throwing rpc handler still yields a fixed internal failure', async () => {
  const connection = fakeConnection();
  const dispose = createContextFetchTransport({
    connection,
    rpcHandler: async () => {
      throw new Error('C:/secret/path');
    },
    logger: { warn() {} },
  });
  const route = connection.routes.get(API_ROUTE_PATHS['context.list']);
  const response = await route.fetch(request(API_ROUTE_PATHS['context.list'], { body: { schema_version: 1, operation_id: 'op', view_epoch: 0, input: {} } }), OWNER_PEER);
  const body = await jsonOf(response);
  assert.equal(body.status, 'failed');
  assert.equal(body.reason_code, 'INTERNAL_FAILURE');
  assert.equal(JSON.stringify(body).includes('secret'), false);
  dispose();
});

test('dispose removes every registered route; registration failures stay contained', async () => {
  const { connection, dispose } = makeTransport();
  assert.equal(connection.routes.size, 4);
  dispose();
  assert.equal(connection.routes.size, 0);

  let warned = 0;
  const failing = {
    fetch: {
      register() {
        throw new Error('route conflict');
      },
    },
  };
  const disposeFailing = createContextFetchTransport({
    connection: failing,
    rpcHandler: createRpcHandler({ service: fakeService() }),
    logger: { warn() { warned += 1; } },
  });
  disposeFailing();
  assert.equal(warned, 4);
});

test('transport never exposes absolute paths in responses', async () => {
  const { connection } = makeTransport({
    async exportReport() {
      return { status: 'conflict' };
    },
  });
  const route = connection.routes.get(API_ROUTE_PATHS['report.export']);
  const body = await jsonOf(await route.fetch(request(API_ROUTE_PATHS['report.export'], {
    body: {
      schema_version: 1,
      operation_id: 'op-export',
      context_ref: 'ctx-a',
      expected_scope_generation: 3,
      view_epoch: 1,
      input: { observation_id: 'obs-1', output_ref: 'reports', expected_revision: 1 },
    },
  }), OWNER_PEER));
  assert.equal(body.status, 'ok');
  assert.equal(body.data.status, 'conflict');
  assert.equal(JSON.stringify(body).includes('C:/'), false);
});

test('streaming route body is read with a hard byte bound before parsing', async () => {
  const { connection, service } = makeTransport();
  const route = connection.routes.get(API_ROUTE_PATHS['context.list']);
  const url = `http://127.0.0.1:1234${API_ROUTE_PATHS['context.list']}`;

  // Chunked body without content-length: parsed normally, service reached.
  const chunks = [
    new TextEncoder().encode('{"schema_version":1,'),
    new TextEncoder().encode('"operation_id":"op-chunk","view_epoch":1,"input":{}}'),
  ];
  const normalStream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const normal = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: normalStream,
    duplex: 'half',
  });
  const okBody = await jsonOf(await route.fetch(normal));
  assert.equal(okBody.status, 'ok');
  assert.equal(okBody.operation_id, 'op-chunk');
  assert.equal(service.calls.length, 1);

  // Declared Content-Length above the limit is refused before any read.
  const declared = await readJsonBody(
    { headers: new Headers({ 'content-length': String(LIMITS.maxRequestJsonBytes + 1) }), body: null },
    LIMITS.maxRequestJsonBytes,
  );
  assert.deepEqual(declared, { ok: false, reasonCode: 'LIMIT_EXCEEDED' });

  // A chunked body above the limit is cut off, cancelled and refused.
  let cancelled = false;
  const oversizedStream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(48 * 1024));
      controller.enqueue(new Uint8Array(48 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const oversized = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: oversizedStream,
    duplex: 'half',
  });
  const oversizedBody = await jsonOf(await route.fetch(oversized));
  assert.equal(oversizedBody.reason_code, 'LIMIT_EXCEEDED');
  assert.equal(cancelled, true, 'over-limit stream must be cancelled');
});

test('malformed content-length and failing body streams are invalid requests', async () => {
  const invalidLength = await readJsonBody(
    { headers: new Headers({ 'content-length': '12abc' }), body: null },
    LIMITS.maxRequestJsonBytes,
  );
  assert.deepEqual(invalidLength, { ok: false, reasonCode: 'INVALID_REQUEST' });

  const brokenStream = new ReadableStream({
    pull() {
      throw new Error('stream failure');
    },
  });
  const broken = await readJsonBody(
    { headers: new Headers({}), body: brokenStream },
    LIMITS.maxRequestJsonBytes,
  );
  assert.deepEqual(broken, { ok: false, reasonCode: 'INVALID_REQUEST' });

  const noBody = await readJsonBody({ headers: new Headers({}), body: null }, LIMITS.maxRequestJsonBytes);
  assert.deepEqual(noBody, { ok: false, reasonCode: 'INVALID_REQUEST' });
});
