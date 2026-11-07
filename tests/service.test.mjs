/** T3 service-layer contract: cached reads, group paging, export idempotency. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ContractError, REDACTION_POLICY_REVISION } from '../src/contracts.mjs';
import { createAccessRegistry } from '../src/access.mjs';
import { createContextService, pageText } from '../src/service.mjs';
import { createReportWriter } from '../src/export.mjs';
import {
  boundary,
  captureDouble,
  fixedClock,
  memoryStore,
  observation,
  registry,
  reportWriterDouble,
  storeEntry,
} from './helpers.mjs';

const OWNER = Object.freeze({ kind: 'owner', peer_id: 'browser' });
const CALLER = { caller: OWNER };
const BASE = {
  ...CALLER,
  contextRef: 'ctx-a',
  expectedScopeGeneration: 3,
};

function makeService(overrides = {}) {
  const access = createAccessRegistry({ registry: overrides.registry ?? registry() });
  const store = overrides.store ?? memoryStore([]);
  const capture = overrides.capture ?? captureDouble();
  const reportWriter = overrides.reportWriter ?? reportWriterDouble();
  const service = createContextService({
    access,
    store,
    capture,
    reportWriter,
    policy: { redactionPolicyRevision: REDACTION_POLICY_REVISION },
    clock: overrides.clock ?? fixedClock(),
  });
  return { service, access, store, capture, reportWriter };
}

async function reasonOf(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ContractError, `expected ContractError, got ${String(error)}`);
    return error.reasonCode;
  }
  assert.fail('expected a ContractError');
}

test('context.list is owner-only and returns only registered contexts', () => {
  const { service } = makeService();
  assert.equal(service.listContexts(CALLER).contexts.length, 1);
  assert.throws(() => service.listContexts({ caller: { kind: 'api' } }), /owner principal required/);
});

test('observation.get returns a cached snapshot and honors after_revision', async () => {
  const entry = storeEntry({ revision: 5 });
  const { service, capture } = makeService({ store: memoryStore([entry]) });
  const first = await service.getObservation({ ...BASE, stage: 'session_surface' });
  assert.equal(first.changed, true);
  assert.equal(first.current_revision, 5);
  assert.equal(capture.calls.length, 0, 'cached observations must not re-sample');

  const polled = await service.getObservation({ ...BASE, stage: 'session_surface', afterRevision: 5 });
  assert.deepEqual(polled, { changed: false, current_revision: 5 });
});

test('observation.get never fabricates request observations', async () => {
  const { service, capture } = makeService();
  const result = await service.getObservation({ ...BASE, stage: 'llm_waterfall' });
  assert.deepEqual(result, { changed: false, current_revision: 0 });
  assert.equal(capture.calls.length, 0);
});

test('observation.get captures the live surface when empty and validates it', async () => {
  const { service, capture } = makeService();
  const result = await service.getObservation({ ...BASE, stage: 'session_surface' });
  assert.equal(result.changed, true);
  assert.equal(result.observation.schema_version, 1);
  assert.equal(capture.calls.length, 1);

  const invalid = captureDouble({ async captureSurface() { return { status: 'ok', observation: { schema_version: 2 } }; } });
  const second = makeService({ capture: invalid });
  assert.equal(await reasonOf(second.service.getObservation({ ...BASE, stage: 'session_surface' })), 'INTERNAL_FAILURE');
});

test('capture denials/unavailable/stale map to registered reasons', async () => {
  const cases = [
    [{ status: 'denied', reasonCode: 'CONTEXT_UNBOUND' }, 'CONTEXT_UNBOUND'],
    [{ status: 'unavailable', reasonCode: 'SESSION_UNAVAILABLE' }, 'SESSION_UNAVAILABLE'],
    [{ status: 'stale', reasonCode: 'STALE_OBSERVATION' }, 'STALE_OBSERVATION'],
  ];
  for (const [captured, expected] of cases) {
    const capture = captureDouble({ async captureSurface() { return captured; } });
    const { service } = makeService({ capture });
    assert.equal(await reasonOf(service.getObservation({ ...BASE, stage: 'session_surface' })), expected);
  }
});

test('group.read rejects foreign observations and unknown groups', async () => {
  const entry = storeEntry();
  const { service } = makeService({ store: memoryStore([entry]) });
  assert.equal(
    await reasonOf(service.getGroupText({ ...BASE, observationId: 'obs-missing', groupId: 'system|system-prompt|', offset: 0 })),
    'STALE_OBSERVATION',
  );
  assert.equal(
    await reasonOf(service.getGroupText({ ...BASE, observationId: 'obs-fixture-1', groupId: 'no-such-group', offset: 0 })),
    'INVALID_REQUEST',
  );

  const foreign = storeEntry({ session_ref: 'session-b' });
  const second = makeService({ store: memoryStore([foreign]) });
  assert.equal(
    await reasonOf(second.service.getGroupText({ ...BASE, observationId: 'obs-fixture-1', groupId: 'system|system-prompt|', offset: 0 })),
    'STALE_OBSERVATION',
  );
});

test('group.read pages redacted text without splitting surrogate pairs', async () => {
  const text = 'A😀B😀C';
  const entry = storeEntry();
  const capture = captureDouble({
    async readGroupTexts() {
      return { status: 'ok', groups: new Map([['system|system-prompt|', { text, characters: text.length, bytes: Buffer.byteLength(text), redaction_count: 0 }]]) };
    },
  });
  const { service } = makeService({ store: memoryStore([entry]), capture });
  const pages = [];
  let offset = 0;
  for (let guard = 0; guard < 10; guard += 1) {
    const page = await service.getGroupText({ ...BASE, observationId: 'obs-fixture-1', groupId: 'system|system-prompt|', offset, limit: 2 });
    pages.push(page.text);
    assert.equal(page.text.includes('\uFFFD'), false);
    // never start a page with a lone low surrogate
    assert.equal(/^\uDC00/.test(page.text), false);
    if (page.next_offset === null) break;
    assert.ok(page.next_offset > offset, 'pagination must make progress');
    offset = page.next_offset;
  }
  assert.equal(pages.join(''), text);
});

test('pageText handles empty text, offsets past the end and surrogate boundaries', () => {
  assert.deepEqual(pageText('', 0, 10), { text: '', next_offset: null });
  assert.deepEqual(pageText('abc', 99, 10), { text: '', next_offset: null });
  // a one-unit window that would split the pair includes the whole pair
  assert.deepEqual(pageText('😀x', 0, 1), { text: '😀', next_offset: 2 });
  assert.deepEqual(pageText('😀x', 0, 2), { text: '😀', next_offset: 2 });
  // offset landing on the low surrogate backs up to the pair start
  assert.deepEqual(pageText('😀x', 1, 2), { text: '😀', next_offset: 2 });
  assert.deepEqual(pageText('x😀', 1, 1), { text: '😀', next_offset: null });
  assert.deepEqual(pageText('A😀B', 0, 2), { text: 'A', next_offset: 1 });
});

test('group.read rejects a surface that changed after the observation', async () => {
  const capture = captureDouble({ async readGroupTexts() { return { status: 'stale', reasonCode: 'STALE_OBSERVATION' }; } });
  const { service } = makeService({ store: memoryStore([storeEntry()]), capture });
  assert.equal(
    await reasonOf(service.getGroupText({ ...BASE, observationId: 'obs-fixture-1', groupId: 'system|system-prompt|', offset: 0 })),
    'STALE_OBSERVATION',
  );
});

test('export requires the registered root, unchanged revision, and validated report', async () => {
  const entry = storeEntry({ revision: 2, observation: observation({ revision: 2 }) });
  const { service, reportWriter } = makeService({ store: memoryStore([entry]) });
  const result = await service.exportReport({ ...BASE, observationId: 'obs-fixture-1', outputRef: 'reports', expectedRevision: 2 });
  assert.equal(result.status, 'saved');
  assert.equal(reportWriter.calls.length, 1);
  const written = reportWriter.calls[0];
  assert.equal(written.rootPath, 'C:/Users/synthetic/context-reports');
  assert.equal(written.report.capability, '07');
  assert.equal(written.report.redaction_policy_revision, REDACTION_POLICY_REVISION);
  assert.equal(written.report.exported_at, '2026-11-07T00:00:00.000Z');
  assert.equal(written.report.observation.observation_id, 'obs-fixture-1');

  assert.equal(
    await reasonOf(service.exportReport({ ...BASE, observationId: 'obs-fixture-1', outputRef: 'reports', expectedRevision: 1 })),
    'STALE_OBSERVATION',
  );
  assert.equal(
    await reasonOf(service.exportReport({ ...BASE, observationId: 'obs-fixture-1', outputRef: 'other', expectedRevision: 2 })),
    'OUTPUT_REF_DENIED',
  );
});

test('export conflict and write failure are surfaced without raw errors', async () => {
  const entry = storeEntry({ revision: 2, observation: observation({ revision: 2 }) });
  const conflict = makeService({
    store: memoryStore([entry]),
    reportWriter: reportWriterDouble({ async writeReport() { return { status: 'conflict' }; } }),
  });
  const result = await conflict.service.exportReport({ ...BASE, observationId: 'obs-fixture-1', outputRef: 'reports', expectedRevision: 2 });
  assert.deepEqual(result, { status: 'conflict' });

  const failing = makeService({
    store: memoryStore([entry]),
    reportWriter: reportWriterDouble({ async writeReport() { throw new Error('C:/secret/path'); } }),
  });
  const error = await failing.service.exportReport({ ...BASE, observationId: 'obs-fixture-1', outputRef: 'reports', expectedRevision: 2 }).catch((caught) => caught);
  assert.equal(error.reasonCode ?? 'INTERNAL_FAILURE', 'INTERNAL_FAILURE');
});

test('disposed service refuses requests', async () => {
  const { service } = makeService();
  service.dispose();
  assert.equal(await reasonOf(service.getObservation({ ...BASE, stage: 'session_surface' })), 'INTERNAL_FAILURE');
});

test('service describe exposes registry/cache/policy facts only', () => {
  const { service } = makeService();
  const described = service.describe();
  assert.equal(described.registry.digest.length, 64);
  assert.equal(described.registry.bindings, 1);
  assert.equal(described.policy.redactionPolicyRevision, REDACTION_POLICY_REVISION);
  assert.equal(JSON.stringify(described).includes('C:/Users/synthetic'), false);
});

test('repeat export of one observation revision is byte-identical and saved (no conflict)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ctxmng-export-idem-'));
  try {
    const entry = storeEntry({ revision: 2, observation: observation({ revision: 2 }) });
    const syntheticRegistry = registry({
      export_roots: [{ root_ref: 'reports', path: root }],
      bindings: [{
        context_ref: 'ctx-a',
        session_ref: 'session-a',
        scope: { scope_id: 'project-a', generation: 3, identity_digest: 'a'.repeat(64) },
        read: true,
        export_root_refs: ['reports'],
        active: true,
      }],
    });
    // Two different wall-clock instants: the report must still be byte-identical.
    let tick = 0;
    const service = makeService({
      store: memoryStore([entry]),
      registry: syntheticRegistry,
      reportWriter: createReportWriter({ clock: () => new Date(1700000000000 + tick++) }),
    }).service;
    const first = await service.exportReport({ ...BASE, observationId: 'obs-fixture-1', outputRef: 'reports', expectedRevision: 2 });
    const second = await service.exportReport({ ...BASE, observationId: 'obs-fixture-1', outputRef: 'reports', expectedRevision: 2 });
    assert.equal(first.status, 'saved');
    assert.equal(second.status, 'saved', 'a retry must not surface EXPORT_CONFLICT');
    assert.equal(first.report_ref, second.report_ref);
    assert.equal(first.digest, second.digest);
    const names = readdirSync(root);
    assert.equal(names.length, 1, 'idempotent retry must not create a second file');
    const written = JSON.parse(readFileSync(join(root, names[0]), 'utf8'));
    assert.match(written.report_id, /^ctx-report-[0-9a-f]+-r2$/);
    assert.equal(written.report_id + '.json', second.report_ref);
    assert.equal(written.exported_at, entry.observation.captured_at, 'exported_at is the immutable observation time');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
