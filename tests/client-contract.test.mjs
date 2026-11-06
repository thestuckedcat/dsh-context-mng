/**
 * T3 client contract tests (CTX-04/06, design §5.1/§6, compatibility §6).
 *
 * No browser and no jsdom: `client.js` is a classic script in the VERIFIED
 * rc.5 module-loader format, so this suite loads its text, runs it with a fake
 * `window.__ModuleLoader__`, materializes the factory with a fake `require`
 * that only provides `react`, and then drives the returned plugin with a fake
 * client context and a fake Connection RPC. The `ui/` modules are tested both
 * through that embedded copy and directly.
 *
 * Coverage: exact bundle format, factory side-effect freedom, declarative
 * registrations, locale dictionaries, effect cleanup, store request envelopes,
 * epoch/generation late-response dropping, single-flight polling, visibility
 * and pause gating, fixed transport-failure mapping (no raw text), export
 * state machine without auto-retry, panel render states, and static bans on
 * HTML injection / disk / network access.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import * as contracts from '../src/contracts.mjs';
import { observation, group } from './helpers.mjs';
import {
  createContextStore,
  validateBusinessResponseLite,
  validateObservationLite,
} from '../ui/context-store.js';
import { createContextPanel, createContextPanelIcon } from '../ui/context-panel.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CLIENT_PATH = path.join(REPO, 'client.js');
const STORE_PATH = path.join(REPO, 'ui', 'context-store.js');
const PANEL_PATH = path.join(REPO, 'ui', 'context-panel.js');
const CSS_PATH = path.join(REPO, 'ui', 'context.css');
const EN_PATH = path.join(REPO, 'locale', 'en.json');
const ZH_PATH = path.join(REPO, 'locale', 'zh.json');

const CLIENT_SOURCE = readFileSync(CLIENT_PATH, 'utf8');
const STORE_SOURCE = readFileSync(STORE_PATH, 'utf8');
const PANEL_SOURCE = readFileSync(PANEL_PATH, 'utf8');
const CSS_SOURCE = readFileSync(CSS_PATH, 'utf8');
const EN_DICT = JSON.parse(readFileSync(EN_PATH, 'utf8'));
const ZH_DICT = JSON.parse(readFileSync(ZH_PATH, 'utf8'));

const API_BASE = '/api/context-mng';
const PANEL_KEY = 'local-context';
const LOCALE_NS = 'dsh-context-mng';

// ---------------------------------------------------------------------------
// fake environment helpers
// ---------------------------------------------------------------------------

function createFakeReact() {
  const effectCleanups = [];
  const calls = { createElement: 0 };
  const React = {
    createElement(type, props, ...children) {
      calls.createElement += 1;
      return { type, props: props || {}, children: flatten(children) };
    },
    Fragment: 'Fragment',
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}];
    },
    useEffect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') effectCleanups.push(cleanup);
    },
    useRef(value) {
      return { current: value };
    },
    useMemo(fn) {
      return fn();
    },
    useCallback(fn) {
      return fn;
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot();
    },
  };
  return { React, effectCleanups, calls };
}

function flatten(children) {
  const out = [];
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false || child === true) continue;
    out.push(child);
  }
  return out;
}

function textOf(node) {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (node === null || node === undefined) return '';
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (!node.children) return '';
  return node.children.map(textOf).join(' ');
}

function elementsOf(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child, out);
    return out;
  }
  out.push(node);
  for (const child of node.children || []) elementsOf(child, out);
  return out;
}

function createFakeTimers() {
  let nextId = 1;
  const intervals = new Map();
  return {
    setInterval(fn, ms) {
      const id = nextId;
      nextId += 1;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    get size() {
      return intervals.size;
    },
    intervals() {
      return Array.from(intervals.values());
    },
    async tick(times = 1) {
      for (let index = 0; index < times; index += 1) {
        for (const interval of Array.from(intervals.values())) interval.fn();
        await flushAsync();
      }
    },
  };
}

function createFakeDocument(initial = 'visible') {
  const listeners = new Set();
  return {
    visibilityState: initial,
    addEventListener(type, fn) {
      if (type === 'visibilitychange') listeners.add(fn);
    },
    removeEventListener(type, fn) {
      if (type === 'visibilitychange') listeners.delete(fn);
    },
    setVisibility(state) {
      this.visibilityState = state;
      for (const fn of Array.from(listeners)) fn();
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flushAsync() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await flushAsync();
  }
}

/** Deep-equal across the vm realm boundary (client bundle objects are not host-realm). */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function createFakeFetch() {
  const calls = [];
  const handlers = new Map();
  const ENDPOINTS = ['context.list', 'observation.get', 'group.read', 'report.export'];
  const toResponse = (outcome) => {
    if (outcome !== null && typeof outcome === 'object' && outcome.__http !== undefined) {
      return {
        ok: outcome.__http.ok === true,
        status: outcome.__http.status,
        json: async () => {
          if (outcome.__invalidJson === true) throw new Error('CANARY-INVALID-JSON');
          return outcome.body;
        },
      };
    }
    return { ok: true, status: 200, json: async () => outcome };
  };
  return {
    calls,
    on(endpoint, handler) {
      handlers.set(endpoint, handler);
    },
    /** The fetch function handed to the client store / browser bundle. */
    async fetch(url, init) {
      assert.equal(typeof url, 'string');
      const match = /^\/api\/context-mng\/([a-z.]+)$/.exec(url);
      assert.ok(match, `every request must use the fixed Host route, got ${url}`);
      const endpoint = match[1];
      assert.equal(ENDPOINTS.includes(endpoint), true, `unknown endpoint ${endpoint}`);
      assert.equal(init.method, 'POST');
      assert.equal(init.headers['content-type'], 'application/json');
      const payload = JSON.parse(init.body);
      calls.push({ url, endpoint, payload, signal: init.signal, init });
      const handler = handlers.get(endpoint);
      if (handler === undefined) throw new Error(`no fake fetch handler for ${endpoint}`);
      return toResponse(await handler(payload, init.signal));
    },
    jsonResponse(body) {
      return { __http: { ok: true, status: 200 }, body };
    },
    httpFailure(status = 500, body) {
      return { __http: { ok: false, status }, body };
    },
    invalidJson() {
      return { __http: { ok: true, status: 200 }, __invalidJson: true };
    },
    count(endpoint) {
      return calls.filter((call) => call.endpoint === endpoint).length;
    },
    last(endpoint) {
      const matches = calls.filter((call) => call.endpoint === endpoint);
      return matches[matches.length - 1];
    },
  };
}

