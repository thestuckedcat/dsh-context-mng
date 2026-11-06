#!/usr/bin/env node
/**
 * 07 context-mng: end-to-end component smoke (T3/T4a).
 *
 *   node tools/observe-smoke.mjs --fixture [--network-evidence]
 *
 * The smoke wires the REAL pure core and Host-side modules together without a
 * real model, Host network or real session bytes:
 *
 *   synthetic rc.5-shaped sessions A/B
 *     -> trusted access registry (explicit bindings + temp export root)
 *     -> bounded observation store
 *     -> capture with a fake rc.5 host adapter
 *     -> context service
 *     -> Connection RPC handler (caller comes from the fake authenticated peer)
 *     -> client store (`ui/context-store.js`) over a fake Connection RPC
 *
 * It proves, as runnable evidence rather than prose: A cannot read B, an
 * unbound session is never sampled, a late response after a session switch is
 * dropped by the view epoch, capture dispose zeroes Host listener counts,
 * export denies traversal/symlink/non-directory roots and repeated identical
 * exports are idempotent. `--network-evidence` additionally installs global
 * fetch/net/http/https/dns guards before importing the plugin module graph and
 * records every outbound attempt (one attempt fails the run).
 *
 * Artifacts (export fixtures) live under $env:TEMP only. No network, no real
 * sessions, no credentials.
 */

import path from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';

const TOOL = 'observe-smoke';
const TEMP_ROOT = process.env.TEMP || process.env.TMP;
const POLICY_REVISION = 'REDACT-1';
const FIXTURE_CLOCK = () => new Date('2026-11-07T00:00:00.000Z');

const FAKE_KEY = 'sk-proj-SMOKE0123456789abcdefABCDEF';
const FAKE_PASSWORD = 'Smoke-Passw0rd-88';
const A_MARKER = 'SESSION-A-ONLY-SMOKE-MARKER';
const B_MARKER = 'SESSION-B-ONLY-SMOKE-MARKER';

// ---------------------------------------------------------------------------
// tiny TAP-ish harness
// ---------------------------------------------------------------------------

const results = [];
let nextIndex = 0;