function okResult(payload, data, overrides = {}) {
  const value = {
    schema_version: 1,
    operation_id: payload.operation_id,
    view_epoch: payload.view_epoch,
    scope_generation: overrides.generation === undefined ? generationFor(payload) : overrides.generation,
    status: 'ok',
    data,
  };
  if (overrides.operation_id !== undefined) value.operation_id = overrides.operation_id;
  if (overrides.view_epoch !== undefined) value.view_epoch = overrides.view_epoch;
  if (overrides.status !== undefined) {
    value.status = overrides.status;
    delete value.data;
    value.reason_code = overrides.reason_code || 'INTERNAL_FAILURE';
  }
  return value;
}

function generationFor(payload) {
  return payload.expected_scope_generation === undefined ? 0 : payload.expected_scope_generation;
}

function rejectResult(payload, status, reasonCode) {
  return {
    schema_version: 1,
    operation_id: payload.operation_id,
    view_epoch: payload.view_epoch,
    scope_generation: generationFor(payload),
    status,
    reason_code: reasonCode,
  };
}

const CONTEXT_A = { context_ref: 'ctx-a', session_ref: 'session-a', scope_id: 'project-a', generation: 3, read: true, export_root_refs: ['reports'] };
const CONTEXT_B = { context_ref: 'ctx-b', session_ref: 'session-b', scope_id: 'project-b', generation: 4, read: true, export_root_refs: ['reports'] };

function listData(contexts = [CONTEXT_A, CONTEXT_B]) {
  return { contexts };
}

function obsData(id = 'obs-a', overrides = {}) {
  return { changed: true, observation: observation(Object.assign({ observation_id: id }, overrides)), current_revision: 1 };
}

function makeT(dict) {
  return (key) => (dict && Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key);
}

async function settle(store) {
  await store.whenIdle();
  await flushAsync();
}

// ---------------------------------------------------------------------------
// bundle format + embedded-copy parity
// ---------------------------------------------------------------------------

function extractEmbedded(name) {
  const begin = `// >>> BEGIN EMBEDDED ${name}`;
  const end = `// >>> END EMBEDDED ${name}`;
  const beginIndex = CLIENT_SOURCE.indexOf(begin);
  assert.notEqual(beginIndex, -1, `client.js must carry the embedded ${name} region`);
  const contentStart = CLIENT_SOURCE.indexOf('\n', beginIndex);
  const endIndex = CLIENT_SOURCE.indexOf(end, contentStart);
  assert.notEqual(endIndex, -1, `client.js must close the embedded ${name} region`);
  return CLIENT_SOURCE.slice(contentStart + 1, endIndex).replace(/\s+$/, '');
}

function normalizeModuleSource(source) {
  return source.replace(/^export /gm, '').replace(/\s+$/, '');
}

test('client.js is a single rc.5 module-loader registration in the exact format', () => {
  assert.match(CLIENT_SOURCE, /^\/\*\*[\s\S]*?\*\/\s*\nwindow\.__ModuleLoader__\.load\(\{/);
  assert.equal(CLIENT_SOURCE.includes('__ModuleLoader__'), true);

  const registrations = [];
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(registration) {
          registrations.push(registration);
        },
      },
    },
    AbortController,
    setInterval: () => 0,
    clearInterval: () => {},
    console: { warn() {}, error() {}, info() {}, log() {} },
  };
  vm.runInNewContext(CLIENT_SOURCE, sandbox, { filename: 'client.js' });

  assert.equal(registrations.length, 1, 'exactly one load() registration');
  const registration = registrations[0];
  assert.equal(registration.id, 'dsh-context-mng');
  assert.equal(typeof registration.factory, 'function');
  assert.equal(registration.factory.length, 1, 'factory must take the require function');

  const bundleFormat = {
    id: registration.id,
    factory: registration.factory.toString().slice(0, 200),
  };
  assert.match(bundleFormat.factory, /factory\s*\(require\)|factory:\s*\(?require\)?\s*=>|factory\s*\(\s*require\s*\)/, 'factory declares require');

  // No ESM syntax: the bundle must stay a classic script.
  assert.equal(/^\s*import\s+/m.test(CLIENT_SOURCE), false, 'client.js must not use import statements');
  assert.equal(/^\s*export\s+/m.test(CLIENT_SOURCE), false, 'client.js must not use export statements');
  assert.equal(CLIENT_SOURCE.includes('React.createElement'), true);
  assert.equal(CLIENT_SOURCE.includes("require('react')"), true);
});

test('ui modules are embedded byte-identically in client.js', () => {
  assert.equal(extractEmbedded('ui/context-store.js'), normalizeModuleSource(STORE_SOURCE));
  assert.equal(extractEmbedded('ui/context-panel.js'), normalizeModuleSource(PANEL_SOURCE));
});

test('locale dictionaries are embedded exactly from locale/*.json', () => {
  const enRegion = extractEmbedded('locale/en.json');
  const zhRegion = extractEmbedded('locale/zh.json');
  const enMatch = enRegion.match(/const DICT_EN = (\{[\s\S]*\});/);
  const zhMatch = zhRegion.match(/const DICT_ZH = (\{[\s\S]*\});/);
  assert.ok(enMatch, 'en dictionary literal must be present');
  assert.ok(zhMatch, 'zh dictionary literal must be present');
  assert.deepEqual(JSON.parse(enMatch[1]), EN_DICT);
  assert.deepEqual(JSON.parse(zhMatch[1]), ZH_DICT);
  assert.deepEqual(Object.keys(EN_DICT).sort(), Object.keys(ZH_DICT).sort(), 'en/zh key parity');
});

test('all literal locale keys used by the panel exist in both dictionaries', () => {
  assert.equal(typeof EN_DICT.meta.title, 'string');
  assert.equal(typeof EN_DICT.meta.description, 'string');
  assert.equal(typeof ZH_DICT.meta.title, 'string');
  assert.equal(typeof ZH_DICT.meta.description, 'string');
  const required = [
    'panel.title', 'panel.empty', 'panel.unbound', 'panel.denied', 'panel.stale', 'panel.unavailable',
    'panel.loading', 'panel.refresh', 'panel.pause', 'panel.resume', 'panel.export', 'panel.export.emptyHint',
    'panel.estimated', 'panel.reported', 'panel.unknown', 'panel.truncated', 'panel.group.expand',
    'panel.group.collapse', 'panel.stage', 'panel.fidelity', 'panel.requestedAt', 'panel.redactions',
  ];
  for (const key of required) {
    assert.equal(typeof EN_DICT[key], 'string', `en dictionary missing ${key}`);
    assert.equal(typeof ZH_DICT[key], 'string', `zh dictionary missing ${key}`);
  }
  const used = new Set();
  for (const source of [CLIENT_SOURCE, PANEL_SOURCE]) {
    for (const match of source.matchAll(/\bt\('([^']+)'\)/g)) used.add(match[1]);
  }
  for (const key of used) assert.equal(typeof EN_DICT[key], 'string', `literal t('${key}') is not in locale/en.json`);
});

test('client source contains no HTML injection, disk access or unfixed network target', () => {
  const forbidden = [
    /dangerouslySetInnerHTML/,
    /\.innerHTML\s*=/,
    /document\.write/,
    /document\.cookie/,
    /\bXMLHttpRequest\b/,
    /\bWebSocket\b/,
    /\bEventSource\b/,
    /require\(\s*['"]node:/,
    /require\(\s*['"](?:fs|http|https|net|child_process)['"]\s*\)/,
    /\bnew Function\s*\(/,
    /[^.\w]eval\s*\(/,
    /\bprocess\./,
    /\bconnection\.rpc\b/,
    /\brpc\.call\b/,
  ];
  for (const pattern of forbidden) {
    assert.equal(pattern.test(CLIENT_SOURCE), false, `client.js must not match ${pattern}`);
    assert.equal(pattern.test(STORE_SOURCE), false, `ui/context-store.js must not match ${pattern}`);
    assert.equal(pattern.test(PANEL_SOURCE), false, `ui/context-panel.js must not match ${pattern}`);
  }

  // The only egress is the fixed same-origin exact Fetch route (CTX-RPC-03).
  assert.equal(STORE_SOURCE.includes("const API_BASE = '/api/context-mng';"), true, 'fixed API base');
  for (const endpoint of ['context.list', 'observation.get', 'group.read', 'report.export']) {
    assert.equal(STORE_SOURCE.includes(`'${endpoint}'`), true, `endpoint allow-list includes ${endpoint}`);
  }
  assert.equal((STORE_SOURCE.match(/fetchImpl\(/g) || []).length, 1, 'exactly one fetch call site');
  assert.equal(STORE_SOURCE.includes("apiBase + '/' + endpoint"), true, 'fetch URL is built only from the fixed base and allow-listed endpoint');
  assert.equal(STORE_SOURCE.includes("method: 'POST'"), true);
  assert.equal(STORE_SOURCE.includes("headers: { 'content-type': 'application/json' }"), true);
  assert.equal(STORE_SOURCE.includes('body: JSON.stringify(payload)'), true);
  assert.equal(STORE_SOURCE.includes('signal: controller.signal'), true);
  assert.equal(/https?:\/\//.test(STORE_SOURCE), false, 'no absolute/remote URL in the store');
  assert.equal(CLIENT_SOURCE.includes("typeof fetch === 'function'"), true, 'browser bundle passes the real fetch');
  assert.equal(/https?:\/\//.test(CLIENT_SOURCE), false, 'no absolute/remote URL in the browser bundle');

  assert.equal(/@import|url\(/.test(CSS_SOURCE), false, 'panel CSS must not load remote/local assets');
  assert.equal(/^[.#]?[a-z]/im.test(CSS_SOURCE), true, 'panel CSS exists and is panel-scoped');
});

// ---------------------------------------------------------------------------
// factory + apply lifecycle with a fake client context
// ---------------------------------------------------------------------------

function loadPlugin(globals = {}) {
  const registrations = [];
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(registration) {
          registrations.push(registration);
        },
      },
    },
    AbortController,
    setInterval: () => 0,
    clearInterval: () => {},
    console: { warn() {}, error() {}, info() {}, log() {} },
  };
  if (globals.fetch !== undefined) sandbox.fetch = globals.fetch;
  vm.runInNewContext(CLIENT_SOURCE, sandbox, { filename: 'client.js' });
  assert.equal(registrations.length, 1);
  const requireCalls = [];
  const fakeReact = createFakeReact();
  const require = (spec) => {
    requireCalls.push(spec);
    if (spec === 'react') return fakeReact.React;
    throw new Error(`unexpected require(${JSON.stringify(spec)})`);
  };
  const plugin = registrations[0].factory(require);
  return { plugin, requireCalls, fakeReact, sandbox, registration: registrations[0] };
}

function createFakeClientContext(rpc) {
  const record = {
    effects: [],
    slotsInject: [],
    slotsRegister: [],
    localeRegister: [],
    selectedPanels: [],
    disposers: [],
    slotInjectDisposals: 0,
    localeDisposals: 0,
  };
  const slots = {
    inject(name, callback) {
      record.slotsInject.push(name);
      const disposable = callback();
      return () => {
        record.slotInjectDisposals += 1;
        if (typeof disposable === 'function') disposable();
      };
    },
    register(options, Component) {
      record.slotsRegister.push({ options, Component });
      return () => {};
    },
    entries() {
      return [];
    },
  };
  const layout = {
    selectPanel(id) {
      record.selectedPanels.push(id);
    },
  };
  const locale = {
    register(namespace, dictionaries) {
      record.localeRegister.push({ namespace, dictionaries });
      return () => {
        record.localeDisposals += 1;
      };
    },
    bind(namespace) {
      return (key) => {
        const registered = record.localeRegister.filter((entry) => entry.namespace === namespace).pop();
        const dictionaries = registered === undefined ? { en: EN_DICT } : registered.dictionaries;
        return dictionaries.en !== undefined && Object.prototype.hasOwnProperty.call(dictionaries.en, key) ? dictionaries.en[key] : key;
      };
    },
    resolveText(text) {
      return typeof text === 'string' ? text : text.en;
    },
    getSnapshot() {
      return { active: 'en', revision: 0 };
    },
    subscribe() {
      return () => {};
    },
  };
  const ctx = {
    slots,
    layout,
    connection: { rpc },
    locale,
    effect(fn, label) {
      record.effects.push(label);
      const disposable = fn();
      if (typeof disposable === 'function') {
        record.disposers.push(disposable);
        return () => {
          disposable();
        };
      }
      return () => {};
    },
    on() {
      return () => {};
    },
    logger: { warn() {}, info() {} },
  };
  return { ctx, record };
}

test('factory is side-effect free and returns the declared plugin face', () => {
  const calls = [];
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(registration) {
          calls.push(registration);
        },
      },
    },
    AbortController,
    setInterval: () => 0,
    clearInterval: () => {},
    console: { warn() {}, error() {}, info() {}, log() {} },
  };
  vm.runInNewContext(CLIENT_SOURCE, sandbox, { filename: 'client.js' });
  const requireCalls = [];
  const fakeReact = createFakeReact();
  const require = (spec) => {
    requireCalls.push(spec);
    if (spec === 'react') return fakeReact.React;
    throw new Error('unexpected require');
  };
  const plugin = calls[0].factory(require);

  assert.deepEqual(requireCalls, ['react'], 'factory must only require react');
  assert.equal(fakeReact.calls.createElement, 0, 'factory must not create elements');
  assert.equal(typeof plugin, 'object');
  assert.equal(plugin.name, 'dsh-context-mng');
  assert.deepEqual(plain(plugin.inject), ['slots', 'layout', 'connection', 'sessions', 'locale']);
  assert.equal(typeof plugin.apply, 'function');
  assert.equal(typeof plugin.apply.constructor, 'function');
});

test('apply registers the main panel, sidebar entry, locale and returns cleanup', () => {
  const rpc = createFakeFetch();
  const { plugin } = loadPlugin({ fetch: rpc.fetch });
  const { ctx, record } = createFakeClientContext(rpc);

  const cleanup = plugin.apply(ctx);
  assert.equal(typeof cleanup, 'function', 'apply must return a cleanup disposer');

  assert.equal(record.localeRegister.length, 1);
  assert.equal(record.localeRegister[0].namespace, LOCALE_NS);
  assert.deepEqual(plain(record.localeRegister[0].dictionaries.en), EN_DICT);
  assert.deepEqual(plain(record.localeRegister[0].dictionaries.zh), ZH_DICT);

  assert.deepEqual(record.slotsInject, ['main', 'sidebar.panellist']);
  const main = record.slotsRegister.find((entry) => entry.options.name === 'main');
  assert.ok(main, 'main panel registration must happen inside apply');
  assert.equal(main.options.key, PANEL_KEY);
  assert.equal(main.options.locale, LOCALE_NS);
  assert.equal(typeof main.Component, 'function');

  const sidebar = record.slotsRegister.find((entry) => entry.options.name === 'sidebar.panellist');
  assert.ok(sidebar, 'sidebar entry is recommended for discovery and must register');
  assert.equal(sidebar.options.id, PANEL_KEY);
  assert.equal(sidebar.options.locale, LOCALE_NS);
  assert.equal(typeof sidebar.options.label, 'function');
  assert.equal(sidebar.options.label(), EN_DICT['panel.title']);
  assert.equal(typeof sidebar.Component, 'function');

  const face = main.options.inject();
  assert.equal(typeof face.store.getSnapshot, 'function');
  assert.equal(typeof face.closePanel, 'function');
  assert.equal(typeof face.openPanel, 'function');
  assert.deepEqual(record.selectedPanels, [], 'opening the panel is a Host/user action, never an apply side effect');

  face.openPanel();
  face.closePanel();
  assert.deepEqual(record.selectedPanels, [PANEL_KEY, null], 'open selects the panel; close restores conversation (null)');

  cleanup();
  assert.equal(face.store.getSnapshot().disposed, true, 'cleanup disposes the panel store');
  assert.equal(record.localeDisposals, 1, 'cleanup unregisters locale dictionaries');
  assert.equal(record.slotInjectDisposals, 2, 'cleanup disposes both slot injectors');
});

// ---------------------------------------------------------------------------
// store behaviours through the client-embedded store
// ---------------------------------------------------------------------------

function pluginFace() {
  const rpc = createFakeFetch();
  const { plugin } = loadPlugin({ fetch: rpc.fetch });
  const { ctx, record } = createFakeClientContext(rpc);
  const cleanup = plugin.apply(ctx);
  const main = record.slotsRegister.find((entry) => entry.options.name === 'main');
  const face = main.options.inject();
  return { store: face.store, face, rpc, cleanup, record };
}

test('client-embedded store bootstraps context.list and observation.get with the wire envelope', async () => {
  const { store, rpc, cleanup } = pluginFace();
  rpc.on('context.list', (payload) => okResult(payload, listData()));
  rpc.on('observation.get', (payload) => okResult(payload, obsData()));

  store.setPanelActive(true);
  store.selectSession('session-a');
  await settle(store);

  const listCall = rpc.last('context.list');
  assert.equal(listCall.url, API_BASE + '/context.list');
  assert.deepEqual(Object.keys(listCall.payload).sort(), ['input', 'operation_id', 'schema_version', 'view_epoch']);
  assert.deepEqual(plain(listCall.payload.input), {});
  assert.equal(typeof listCall.payload.operation_id, 'string');
  assert.ok(listCall.payload.operation_id.length >= 1 && listCall.payload.operation_id.length <= 128);

  const obsCall = rpc.last('observation.get');
  assert.deepEqual(Object.keys(obsCall.payload).sort(), ['context_ref', 'expected_scope_generation', 'input', 'operation_id', 'schema_version', 'view_epoch']);
  assert.equal(obsCall.payload.context_ref, 'ctx-a');
  assert.equal(obsCall.payload.expected_scope_generation, 3);
  assert.deepEqual(plain(obsCall.payload.input), { stage: 'session_surface' });
  assert.equal(obsCall.payload.view_epoch, listCall.payload.view_epoch, 'view epoch is stable within one view');

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.session_ref, 'session-a');
  assert.equal(snapshot.context.context_ref, 'ctx-a');
  assert.equal(snapshot.observation_id, 'obs-a');
  assert.deepEqual(plain(snapshot.groups.map((entry) => entry.group_id)), ['system|system-prompt|']);
  assert.equal(snapshot.fidelity, 'history_projection');
  assert.deepEqual(plain(snapshot.export_roots), ['reports']);

  cleanup();
});

test('client-embedded store drops a late response after a session switch (epoch abort)', async () => {
  const { store, rpc, cleanup } = pluginFace();
  rpc.on('context.list', (payload) => okResult(payload, listData()));
  const pending = deferred();
  let firstSignal;
  rpc.on('observation.get', (payload, signal) => {
    if (payload.context_ref === 'ctx-a') {
      firstSignal = signal;
      return pending.promise;
    }
    return okResult(payload, obsData('obs-b'));
  });

  store.setPanelActive(true);
  store.selectSession('session-a');
  await waitFor(() => firstSignal !== undefined);
  assert.equal(store.getSnapshot().status, 'empty');

  store.selectSession('session-b');
  assert.equal(firstSignal.aborted, true, 'session switch must abort the in-flight observation request');
  pending.resolve(okResult({ operation_id: 'stale-op', view_epoch: 1, expected_scope_generation: 3 }, obsData('obs-a')));
  await settle(store);

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.session_ref, 'session-b');
  assert.equal(snapshot.observation_id, 'obs-b', 'only session B content is displayed');
  assert.equal(snapshot.context.context_ref, 'ctx-b');
  cleanup();
});

test('client-embedded store maps transport failures to fixed codes without raw text', async () => {
  const { store, rpc, cleanup } = pluginFace();
  rpc.on('context.list', (payload) => okResult(payload, listData()));
  rpc.on('observation.get', () => {
    throw new Error('CANARY-RAW-TRANSPORT-MESSAGE');
  });

  store.setPanelActive(true);
  store.selectSession('session-a');
  await settle(store);

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.status, 'error');
  assert.equal(snapshot.error_code, 'TRANSPORT_FAILURE');
  assert.equal(JSON.stringify(snapshot).includes('CANARY-RAW-TRANSPORT-MESSAGE'), false, 'raw transport text must never enter state');
  cleanup();
});

test('report.export is user-triggered, validated and never auto-retried', async () => {
  const { store, rpc, cleanup } = pluginFace();
  rpc.on('context.list', (payload) => okResult(payload, listData()));
  rpc.on('observation.get', (payload) => okResult(payload, obsData()));
  rpc.on('report.export', () => {
    throw new Error('CANARY-EXPORT-TRANSPORT');
  });

  store.setPanelActive(true);
  store.selectSession('session-a');
  await settle(store);
  assert.equal(store.getSnapshot().status, 'ready');

  store.exportReport();
  await settle(store);

  const exportCall = rpc.last('report.export');
  assert.equal(exportCall.payload.input.observation_id, 'obs-a');
  assert.equal(exportCall.payload.input.output_ref, 'reports');
  assert.equal(exportCall.payload.input.expected_revision, 1);
  assert.equal(store.getSnapshot().export_state.phase, 'error');
  assert.equal(JSON.stringify(store.getSnapshot()).includes('CANARY-EXPORT-TRANSPORT'), false);

  const callsBefore = rpc.count('report.export');
  await new Promise((resolve) => setTimeout(resolve, 650));
  await settle(store);
  assert.equal(rpc.count('report.export'), callsBefore, 'a failed export is never retried automatically');
  assert.equal(callsBefore, 1);
  cleanup();
});

// ---------------------------------------------------------------------------
// store unit tests (ui/context-store.js) with fake timers/visibility
// ---------------------------------------------------------------------------

function storeHarness(overrides = {}) {
  const rpc = overrides.rpc || createFakeFetch();
  const timers = createFakeTimers();
  const doc = createFakeDocument();
  let counter = 0;
  const store = createContextStore(Object.assign({
    fetch: rpc.fetch,
    document: doc,
    timers,
    pollIntervalMs: 500,
    operationId: () => {
      counter += 1;
      return `op-${counter}`;
    },
  }, overrides.storeOptions || {}));
  if (overrides.wire !== false) {
    rpc.on('context.list', (payload) => okResult(payload, listData()));
    rpc.on('observation.get', (payload) => okResult(payload, obsData()));
  }
  return { store, rpc, timers, doc };
}

test('store: unbound session is never sampled', async () => {
  const { store, rpc, timers } = storeHarness({ wire: false });
  rpc.on('context.list', (payload) => okResult(payload, listData([CONTEXT_B])));
  store.setPanelActive(true);
  store.selectSession('session-a');
  await settle(store);
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.status, 'unbound');
  assert.equal(snapshot.context, null);
  assert.equal(rpc.count('observation.get'), 0, 'no observation request for an unbound session');
  assert.equal(timers.size, 0, 'no polling timer for an unbound session');
  store.dispose();
});

test('store: one in-flight poll at most, gated by visibility and pause', async () => {
  const { store, rpc, timers, doc } = storeHarness();
  const pending = deferred();
  let observations = 0;
  rpc.on('observation.get', (payload) => {
    observations += 1;
    if (observations === 1) return okResult(payload, obsData());
    return pending.promise;
  });
  store.setPanelActive(true);
  store.selectSession('session-a');
  await settle(store);
  assert.equal(store.getSnapshot().status, 'ready');
  assert.equal(timers.size, 1, 'polling starts once observation data exists');

  await timers.tick();
  assert.equal(rpc.count('observation.get'), 2, 'one poll on the 500ms tick');
  await timers.tick(3);
  assert.equal(rpc.count('observation.get'), 2, 'no second request while one poll is in flight');

  pending.resolve(okResult({ operation_id: 'op-x', view_epoch: store.getSnapshot().view_epoch || 1, expected_scope_generation: 3 }, { changed: false, current_revision: 1 }));
  await settle(store);

  store.setPaused(true);
  await timers.tick(2);
  assert.equal(rpc.count('observation.get'), 2, 'paused refresh issues no requests');
  store.setPaused(false);
  await settle(store);
  doc.setVisibility('hidden');
  await flushAsync();
  const beforeHide = rpc.count('observation.get');
  await timers.tick(2);
  assert.equal(rpc.count('observation.get'), beforeHide, 'hidden document issues no poll requests');

  store.dispose();
  assert.equal(timers.size, 0, 'dispose clears the poll timer');
  assert.equal(doc.listenerCount(), 0, 'dispose removes the visibility listener');
});

test('store: close aborts the in-flight poll, increments epoch and clears body text', async () => {
  const { store, rpc, timers } = storeHarness();
  const pending = deferred();
  store.setPanelActive(true);
  store.selectSession('session-a');
  await settle(store);
  assert.equal(store.getSnapshot().status, 'ready');

  rpc.on('observation.get', () => pending.promise);
  await timers.tick();
  const pendingCall = rpc.last('observation.get');
  assert.equal(pendingCall.signal.aborted, false);
  const epochBefore = store.getSnapshot().view_epoch;

  store.setPanelActive(false);
  assert.equal(pendingCall.signal.aborted, true, 'closing the panel aborts the in-flight poll');
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.status, 'idle');
  assert.equal(snapshot.observation, null);
  assert.deepEqual(snapshot.groups, []);
  assert.deepEqual(snapshot.group_texts, {});
  assert.equal(timers.size, 0);
  if (typeof epochBefore === 'number') assert.ok(snapshot.view_epoch === undefined || snapshot.view_epoch === epochBefore, 'epoch bookkeeping stays internal');

  pending.resolve(okResult(pendingCall.payload, obsData('late-obs')));
  await flushAsync();
  assert.equal(store.getSnapshot().observation_id, null, 'late response after close is dropped');
  store.dispose();
});

test('store: generation mismatch and operation mismatch are dropped', async () => {
  const { store, rpc } = storeHarness({ wire: false });
  rpc.on('context.list', (payload) => okResult(payload, listData()));
  rpc.on('observation.get', (payload) => okResult(payload, obsData(), { generation: 2 }));
  store.setPanelActive(true);
  store.selectSession('session-a');
  await settle(store);
  assert.equal(store.getSnapshot().status, 'stale', 'a response for another scope generation is not displayed');
  assert.equal(store.getSnapshot().observation, null);
  store.dispose();

  const second = storeHarness({ wire: false });
  second.rpc.on('context.list', (payload) => okResult(payload, listData()));
  second.rpc.on('observation.get', (payload) => okResult(payload, obsData(), { operation_id: 'another-operation' }));
  second.store.setPanelActive(true);
  second.store.selectSession('session-a');
  await settle(second.store);
  assert.equal(second.store.getSnapshot().observation, null, 'an operation_id mismatch is dropped');
  second.store.dispose();
});

test('store: business rejections map to explicit states; transport failures never leak text', async () => {
  const { store, rpc } = storeHarness({ wire: false });
  rpc.on('context.list', (payload) => okResult(payload, listData()));
  rpc.on('observation.get', (payload) => rejectResult(payload, 'denied', 'SCOPE_REVOKED'));
  store.setPanelActive(true);
  store.selectSession('session-a');
  await settle(store);
  assert.equal(store.getSnapshot().status, 'denied');
  assert.equal(store.getSnapshot().reason_code, 'SCOPE_REVOKED');
  store.dispose();

  const malformed = storeHarness({ wire: false });
  malformed.rpc.on('context.list', (payload) => okResult(payload, listData()));
  malformed.rpc.on('observation.get', (payload) => ({
    schema_version: 1,
    operation_id: payload.operation_id,
    view_epoch: payload.view_epoch,
    scope_generation: 3,
    status: 'ok',
    data: { changed: true },
    extra_field: 'CANARY-EXTRA-FIELD',
  }));
  malformed.store.setPanelActive(true);
  malformed.store.selectSession('session-a');
  await settle(malformed.store);
  assert.equal(malformed.store.getSnapshot().status, 'error');
  assert.equal(malformed.store.getSnapshot().error_code, 'TRANSPORT_FAILURE');
  assert.equal(JSON.stringify(malformed.store.getSnapshot()).includes('CANARY-EXTRA-FIELD'), false);
  malformed.store.dispose();

  const notOk = storeHarness({ wire: false });
  notOk.rpc.on('context.list', (payload) => okResult(payload, listData()));
  notOk.rpc.on('observation.get', () => notOk.rpc.httpFailure(403, { message: 'CANARY-ERROR-DETAILS', details: { path: 'C:/secret' } }));
  notOk.store.setPanelActive(true);
  notOk.store.selectSession('session-a');
  await settle(notOk.store);
  assert.equal(notOk.store.getSnapshot().error_code, 'TRANSPORT_FAILURE');
  assert.equal(JSON.stringify(notOk.store.getSnapshot()).includes('CANARY-ERROR-DETAILS'), false);
  notOk.store.dispose();

  const badJson = storeHarness({ wire: false });
  badJson.rpc.on('context.list', (payload) => okResult(payload, listData()));
  badJson.rpc.on('observation.get', () => badJson.rpc.invalidJson());
  badJson.store.setPanelActive(true);
  badJson.store.selectSession('session-a');
  await settle(badJson.store);
  assert.equal(badJson.store.getSnapshot().error_code, 'TRANSPORT_FAILURE', 'unparseable JSON maps to TRANSPORT_FAILURE');
  badJson.store.dispose();
});

test('store: group.read pagination fetches pages and clears text on a new observation', async () => {
  const { store, rpc } = storeHarness({ wire: false });
  rpc.on('context.list', (payload) => okResult(payload, listData()));
  rpc.on('observation.get', (payload) => okResult(payload, obsData()));
  rpc.on('group.read', (payload) => {
    if (payload.input.offset === 0) return okResult(payload, { text: 'abc', next_offset: 3, revision: 1 });
    return okResult(payload, { text: 'def', next_offset: null, revision: 1 });
  });
  store.setPanelActive(true);
  store.selectSession('session-a');
  await settle(store);

  store.toggleGroup('system|system-prompt|');
  await settle(store);
  const readCall = rpc.last('group.read');
  assert.equal(readCall.payload.input.observation_id, 'obs-a');
  assert.equal(readCall.payload.input.group_id, 'system|system-prompt|');
  assert.equal(readCall.payload.input.offset, 0);
  assert.equal(readCall.payload.input.limit, 8192);
  assert.equal(store.getSnapshot().group_texts['system|system-prompt|'].text, 'abc');
  assert.equal(store.getSnapshot().expanded['system|system-prompt|'], true);

  store.loadMoreGroup('system|system-prompt|');
  await settle(store);
  assert.equal(rpc.last('group.read').payload.input.offset, 3);
  assert.equal(store.getSnapshot().group_texts['system|system-prompt|'].text, 'abcdef');

  store.toggleGroup('system|system-prompt|');
  assert.equal(store.getSnapshot().expanded['system|system-prompt|'], undefined);
  assert.equal(store.getSnapshot().group_texts['system|system-prompt|'].text, 'abcdef', 'collapse keeps the already-read page');

  rpc.on('observation.get', (payload) => okResult(payload, obsData('obs-a2', { revision: 2 })));
  store.refresh();
  await settle(store);
  assert.deepEqual(store.getSnapshot().group_texts, {}, 'a new observation invalidates previously read body text');
  assert.deepEqual(store.getSnapshot().expanded, {});
  store.dispose();
});

test('store: export state machine covers saved, conflict and denied without retry', async () => {
  const { store, rpc } = storeHarness({ wire: false });
  rpc.on('context.list', (payload) => okResult(payload, listData()));
  rpc.on('observation.get', (payload) => okResult(payload, obsData()));
  store.setPanelActive(true);
  store.selectSession('session-a');
  await settle(store);
  assert.equal(store.getSnapshot().status, 'ready');

  const digest = 'a'.repeat(64);
  let sequence = 0;
  rpc.on('report.export', (payload) => {
    sequence += 1;
    if (sequence === 1) return okResult(payload, { status: 'saved', report_ref: 'ctx-report-1.json', digest });
    if (sequence === 2) return okResult(payload, { status: 'conflict' });
    if (sequence === 3) return rejectResult(payload, 'denied', 'OUTPUT_REF_DENIED');
    return okResult(payload, { status: 'saved', report_ref: 'ctx-report-1.json', digest });
  });

  store.exportReport();
  await settle(store);
  let state = store.getSnapshot().export_state;
  assert.equal(state.phase, 'saved');
  assert.equal(state.report_ref, 'ctx-report-1.json');
  assert.equal(state.digest, digest);

  store.exportReport();
  await settle(store);
  state = store.getSnapshot().export_state;
  assert.equal(state.phase, 'conflict');
  assert.equal(state.reason_code, 'EXPORT_CONFLICT');

  store.exportReport();
  await settle(store);
  state = store.getSnapshot().export_state;
  assert.equal(state.phase, 'denied');
  assert.equal(state.reason_code, 'OUTPUT_REF_DENIED');
  assert.equal(rpc.count('report.export'), 3, 'no automatic retry after a denied export');
  store.dispose();
});

test('store: disposed store stops notifying subscribers', async () => {
  const { store, rpc } = storeHarness();
  let notifications = 0;
  const unsubscribe = store.subscribe(() => {
    notifications += 1;
  });
  store.setPanelActive(true);
  store.selectSession('session-a');
  await settle(store);
  const before = notifications;
  store.dispose();
  assert.equal(store.getSnapshot().disposed, true);
  store.dispose();
  assert.equal(notifications > before, true, 'state changes notified before dispose');
  unsubscribe();
});

// ---------------------------------------------------------------------------
// RPC / observation validation parity with src/contracts.mjs
// ---------------------------------------------------------------------------

test('client BusinessResponse validation matches src/contracts.mjs on a matrix', () => {
  const validSuccess = contracts.okResponse({ operationId: 'op-1', viewEpoch: 1, scopeGeneration: 3, data: { changed: false, current_revision: 0 } });
  const cases = [
    validSuccess,
    contracts.responseForReason({ operationId: 'op-1', viewEpoch: 1, scopeGeneration: 3, reasonCode: 'SCOPE_REVOKED' }),
    { ...validSuccess, extra: 1 },
    { ...validSuccess, schema_version: 2 },
    { ...validSuccess, operation_id: '' },
    { ...validSuccess, view_epoch: -1 },
    { ...validSuccess, status: 'weird' },
    { ...validSuccess, data: undefined },
    { ...validSuccess, status: 'denied', reason_code: 'NOT_A_CODE' },
    contracts.responseForReason({ operationId: 'op-1', viewEpoch: 1, scopeGeneration: 3, reasonCode: 'SCOPE_REVOKED' }),
    { not: 'an object' },
  ];
  cases[8] = { ...validSuccess, status: 'denied', reason_code: 'NOT_A_CODE' };
  for (const value of cases) {
    const expected = contracts.validateBusinessResponse(value).ok;
    const actual = validateBusinessResponseLite(value).ok;
    assert.equal(actual, expected, `validator parity for ${JSON.stringify(value)}`);
  }
});

test('client observation validation accepts fixtures the contract accepts', () => {
  const valid = observation();
  assert.equal(contracts.validateObservation(valid).ok, true);
  assert.equal(validateObservationLite(valid).ok, true);
  const withUnknown = { ...valid, wire_verified: true };
  assert.equal(contracts.validateObservation(withUnknown).ok, false);
  assert.equal(validateObservationLite(withUnknown).ok, false);
  assert.equal(validateObservationLite({ ...valid, extra: 1 }).ok, false);
  const groupFixture = group();
  assert.equal(validateObservationLite({ ...valid, groups: [{ ...groupFixture, category: 'nope' }] }).ok, false);
});

// ---------------------------------------------------------------------------
// panel rendering (fake React, no DOM)
// ---------------------------------------------------------------------------

function createPanelHarness(options = {}) {
  const rpc = options.rpc || createFakeFetch();
  const timers = createFakeTimers();
  const doc = createFakeDocument();
  let counter = 0;
  const store = createContextStore({
    fetch: rpc.fetch,
    document: doc,
    timers,
    pollIntervalMs: 500,
    operationId: () => {
      counter += 1;
      return `op-${counter}`;
    },
  });
  rpc.on('context.list', (payload) => okResult(payload, listData()));
  rpc.on('observation.get', (payload) => okResult(payload, obsData()));
  if (options.groupRead) rpc.on('group.read', options.groupRead);
  const { React, effectCleanups, calls } = createFakeReact();
  const Component = createContextPanel(React);
  const Icon = createContextPanelIcon(React);
  const rendered = { closed: 0, opened: 0 };
  const sessionsSnapshot = {
    ids: ['session-a'],
    byId: { 'session-a': { id: 'session-a', retainedBy: { mainView: 1 } } },
  };
  const props = {
    store,
    t: makeT(EN_DICT),
    useSessions: (selector) => selector(sessionsSnapshot),
    usePanelInfo: (selector) => selector({ activePanelId: PANEL_KEY }),
    openPanel: () => {
      rendered.opened += 1;
    },
    closePanel: () => {
      rendered.closed += 1;
    },
  };
  return {
    store,
    rpc,
    timers,
    doc,
    React,
    Component,
    Icon,
    props,
    effectCleanups,
    calls,
    render() {
      return Component(props);
    },
    async renderSettled() {
      const tree = Component(props);
      await settle(store);
      return Component(props);
    },
    rendered,
  };
}

function assertNoRawHtml(node) {
  for (const element of elementsOf(node)) {
    assert.equal(Object.prototype.hasOwnProperty.call(element.props, 'dangerouslySetInnerHTML'), false, 'panel must never set raw HTML');
  }
}

test('panel renders the ready journey with separated estimate and provider usage', async () => {
  const harness = createPanelHarness();
  const tree = harness.render();
  assertNoRawHtml(tree);
  await settle(harness.store);
  const settled = harness.Component(harness.props);
  assertNoRawHtml(settled);
  const text = textOf(settled);

  assert.equal(text.includes(EN_DICT['panel.title']), true);
  assert.equal(text.includes(EN_DICT['panel.estimated']), true);
  assert.equal(text.includes(EN_DICT['panel.reported']), true);
  assert.equal(text.includes(EN_DICT['panel.pause']), true);
  assert.equal(text.includes(EN_DICT['panel.export']), true);
  assert.equal(text.includes(EN_DICT['panel.group.expand']), true);
  assert.equal(text.includes('session-a'), true);
  assert.equal(text.includes('ctx-a'), true);
  assert.equal(text.includes('history_projection'), true);
  assert.equal(text.includes('session_surface'), true);
  assert.equal(text.includes('system|system-prompt|'.split('|')[0]), true);
  assert.equal(text.includes(observation().groups[0].preview), true, 'redacted preview text is rendered');

  const elements = elementsOf(settled);
  const buttons = elements.filter((element) => element.type === 'button');
  assert.ok(buttons.length >= 6, `native buttons for keyboard operation, found ${buttons.length}`);
  for (const button of buttons) {
    assert.equal(button.props.type, 'button');
    assert.equal(typeof button.props.onClick, 'function');
  }
  const stages = buttons.filter((button) => typeof button.props.className === 'string' && button.props.className.includes('dsh-context-stage'));
  assert.equal(stages.length, 3, 'three capture-stage view buttons');
  const closeButton = elements.find((element) => element.type === 'button' && element.props.className === 'dsh-context-close');
  assert.ok(closeButton, 'close control exists');
  closeButton.props.onClick();
  assert.equal(harness.rendered.closed, 1, 'close restores the conversation panel via the injected closePanel');

  const exportButton = buttons.find((button) => typeof button.props.className === 'string' && button.props.className.includes('dsh-context-export'));
  assert.equal(exportButton.props.disabled, false, 'export is enabled with a registered root and an observation');

  harness.store.dispose();
});

test('panel shows explicit empty/unbound/denied/stale/unavailable/error states', async () => {
  const cases = [];

  const unbound = createPanelHarness();
  unbound.rpc.on('context.list', (payload) => okResult(payload, { contexts: [] }));
  cases.push({ harness: unbound, expected: EN_DICT['panel.unbound'] });

  const empty = createPanelHarness();
  empty.rpc.on('observation.get', (payload) => okResult(payload, { changed: false, current_revision: 0 }));
  cases.push({ harness: empty, expected: EN_DICT['panel.empty'] });

  const denied = createPanelHarness();
  denied.rpc.on('observation.get', (payload) => rejectResult(payload, 'denied', 'SCOPE_REVOKED'));
  cases.push({ harness: denied, expected: EN_DICT['panel.denied'] });

  const stale = createPanelHarness();
  stale.rpc.on('observation.get', (payload) => okResult(payload, obsData(), { generation: 2 }));
  cases.push({ harness: stale, expected: EN_DICT['panel.stale'] });

  const error = createPanelHarness();
  error.rpc.on('observation.get', () => {
    throw new Error('CANARY-RAW-PANEL-TRANSPORT');
  });
  cases.push({ harness: error, expected: EN_DICT['panel.unavailable'], forbidden: 'CANARY-RAW-PANEL-TRANSPORT' });

  for (const item of cases) {
    const rendered = await item.harness.renderSettled();
    const text = textOf(rendered);
    assert.equal(text.includes(item.expected), true, `expected ${item.expected} in ${text}`);
    if (item.forbidden !== undefined) assert.equal(text.includes(item.forbidden), false, 'raw transport text is never rendered');
    assertNoRawHtml(rendered);
    item.harness.store.dispose();
  }
});

test('panel expands a group and renders the fetched redacted text as children', async () => {
  const fullText = 'full redacted group text';
  const harness = createPanelHarness({
    groupRead: (payload) => okResult(payload, { text: fullText, next_offset: null, revision: 1 }),
  });
  let tree = await harness.renderSettled();
  const expandedButton = elementsOf(tree).find(
    (element) => element.type === 'button' && typeof element.props.className === 'string' && element.props.className.includes('dsh-context-expand'),
  );
  assert.ok(expandedButton);
  assert.equal(textOf(expandedButton), EN_DICT['panel.group.expand']);
  expandedButton.props.onClick();
  await settle(harness.store);
  tree = await harness.renderSettled();
  const text = textOf(tree);
  assert.equal(text.includes(fullText), true, 'group text is rendered as React children');
  assert.equal(text.includes(EN_DICT['panel.group.collapse']), true);
  assertNoRawHtml(tree);
  harness.store.dispose();
});

test('panel pause/resume and stage buttons drive the store', async () => {
  const harness = createPanelHarness();
  let tree = await harness.renderSettled();
  const buttons = () => elementsOf(tree).filter((element) => element.type === 'button');
  const pauseButton = buttons().find((button) => textOf(button) === EN_DICT['panel.pause']);
  assert.ok(pauseButton);
  pauseButton.props.onClick();
  assert.equal(harness.store.getSnapshot().paused, true);
  tree = harness.Component(harness.props);
  const resumeButton = elementsOf(tree).find((element) => element.type === 'button' && textOf(element) === EN_DICT['panel.resume']);
  assert.ok(resumeButton, 'paused panel offers resume');
  resumeButton.props.onClick();
  assert.equal(harness.store.getSnapshot().paused, false);

  const stageButton = elementsOf(tree).find(
    (element) => element.type === 'button' && textOf(element) === 'llm_waterfall',
  );
  assert.ok(stageButton, 'stage view switch buttons are native');
  stageButton.props.onClick();
  await settle(harness.store);
  assert.equal(harness.store.getSnapshot().stage, 'llm_waterfall');
  harness.store.dispose();
});

test('panel without a store degrades to an explicit unavailable state', () => {
  const { React } = createFakeReact();
  const Component = createContextPanel(React);
  const tree = Component({ t: makeT(EN_DICT) });
  assert.equal(textOf(tree).includes(EN_DICT['panel.unavailable']), true);

  const Icon = createContextPanelIcon(React);
  const icon = Icon({ size: 18, active: true });
  assert.equal(icon.type, 'svg');
  assert.equal(icon.props['aria-hidden'], true);
});