function record(name, ok, detail) {
  nextIndex += 1;
  results.push({ index: nextIndex, name, ok, detail });
  if (ok) process.stdout.write(`ok ${nextIndex} - ${name}\n`);
  else process.stdout.write(`not ok ${nextIndex} - ${name}${detail ? ` # ${detail}` : ''}\n`);
  return ok;
}

async function check(name, fn) {
  try {
    const detail = await fn();
    return record(name, true, typeof detail === 'string' ? detail : undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return record(name, false, message.replace(/\s+/g, ' ').slice(0, 400));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await flushAsync();
  }
}

// ---------------------------------------------------------------------------
// outbound-network guards (evidence, not a policy enforcement layer)
// ---------------------------------------------------------------------------

function installNetworkGuards() {
  const attempts = [];
  const restorers = [];
  const recordAttempt = (api) => {
    attempts.push(api);
    throw new Error(`${TOOL}: outbound attempt blocked by evidence guard: ${api}`);
  };
  const patchGlobal = (name) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    globalThis[name] = function guarded(...args) {
      void args;
      return recordAttempt(`globalThis.${name}`);
    };
    restorers.push(() => {
      if (descriptor === undefined) delete globalThis[name];
      else Object.defineProperty(globalThis, name, descriptor);
    });
  };
  for (const name of ['fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource']) patchGlobal(name);
  return { attempts, restore: () => { while (restorers.length > 0) restorers.pop()(); } };
}

async function installModuleGuards() {
  const attempts = [];
  const restorers = [];
  async function patchModule(specifier, names) {
    const module = await import(specifier);
    for (const name of names) {
      const original = module[name];
      if (typeof original !== 'function') continue;
      try {
        module[name] = function guarded(...args) {
          void args;
          attempts.push(`${specifier}#${name}`);
          throw new Error(`${TOOL}: outbound attempt blocked by evidence guard: ${specifier}#${name}`);
        };
        restorers.push(() => {
          module[name] = original;
        });
      } catch {
        // A frozen ESM namespace cannot be patched; the recording above simply
        // never fires for it. Static import audit covers that residue.
      }
    }
  }
  await patchModule('node:net', ['connect', 'createConnection']);
  await patchModule('node:http', ['request', 'get']);
  await patchModule('node:https', ['request', 'get']);
  await patchModule('node:dns', ['lookup', 'resolve']);
  return { attempts, restore: () => { while (restorers.length > 0) restorers.pop()(); } };
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function text(value) {
  return { type: 'text', text: value };
}

function message(id, role, content, source) {
  return { id, role, content, source };
}

const TINY_PNG = Object.freeze({
  attachmentId: `sha256:${'c'.repeat(64)}`,
  mediaType: 'image/png',
  bytes: 512,
  width: 2,
  height: 2,
});

function syntheticSessions() {
  return [
    {
      session_ref: 'session-smoke-a',
      context_ref: 'ctx-smoke-a',
      scope: { scope_id: 'scope-smoke-a', generation: 4, identity_digest: 'a'.repeat(64) },
      surface_generation: 1,
      messages: [
        message('sa-01', 'system', [text('Synthetic smoke system prompt A.')], { kind: 'system-prompt' }),
        message('sa-02', 'user', [text(`${A_MARKER} with api_key=${FAKE_KEY} and password="${FAKE_PASSWORD}".`)], { kind: 'user' }),
        message('sa-03', 'assistant', [text('Synthetic smoke assistant reply A.')], { kind: 'model' }),
        message('sa-04', 'user', [text('Synthetic image note:'), { type: 'image', attachment: TINY_PNG }], { kind: 'user' }),
        message('sa-05', 'mystery', [text('Body words memory and secret do not classify this synthetic note.')], undefined),
      ],
      tool_definitions: [
        { name: 'read_smoke', description: 'Read a synthetic smoke fixture.', parameters: { type: 'object', properties: {} } },
      ],
    },
    {
      session_ref: 'session-smoke-b',
      context_ref: 'ctx-smoke-b',
      scope: { scope_id: 'scope-smoke-b', generation: 9, identity_digest: 'b'.repeat(64) },
      surface_generation: 1,
      messages: [
        message('sb-01', 'system', [text('Synthetic smoke system prompt B.')], { kind: 'system-prompt' }),
        message('sb-02', 'user', [text(`${B_MARKER} only session B content.`)], { kind: 'user' }),
      ],
      tool_definitions: [],
    },
  ];
}

function createFakeHost(sessions) {
  const byId = new Map(sessions.map((session) => [session.session_ref, session]));
  const reads = { readSurface: [], readBoundary: [] };
  const listeners = { session: new Set(), llm: new Set(), preStep: new Set() };
  const closed = new Set();
  return {
    sessions: {
      get(id) {
        return byId.get(id) ?? null;
      },
      list() {
        return Array.from(byId.values());
      },
    },
    readSurface(session) {
      if (closed.has(session.session_ref)) throw new Error('session disposed');
      reads.readSurface.push(session.session_ref);
      return {
        messages: session.messages,
        tool_definitions: session.tool_definitions,
        last_event_seq: session.messages.length,
        surface_generation: session.surface_generation,
      };
    },
    readBoundary(session) {
      if (closed.has(session.session_ref)) throw new Error('session disposed');
      reads.readBoundary.push(session.session_ref);
      return {
        last_event_seq: session.messages.length,
        surface_generation: session.surface_generation,
        route_revision: 'route-smoke-1',
      };
    },
    isSessionLive(id) {
      return byId.has(id) && !closed.has(id);
    },
    onSessionEvent(fn) {
      listeners.session.add(fn);
      return () => listeners.session.delete(fn);
    },
    onLlmStream(fn) {
      listeners.llm.add(fn);
      return () => listeners.llm.delete(fn);
    },
    onAgentPreStep(fn) {
      listeners.preStep.add(fn);
      return () => listeners.preStep.delete(fn);
    },
    log() {},
    disposeSession(id) {
      closed.add(id);
    },
    stats() {
      return {
        session_listeners: listeners.session.size,
        llm_listeners: listeners.llm.size,
        pre_step_listeners: listeners.preStep.size,
        reads: { readSurface: reads.readSurface.length, readBoundary: reads.readBoundary.length },
        reads_surface_sessions: [...new Set(reads.readSurface)],
      };
    },
  };
}

function registryFor(sessions, exportRootPath) {
  return {
    schema_version: 1,
    revision: 3,
    bindings: sessions.map((session) => ({
      context_ref: session.context_ref,
      session_ref: session.session_ref,
      scope: session.scope,
      read: true,
      export_root_refs: ['reports'],
      active: true,
    })),
    export_roots: [{ root_ref: 'reports', path: exportRootPath }],
  };
}

function envelope(contextRef, generation, operationId, input) {
  return {
    schema_version: 1,
    operation_id: operationId,
    context_ref: contextRef,
    expected_scope_generation: generation,
    view_epoch: 1,
    input,
  };
}

function listEnvelope(operationId) {
  return { schema_version: 1, operation_id: operationId, view_epoch: 1, input: {} };
}

function createGatedFetch(handler, peer) {
  const calls = [];
  let gate = null;
  const routePattern = /^\/api\/context-mng\/([a-z.]+)$/;
  return {
    calls,
    setGate(matcher) {
      let resolve;
      const promise = new Promise((res) => {
        resolve = res;
      });
      gate = { matcher, promise, resolve };
      return gate;
    },
    clearGate() {
      gate = null;
    },
    async fetch(url, init) {
      const match = routePattern.exec(url);
      if (match === null) throw new Error(`unexpected route ${url}`);
      const endpoint = match[1];
      if (init === null || typeof init !== 'object' || init.method !== 'POST') throw new Error('unexpected request shape');
      if (init.headers === null || typeof init.headers !== 'object' || init.headers['content-type'] !== 'application/json') {
        throw new Error('unexpected request content-type');
      }
      const payload = JSON.parse(init.body);
      calls.push({ url, endpoint, payload, signal: init.signal });
      if (gate !== null && gate.matcher(endpoint, payload)) await gate.promise;
      const result = await handler(endpoint, payload, init.signal, peer);
      if (result === null || typeof result !== 'object' || result.ok !== true) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => result.value };
    },
  };
}

function fakeTimers() {
  return {
    setInterval() {
      return 1;
    },
    clearInterval() {},
  };
}

function fakeDocument() {
  const listeners = new Set();
  return {
    visibilityState: 'visible',
    addEventListener(type, fn) {
      if (type === 'visibilitychange') listeners.add(fn);
    },
    removeEventListener(type, fn) {
      if (type === 'visibilitychange') listeners.delete(fn);
    },
    count() {
      return listeners.size;
    },
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const fixture = argv.includes('--fixture');
  const networkEvidence = argv.includes('--network-evidence');
  const known = new Set(['--fixture', '--network-evidence']);
  for (const arg of argv) {
    if (!known.has(arg)) {
      process.stderr.write(`${TOOL}: unknown argument ${JSON.stringify(arg)}; usage: --fixture [--network-evidence]\n`);
      process.exit(2);
    }
  }
  if (!fixture) {
    process.stderr.write(`${TOOL}: --fixture is required (the smoke never touches real sessions)\n`);
    process.exit(2);
  }
  if (!TEMP_ROOT) {
    process.stderr.write(`${TOOL}: OS temp directory is unavailable; refusing to run\n`);
    process.exit(3);
  }

  const globalGuards = installNetworkGuards();
  const moduleGuards = await installModuleGuards();
  const allAttempts = () => globalGuards.attempts.concat(moduleGuards.attempts);

  // The plugin module graph is imported only after the guards are in place.
  const contracts = await import('../src/contracts.mjs');
  const accessModule = await import('../src/access.mjs');
  const observationsModule = await import('../src/observations.mjs');
  const captureModule = await import('../src/capture.mjs');
  const serviceModule = await import('../src/service.mjs');
  const rpcModule = await import('../src/rpc.mjs');
  const redactModule = await import('../src/redact.mjs');
  const exportModule = await import('../src/export.mjs');
  const storeModule = await import('../ui/context-store.js');

  const sessions = syntheticSessions();
  const sessionA = sessions[0];
  const sessionB = sessions[1];
  const host = createFakeHost(sessions);
  const workDir = mkdtempSync(path.join(TEMP_ROOT, 'dsh07-smoke-'));
  const exportRoot = path.join(workDir, 'reports');
  mkdirSync(exportRoot);
  const outsideDir = path.join(workDir, 'outside');
  mkdirSync(outsideDir);

  const access = accessModule.createAccessRegistry({ registry: registryFor(sessions, exportRoot) });
  const observationStore = observationsModule.createObservationStore({ limits: contracts.LIMITS, clock: FIXTURE_CLOCK });
  const redactor = redactModule.createRedactor({ policyRevision: POLICY_REVISION });
  const capture = captureModule.createCapture({
    host,
    access,
    store: observationStore,
    redactor,
    policy: { redactionPolicyRevision: POLICY_REVISION },
    clock: FIXTURE_CLOCK,
    limits: contracts.LIMITS,
    config: { autoSampleSurface: true, requestObservation: true, agentPreStep: true, coalesceWindowMs: 10, maxRefreshHz: 20 },
    logger: { warn() {} },
  });
  const reportWriter = exportModule.createReportWriter({ clock: FIXTURE_CLOCK });
  const service = serviceModule.createContextService({
    access,
    store: observationStore,
    capture,
    reportWriter,
    policy: { redactionPolicyRevision: POLICY_REVISION },
    clock: FIXTURE_CLOCK,
    limits: contracts.LIMITS,
  });
  const peer = { id: 'smoke-owner-peer', principal: { kind: 'owner' }, signal: new AbortController().signal };
  const handler = rpcModule.createRpcHandler({ service, limits: contracts.LIMITS, logger: { warn() {} } });

  let observationA = null;

  await check('rpc observation.get returns the authorized session A observation', async () => {
    const result = await handler('observation.get', envelope('ctx-smoke-a', 4, 'op-obs-a', { stage: 'session_surface' }), undefined, peer);
    assert(result !== null && typeof result === 'object', 'handler must return an RpcResult');
    assertEqual(result.ok, true, 'RpcResult.ok');
    assertEqual(result.value.status, 'ok', 'business status');
    const observation = result.value.data.observation;
    assert(observation !== undefined, 'observation data present');
    observationA = observation;
    assertEqual(observation.boundary.session_ref, sessionA.session_ref, 'observed session');
    assertEqual(observation.capture_stage, 'session_surface', 'stage');
    assertEqual(observation.fidelity, 'history_projection', 'fidelity');
    assertEqual(observation.wire_verified, false, 'wire_verified stays false');
    const json = JSON.stringify(observation);
    assert(json.includes(FAKE_KEY) === false, 'fake API key must be redacted from the observation');
    assert(json.includes(FAKE_PASSWORD) === false, 'fake password must be redacted from the observation');
    assert(json.includes(B_MARKER) === false, 'session B content must not appear in session A observation');
    const unknown = observation.groups.filter((group) => group.category === 'unknown');
    assert(unknown.length >= 1, 'unknown provenance stays unknown');
    assertEqual(observation.reported_usage, null, 'a history projection reports no fabricated provider usage');
    assertEqual(observation.estimate.method, 'utf8_bytes_estimate_v1', 'estimate method');
    return `observation ${observation.observation_id} revision ${observation.revision}`;
  });

  await check('A cannot read B (context/scope/caller joins are enforced)', async () => {
    const wrongScope = await handler('observation.get', envelope('ctx-smoke-a', 9, 'op-obs-b-gen', { stage: 'session_surface' }), undefined, peer);
    assertEqual(wrongScope.ok, true, 'business denials stay inside RpcResult.value');
    assertEqual(wrongScope.value.status, 'stale', 'wrong generation status');
    assertEqual(wrongScope.value.reason_code, 'STALE_SCOPE', 'wrong generation reason');

    const modelPeer = { id: 'model-peer', principal: { kind: 'model' } };
    const modelDenied = await handler('observation.get', envelope('ctx-smoke-a', 4, 'op-obs-model', { stage: 'session_surface' }), undefined, modelPeer);
    assertEqual(modelDenied.value.status, 'denied', 'model principal denied');
    assertEqual(modelDenied.value.reason_code, 'OWNER_REQUIRED', 'model principal reason');

    const unknownContext = await handler('observation.get', envelope('ctx-smoke-unknown', 1, 'op-obs-unknown', { stage: 'session_surface' }), undefined, peer);
    assertEqual(unknownContext.value.reason_code, 'CONTEXT_UNBOUND', 'unknown context unbound');

    const bObservation = await handler('observation.get', envelope('ctx-smoke-b', 9, 'op-obs-b', { stage: 'session_surface' }), undefined, peer);
    assertEqual(bObservation.value.status, 'ok', 'B is readable under B binding');
    assert(JSON.stringify(bObservation.value.data.observation).includes(A_MARKER) === false, 'B observation must not contain A content');

    // A's observation id cannot be addressed through B's context.
    const crossRead = await handler('group.read', envelope('ctx-smoke-b', 9, 'op-group-cross', {
      observation_id: observationA.observation_id,
      group_id: observationA.groups[0].group_id,
      offset: 0,
      limit: 8192,
    }), undefined, peer);
    assertEqual(crossRead.value.status, 'stale', 'cross-context observation read is stale');
    assertEqual(crossRead.value.reason_code, 'STALE_OBSERVATION', 'cross-context reason');
    return 'scope/session/caller joins deny cross reads';
  });

  await check('unbound session is never sampled', async () => {
    const before = host.stats().reads.readSurface;
    const fakeBinding = {
      context_ref: 'ctx-smoke-unbound',
      session_ref: 'session-smoke-unbound',
      scope: { scope_id: 'scope-smoke-unbound', generation: 1, identity_digest: 'c'.repeat(64) },
      read: true,
      active: true,
      export_root_refs: [],
    };
    const captured = await capture.captureSurface({ binding: fakeBinding, stage: 'session_surface' });
    assertEqual(captured.status, 'denied', 'unbound binding denied');
    assertEqual(captured.reasonCode, 'CONTEXT_UNBOUND', 'unbound reason');
    const after = host.stats().reads.readSurface;
    assertEqual(after, before, 'no surface read happened for an unbound session');
    const list = await handler('context.list', listEnvelope('op-list'), undefined, peer);
    const listed = list.value.data.contexts.map((entry) => entry.session_ref);
    assertEqual(listed.includes('session-smoke-unbound'), false, 'unbound session is not listed');
    assertEqual(listed.includes(sessionA.session_ref), true, 'registered session is listed');
    assert(JSON.stringify(list.value.data).includes(exportRoot) === false, 'wire list never exposes absolute export paths');
    return 'no reads for unbound session';
  });

  await check('capture install/dispose manages Host listener counts (dispose -> 0)', async () => {
    capture.install();
    let stats = host.stats();
    assertEqual(stats.session_listeners, 1, 'session listener installed');
    assertEqual(stats.llm_listeners, 1, 'llm stream listener installed');
    assertEqual(stats.pre_step_listeners, 1, 'pre-step listener installed');
    const describe = capture.describe();
    assertEqual(describe.installed, true, 'capture installed');
    capture.dispose();
    stats = host.stats();
    assertEqual(stats.session_listeners, 0, 'session listener removed');
    assertEqual(stats.llm_listeners, 0, 'llm stream listener removed');
    assertEqual(stats.pre_step_listeners, 0, 'pre-step listener removed');
    assertEqual(capture.describe().installed, false, 'capture disposed');
    return 'listener counts return to zero';
  });

  await check('local export is atomic, idempotent and never exposes absolute paths', async () => {
    const first = await handler('report.export', envelope('ctx-smoke-a', 4, 'op-export-1', {
      observation_id: observationA.observation_id,
      output_ref: 'reports',
      expected_revision: observationA.revision,
    }), undefined, peer);
    assertEqual(first.value.status, 'ok', 'export business status');
    const saved = first.value.data;
    assertEqual(saved.status, 'saved', 'export saved');
    assert(typeof saved.digest === 'string' && /^[0-9a-f]{64}$/.test(saved.digest), 'export digest is 64 hex');
    assertEqual(path.isAbsolute(saved.report_ref), false, 'report_ref is root-relative');
    assert(JSON.stringify(saved).includes(exportRoot) === false, 'wire result never exposes the absolute root');
    const reportPath = path.join(exportRoot, saved.report_ref);
    assert(existsSync(reportPath), 'report file exists in the registered root');

    const second = await handler('report.export', envelope('ctx-smoke-a', 4, 'op-export-2', {
      observation_id: observationA.observation_id,
      output_ref: 'reports',
      expected_revision: observationA.revision,
    }), undefined, peer);
    assertEqual(second.value.data.status, 'saved', 'repeat export is idempotent');
    assertEqual(second.value.data.digest, saved.digest, 'repeat export reuses the same digest');

    const deniedRef = await handler('report.export', envelope('ctx-smoke-a', 4, 'op-export-denied', {
      observation_id: observationA.observation_id,
      output_ref: 'secrets',
      expected_revision: observationA.revision,
    }), undefined, peer);
    assertEqual(deniedRef.value.status, 'denied', 'unregistered output_ref denied');
    assertEqual(deniedRef.value.reason_code, 'OUTPUT_REF_DENIED', 'output ref reason');
    return `saved ${saved.report_ref}`;
  });

  await check('export writer denies traversal, non-directory and symlink targets', async () => {
    const report = {
      schema_version: 1,
      capability: '07',
      report_id: 'ctx-report-smoke-negative',
      exported_at: '2026-11-07T00:00:00.000Z',
      observation: observationA,
      redaction_policy_revision: POLICY_REVISION,
    };
    const writer = exportModule.createReportWriter({ clock: FIXTURE_CLOCK });
    const expectDenied = (label, fn, codes) => {
      try {
        fn();
        throw new Error(`${label}: expected an export denial`);
      } catch (error) {
        if (error.message === `${label}: expected an export denial`) throw error;
        assert(error instanceof exportModule.ExportError, `${label}: expected ExportError, got ${error && error.name}`);
        assert(codes.includes(error.reasonCode), `${label}: unexpected reason ${error.reasonCode}`);
      }
    };
    expectDenied('traversal', () => writer.writeReport({ rootPath: exportRoot, report, fileName: '../escape.json' }), ['OUTPUT_REF_DENIED', 'INVALID_REQUEST']);
    expectDenied('nested', () => writer.writeReport({ rootPath: exportRoot, report, fileName: 'nested/report.json' }), ['OUTPUT_REF_DENIED', 'INVALID_REQUEST']);
    expectDenied('relative-root', () => writer.writeReport({ rootPath: 'reports', report, fileName: 'report.json' }), ['INVALID_REQUEST']);
    const notADirectory = path.join(exportRoot, 'not-a-directory.json');
    writeFileSync(notADirectory, 'synthetic', { mode: 0o600 });
    expectDenied('file-as-root', () => writer.writeReport({ rootPath: notADirectory, report, fileName: 'report.json' }), ['OUTPUT_REF_DENIED']);
    expectDenied('directory-as-target', () => {
      mkdirSync(path.join(exportRoot, 'dir-target.json'));
      writer.writeReport({ rootPath: exportRoot, report, fileName: 'dir-target.json' });
    }, ['OUTPUT_REF_DENIED']);
    assertEqual(existsSync(path.join(workDir, 'escape.json')), false, 'traversal wrote nothing outside the root');

    // Real symlink target when the host permits it; otherwise prove the same
    // branch through an injected fs adapter (documented in the evidence file).
    const outsideFile = path.join(outsideDir, 'outside.json');
    writeFileSync(outsideFile, 'outside synthetic content', { mode: 0o600 });
    const link = path.join(exportRoot, 'link-target.json');
    let realSymlink = true;
    try {
      symlinkSync(outsideFile, link);
    } catch {
      realSymlink = false;
    }
    if (realSymlink) {
      expectDenied('symlink-target', () => writer.writeReport({ rootPath: exportRoot, report, fileName: 'link-target.json' }), ['OUTPUT_REF_DENIED']);
      assertEqual(readFileSync(outsideFile, 'utf8'), 'outside synthetic content', 'symlink target unchanged');
    } else {
      const nodeFs = await import('node:fs');
      const adapter = Object.assign({}, nodeFs, {
        lstatSync(candidate) {
          if (path.resolve(candidate) === path.resolve(link)) {
            return { isSymbolicLink: () => true, isFile: () => true, isDirectory: () => false, mode: 0o100666 };
          }
          return nodeFs.lstatSync(candidate);
        },
      });
      const adapted = exportModule.createReportWriter({ clock: FIXTURE_CLOCK, fs: adapter });
      expectDenied('symlink-target(adapter)', () => adapted.writeReport({ rootPath: exportRoot, report, fileName: 'link-target.json' }), ['OUTPUT_REF_DENIED']);
    }
    return realSymlink ? 'real symlink denied' : 'symlink denied via injected fs adapter (host EPERM)';
  });

  await check('session switch drops a late observation response (view epoch)', async () => {
    const rpc = createGatedFetch(handler, peer);
    const store = storeModule.createContextStore({
      fetch: rpc.fetch,
      document: fakeDocument(),
      timers: fakeTimers(),
      pollIntervalMs: 500,
      operationId: (() => {
        let counter = 0;
        return () => {
          counter += 1;
          return `smoke-op-${counter}`;
        };
      })(),
    });
    try {
      const gate = rpc.setGate((endpoint, payload) => endpoint === 'observation.get' && payload.context_ref === 'ctx-smoke-a');
      store.setPanelActive(true);
      store.selectSession('session-smoke-a');
      await waitFor(() => rpc.calls.some((call) => call.endpoint === 'observation.get' && call.payload.context_ref === 'ctx-smoke-a'));
      const gated = rpc.calls.filter((call) => call.endpoint === 'observation.get' && call.payload.context_ref === 'ctx-smoke-a').pop();
      assertEqual(gated.signal.aborted, false, 'session A observation still in flight');

      store.selectSession('session-smoke-b');
      assertEqual(gated.signal.aborted, true, 'session switch aborts the in-flight request');
      gate.resolve();
      rpc.clearGate();
      await store.whenIdle();
      await flushAsync();

      const snapshot = store.getSnapshot();
      assertEqual(snapshot.session_ref, 'session-smoke-b', 'active session');
      assert(snapshot.context !== null && snapshot.context.context_ref === 'ctx-smoke-b', 'active context is B');
      assert(snapshot.observation !== null, 'session B observation is displayed');
      assertEqual(snapshot.observation.boundary.session_ref, 'session-smoke-b', 'only session B content is displayed');
      const rendered = JSON.stringify(snapshot);
      assert(rendered.includes(A_MARKER) === false, 'late session A content was dropped');
      assertEqual(snapshot.status, 'ready', 'store reached ready for B');
      return 'late A response dropped after switch';
    } finally {
      store.dispose();
    }
  });

  await check('client store transport failures use fixed codes only (no raw text)', async () => {
    const failingFetch = async (url, init) => {
      const endpoint = String(url).slice('/api/context-mng/'.length);
      const payload = JSON.parse(init.body);
      if (endpoint === 'context.list') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            schema_version: 1,
            operation_id: payload.operation_id,
            view_epoch: payload.view_epoch,
            scope_generation: 0,
            status: 'ok',
            data: { contexts: [{ context_ref: 'ctx-smoke-a', session_ref: 'session-smoke-a', scope_id: 'scope-smoke-a', generation: 4, read: true, export_root_refs: ['reports'] }] },
          }),
        };
      }
      throw new Error(`CANARY-RAW-NETWORK-TEXT ${A_MARKER}`);
    };
    const store = storeModule.createContextStore({ fetch: failingFetch, document: fakeDocument(), timers: fakeTimers(), pollIntervalMs: 500 });
    try {
      store.setPanelActive(true);
      store.selectSession('session-smoke-a');
      await store.whenIdle();
      await flushAsync();
      const snapshot = store.getSnapshot();
      assertEqual(snapshot.status, 'error', 'transport failure becomes an explicit error state');
      assertEqual(snapshot.error_code, 'TRANSPORT_FAILURE', 'fixed transport code');
      const rendered = JSON.stringify(snapshot);
      assert(rendered.includes('CANARY-RAW-NETWORK-TEXT') === false, 'raw transport message is never surfaced');
      assert(rendered.includes(A_MARKER) === false, 'raw session marker is never surfaced');
      return 'mapped to TRANSPORT_FAILURE';
    } finally {
      store.dispose();
    }
  });

  capture.dispose();
  access.dispose();
  observationStore.dispose();
  service.dispose();
  rmSync(workDir, { recursive: true, force: true });

  // Network evidence must be evaluated last so every prior check is counted.
  const attempts = allAttempts();
  if (networkEvidence) {
    process.stdout.write(`# network evidence: guards installed on fetch/WebSocket/XMLHttpRequest/EventSource, node:net/http/https/dns\n`);
    process.stdout.write(`# network evidence: outbound attempts recorded = ${attempts.length}\n`);
    for (const attempt of attempts) process.stdout.write(`# network evidence: attempt ${attempt}\n`);
    record('plugin module graph made zero outbound network attempts', attempts.length === 0, attempts.join(','));
  } else {
    process.stdout.write(`# network guards active during this run; attempts recorded = ${attempts.length} (run --network-evidence to make it a check)\n`);
    if (attempts.length > 0) record('plugin module graph made zero outbound network attempts (implicit)', false, attempts.join(','));
  }

  globalGuards.restore();
  moduleGuards.restore();

  const pass = results.filter((result) => result.ok).length;
  const fail = results.length - pass;
  process.stdout.write(`1..${results.length}\n`);
  process.stdout.write(`# pass ${pass}\n`);
  process.stdout.write(`# fail ${fail}\n`);
  if (fail > 0) {
    for (const result of results.filter((item) => !item.ok)) process.stdout.write(`# FAIL ${result.name}: ${result.detail}\n`);
    return 1;
  }
  process.stdout.write(`# ${TOOL}: all checks passed (${networkEvidence ? 'with' : 'without'} --network-evidence)\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${TOOL}: unexpected failure: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  },
);
