#!/usr/bin/env node
/**
 * 07 context-mng: rc.5 installed-bytes probe.
 *
 * Read-only, offline probe over the INSTALLED DeepSeek Harness archive:
 *
 *  1. parse the asar header without extracting the archive subtree;
 *  2. verify the pinned SHA256s listed in docs/compatibility.md §1 (and the
 *     app.asar digest pinned in docs/software-design.md §2) against the real
 *     installed bytes;
 *  3. extract ONLY the package closure needed by this probe (dsh-session,
 *     dsh-llm, cordis + their runtime dependencies) into a temp directory;
 *     asar entries marked `unpacked` are read from `<asar>.unpacked/...`;
 *  4. run probes against those real bytes:
 *       (a) @deepseek-ai/dsh-session: real Session + SessionStore,
 *           deriveMessages() frozen-snapshot immutability and event delivery;
 *       (b) @deepseek-ai/cordis + @deepseek-ai/dsh-llm: real Context,
 *           LlmRuntime, real `ctx.waterfall(this, 'llm/stream', options, next)`
 *           dispatch through this plugin's transparent middleware with a fake
 *           async-iterable adapter — chunk identity/order/count unchanged,
 *           exactly one next(), usage captured, main-request error passthrough,
 *           options unchanged;
 *       (c) this plugin's own capture layer over a real live SessionStore.
 *
 * Evidence layers are reported honestly: everything here is "installed bytes"
 * (plus workspace plugin modules); a "full host" AgentLoop / GUI / network
 * journey is NOT run and is recorded as not_run.
 *
 * Usage:
 *   node tools/probe-host.mjs --asar "E:/dsh/resources/app.asar"
 *        [--out <evidence.json>] [--keep]
 *
 * The JSON result is written to --out (default: a file under the OS temp dir)
 * and a compact summary is printed to stdout. Exit code 0 = every executed
 * check passed; 1 = one or more checks failed; 2 = probe could not start.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = new URL('..', import.meta.url);
const COMPAT_DOC = new URL('../docs/compatibility.md', import.meta.url);
const DESIGN_DOC = new URL('../docs/software-design.md', import.meta.url);

const ROOT_PACKAGES = Object.freeze(['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-llm', '@deepseek-ai/cordis']);
const SKIP_EXTENSIONS = new Set(['.node', '.dll', '.so', '.dylib', '.exe', '.wasm', '.onnx', '.bin', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.wav', '.zip', '.gz', '.tgz', '.pdf']);
const MAX_EXTRACT_BYTES = 16 * 1024 * 1024;
const PINNED_DOC_FILES = Object.freeze([
  'dsh-client-connection/lib/index.js',
  'dsh-client-connection/lib/client.browser.js',
  'dsh-client-ui-layout/lib/client.js',
  'dsh-client-ui-renderer/lib/client.js',
  'dsh-session/lib/index.js',
]);
const PACKAGE_PREFIX = 'dsh/node_modules/@deepseek-ai/';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { asar: null, out: null, keep: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--asar') { options.asar = argv[index + 1] ?? null; index += 1; }
    else if (arg === '--out') { options.out = argv[index + 1] ?? null; index += 1; }
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

const USAGE = [
  'Usage: node tools/probe-host.mjs --asar "<installed>/resources/app.asar" [--out <evidence.json>] [--keep]',
].join('\n');

// ---------------------------------------------------------------------------
// asar (read-only; Electron Pickle header)
// ---------------------------------------------------------------------------

function openAsar(asarPath) {
  const stat = fs.statSync(asarPath);
  if (!stat.isFile()) throw new Error(`asar path is not a file: ${asarPath}`);
  const fd = fs.openSync(asarPath, 'r');
  try {
    const prelude = Buffer.alloc(8);
    if (fs.readSync(fd, prelude, 0, 8, 0) !== 8) throw new Error('asar prelude is truncated');
    const headerSize = prelude.readUInt32LE(4);
    if (headerSize < 8 || headerSize > 64 * 1024 * 1024 || headerSize + 8 > stat.size) {
      throw new Error(`implausible asar header size: ${headerSize}`);
    }
    const headerPickle = Buffer.alloc(headerSize);
    if (fs.readSync(fd, headerPickle, 0, headerSize, 8) !== headerSize) throw new Error('asar header is truncated');
    const jsonSize = headerPickle.readUInt32LE(4);
    if (jsonSize <= 0 || jsonSize + 8 > headerSize) throw new Error(`implausible asar JSON size: ${jsonSize}`);
    const jsonText = headerPickle.subarray(8, 8 + jsonSize).toString('utf8');
    const header = JSON.parse(jsonText);
    if (header === null || typeof header !== 'object' || header.files === undefined) {
      throw new Error('asar header does not contain a file table');
    }
    return { fd, header, headerSize, dataStart: 8 + headerSize, fileSize: stat.size, asarPath };
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* nothing to close */ }
    throw error;
  }
}

function resolveAsarNode(asar, relPath) {
  const segments = String(relPath).split('/').filter((segment) => segment.length > 0);
  let node = { files: asar.header.files };
  for (const segment of segments) {
    if (node === null || typeof node !== 'object' || node.files === undefined) return null;
    node = Object.hasOwn(node.files, segment) ? node.files[segment] : null;
    if (node === null) return null;
  }
  return node;
}

function walkAsar(node, prefix, visit) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const relPath = prefix === '' ? name : `${prefix}/${name}`;
    if (child.files !== undefined) walkAsar(child, relPath, visit);
    else visit(relPath, child);
  }
}

function readAsarEntry(asar, relPath, node) {
  const entry = node ?? resolveAsarNode(asar, relPath);
  if (entry === null) throw new Error(`asar entry missing: ${relPath}`);
  if (entry.files !== undefined) throw new Error(`asar entry is a directory: ${relPath}`);
  if (entry.unpacked === true) {
    // Electron keeps unpacked payloads beside the archive, mirroring the
    // archive-internal path; the data region offset is meaningless for them.
    const unpackedPath = path.join(asar.asarPath + '.unpacked', ...relPath.split('/'));
    return fs.readFileSync(unpackedPath);
  }
  const offset = Number(entry.offset ?? 0);
  const size = Number(entry.size ?? 0);
  if (offset < 0 || size < 0 || asar.dataStart + offset + size > asar.fileSize) {
    throw new Error(`asar entry range out of bounds: ${relPath}`);
  }
  const buffer = Buffer.alloc(size);
  if (size > 0 && fs.readSync(asar.fd, buffer, 0, size, asar.dataStart + offset) !== size) {
    throw new Error(`asar entry read truncated: ${relPath}`);
  }
  return buffer;
}

function countAsarFiles(asar) {
  let files = 0;
  let unpacked = 0;
  walkAsar({ files: asar.header.files }, '', (_relPath, node) => {
    files += 1;
    if (node.unpacked === true) unpacked += 1;
  });
  return { files, unpacked };
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// ---------------------------------------------------------------------------
// docs-pinned expectations
// ---------------------------------------------------------------------------

/** Parse `| \`some/path.js\` | \`<64 hex>\` |` rows from docs/compatibility.md §1. */
function readCompatibilityPins() {
  const text = fs.readFileSync(COMPAT_DOC, 'utf8');
  const section = text.split('## 1.')[1] ?? text;
  const pins = new Map();
  for (const match of section.matchAll(/`(dsh-[^`]+?\.js)`\s*\|\s*`([0-9a-f]{64})`/g)) {
    pins.set(match[1], match[2]);
  }
  return pins;
}

/** Parse the app.asar digest pinned in docs/software-design.md §2. */
function readAsarDigestPin() {
  const text = fs.readFileSync(DESIGN_DOC, 'utf8');
  const match = text.match(/app\.asar`?\s*SHA256\s*`([0-9a-f]{64})`/);
  return match === null ? null : match[1];
}

// ---------------------------------------------------------------------------
// extraction of the needed package closure
// ---------------------------------------------------------------------------

function readPackageJson(asar, spec) {
  const relPath = `dsh/node_modules/${spec}/package.json`;
  const node = resolveAsarNode(asar, relPath);
  if (node === null) return null;
  return JSON.parse(readAsarEntry(asar, relPath, node).toString('utf8'));
}

function resolvePackageEntryFile(packageDir) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  const dot = packageJson.exports?.['.'];
  const relative = typeof dot === 'string'
    ? dot
    : (dot?.default ?? dot?.import ?? dot?.node ?? packageJson.main);
  if (typeof relative !== 'string') throw new Error(`${packageJson.name}: cannot resolve package entry`);
  return path.join(packageDir, relative);
}

function computeClosure(asar) {
  const versions = new Map();
  const queue = [...ROOT_PACKAGES];
  const missing = [];
  while (queue.length > 0) {
    const spec = queue.shift();
    if (versions.has(spec)) continue;
    const packageJson = readPackageJson(asar, spec);
    if (packageJson === null) { missing.push(spec); continue; }
    versions.set(spec, packageJson.version ?? 'unknown');
    const dependencies = { ...(packageJson.dependencies ?? {}) };
    for (const [name, range] of Object.entries(packageJson.peerDependencies ?? {})) {
      if (packageJson.peerDependenciesMeta?.[name]?.optional === true) continue;
      dependencies[name] = range;
    }
    for (const name of Object.keys(dependencies)) queue.push(name);
  }
  return { versions, missing };
}

function extractClosure(asar, extractRoot, versions, counters) {
  for (const spec of versions.keys()) {
    const packageRel = `dsh/node_modules/${spec}`;
    const packageNode = resolveAsarNode(asar, packageRel);
    if (packageNode === null || packageNode.files === undefined) throw new Error(`asar package directory missing: ${spec}`);
    walkAsar(packageNode, packageRel, (relPath, node) => {
      const extension = path.extname(relPath).toLowerCase();
      if (SKIP_EXTENSIONS.has(extension) || Number(node.size ?? 0) > MAX_EXTRACT_BYTES) {
        counters.skipped += 1;
        return;
      }
      let bytes;
      try {
        bytes = readAsarEntry(asar, relPath, node);
      } catch (error) {
        counters.skipped += 1;
        counters.unreadable.push(`${relPath}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      const destination = path.join(extractRoot, ...relPath.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, bytes);
      counters.extracted += 1;
      counters.bytes += bytes.length;
      if (node.unpacked === true) counters.from_unpacked += 1;
    });
  }
  const packageJsonNode = resolveAsarNode(asar, 'dsh/package.json');
  if (packageJsonNode !== null) {
    const destination = path.join(extractRoot, 'dsh', 'package.json');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, readAsarEntry(asar, 'dsh/package.json', packageJsonNode));
  }
}

// ---------------------------------------------------------------------------
// probe bookkeeping
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createRecorder() {
  const checks = [];
  return {
    checks,
    add(id, layer, description, fn) {
      try {
        const detail = fn();
        checks.push({ id, layer, description, status: 'pass', detail: detail === undefined ? null : detail });
        return true;
      } catch (error) {
        checks.push({ id, layer, description, status: 'fail', detail: String(error instanceof Error ? error.stack ?? error.message : error).slice(0, 1200) });
        return false;
      }
    },
    async addAsync(id, layer, description, fn) {
      try {
        const detail = await fn();
        checks.push({ id, layer, description, status: 'pass', detail: detail === undefined ? null : detail });
        return true;
      } catch (error) {
        checks.push({ id, layer, description, status: 'fail', detail: String(error instanceof Error ? error.stack ?? error.message : error).slice(0, 1200) });
        return false;
      }
    },
    skip(id, layer, description, reason) {
      checks.push({ id, layer, description, status: 'skip', detail: reason });
    },
  };
}

function summarize(checks) {
  const summary = { pass: 0, fail: 0, skip: 0, total: checks.length };
  for (const check of checks) summary[check.status] += 1;
  return summary;
}

function layerStatus(checks, layer) {
  const belonging = checks.filter((check) => check.layer === layer);
  const failed = belonging.filter((check) => check.status === 'fail');
  return {
    layer,
    checks: belonging.length,
    pass: belonging.filter((check) => check.status === 'pass').length,
    fail: failed.length,
    skip: belonging.filter((check) => check.status === 'skip').length,
    status: failed.length > 0 ? 'fail' : (belonging.length === 0 ? 'not_run' : 'pass'),
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help || options.asar === null) {
    process.stdout.write(`${USAGE}\n`);
    return options.help ? 0 : 2;
  }
  const asarPath = path.resolve(options.asar);
  const startedAt = new Date().toISOString();
  const recorder = createRecorder();
  const result = {
    schema_version: 1,
    tool: 'tools/probe-host.mjs',
    command: ['node', 'tools/probe-host.mjs', '--asar', options.asar, ...(options.out === null ? [] : ['--out', options.out])].join(' '),
    started_at: startedAt,
    finished_at: null,
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      tmpdir: os.tmpdir(),
    },
    host: {
      asar_path: asarPath,
      asar_bytes: null,
      asar_sha256: null,
      package_version: null,
      header_bytes: null,
      data_start: null,
      entry_count: null,
      unpacked_entry_count: null,
    },
    pins: {
      source: 'docs/compatibility.md §1',
      expected: {},
      actual: {},
      asar_sha256_expected: null,
    },
    closure: {
      roots: [...ROOT_PACKAGES],
      packages: [],
      missing_packages: [],
      extracted_files: 0,
      extracted_bytes: 0,
      skipped_files: 0,
      from_unpacked: 0,
      unreadable: [],
      temp_dir: null,
    },
    checks: recorder.checks,
    layers: {},
    summary: null,
    limitations: [
      'Installed-bytes layer only: the probe imports the real 0.2.1-rc.5 package bytes extracted from app.asar and drives the real cordis waterfall / LlmRuntime dispatch with a fake provider adapter. It does NOT boot a full rc.5 Host/AgentLoop turn, does not call a real model, and does not exercise the GUI/Chromium journey.',
      'No network and no credentials: the provider adapter is a synthetic async iterable; usage values are synthetic.',
      'Session probe uses synthetic sessions created with the installed Session/SessionStore code; no user profile or real conversation data is read.',
      'waterfall observation is request_observed/wire_verified=false by design: listener ordering downstream of this plugin is not part of this probe and could still change the provider wire request.',
      'Binary payloads (.node/.dll/.wasm/...) are not extracted into the temp closure; the imported JS graph does not require them. If a future installed build loads one at import time, that import check would fail rather than silently pass.',
    ],
    ok: false,
  };

  if (!fs.existsSync(asarPath)) {
    result.host.error = `asar not found: ${asarPath}`;
    result.summary = summarize(recorder.checks);
    result.finished_at = new Date().toISOString();
    await writeResult(result, options.out);
    return 2;
  }

  // ---- 1. asar header + host identity + pinned digests ---------------------
  let asar = null;
  const counters = { extracted: 0, bytes: 0, skipped: 0, from_unpacked: 0, unreadable: [] };
  let extractRoot = null;
  try {
    asar = openAsar(asarPath);
    const entryCounts = countAsarFiles(asar);
    result.host.asar_bytes = asar.fileSize;
    result.host.header_bytes = asar.headerSize;
    result.host.data_start = asar.dataStart;
    result.host.entry_count = entryCounts.files;
    result.host.unpacked_entry_count = entryCounts.unpacked;

    recorder.add('asar.header_parsed', 'installed_bytes', 'asar header parses as JSON and the data region starts after it', () => ({
      header_bytes: asar.headerSize,
      data_start: asar.dataStart,
      file_bytes: asar.fileSize,
      entries: entryCounts.files,
      unpacked_entries: entryCounts.unpacked,
    }));

    recorder.add('asar.sha256_matches_design_pin', 'installed_bytes', 'app.asar SHA256 matches the digest pinned in docs/software-design.md §2', () => {
      const expected = readAsarDigestPin();
      assert.ok(expected !== null, 'docs/software-design.md does not pin an app.asar SHA256');
      result.pins.asar_sha256_expected = expected;
      const actual = sha256(fs.readFileSync(asarPath));
      result.host.asar_sha256 = actual;
      result.pins.actual['app.asar'] = actual;
      assert.equal(actual, expected);
      return actual;
    });

    recorder.add('host.package_version', 'installed_bytes', 'installed dsh/package.json declares 0.2.1-rc.5', () => {
      const packageJson = JSON.parse(readAsarEntry(asar, 'dsh/package.json').toString('utf8'));
      result.host.package_version = packageJson.version;
      assert.equal(packageJson.version, '0.2.1-rc.5');
      return { name: packageJson.name, version: packageJson.version };
    });

    const compatibilityPins = readCompatibilityPins();
    recorder.add('pins.compatibility_doc_parsed', 'installed_bytes', 'docs/compatibility.md §1 lists the five pinned files', () => {
      for (const pinned of PINNED_DOC_FILES) assert.ok(compatibilityPins.has(pinned), `compatibility.md is missing pin for ${pinned}`);
      return Object.fromEntries(compatibilityPins);
    });

    for (const pinnedFile of PINNED_DOC_FILES) {
      const relPath = `${PACKAGE_PREFIX}${pinnedFile}`;
      recorder.add(`pins.sha256:${pinnedFile}`, 'installed_bytes', `SHA256 of ${pinnedFile} matches docs/compatibility.md §1`, () => {
        const expected = compatibilityPins.get(pinnedFile);
        assert.ok(expected !== undefined, `docs/compatibility.md §1 has no digest for ${pinnedFile}`);
        const node = resolveAsarNode(asar, relPath);
        assert.ok(node !== null && node.files === undefined, `installed asar has no file ${relPath}`);
        const bytes = readAsarEntry(asar, relPath, node);
        const actual = sha256(bytes);
        result.pins.expected[pinnedFile] = expected;
        result.pins.actual[pinnedFile] = actual;
        assert.equal(actual, expected);
        return { bytes: bytes.length, unpacked: node.unpacked === true };
      });
    }

    // ---- 2. closure extraction -------------------------------------------
    const closure = computeClosure(asar);
    extractRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-07-probe-'));
    result.closure.temp_dir = extractRoot;
    result.closure.packages = [...closure.versions.entries()].map(([name, version]) => ({ name, version }));
    result.closure.missing_packages = closure.missing;
    extractClosure(asar, extractRoot, closure.versions, counters);
    result.closure.extracted_files = counters.extracted;
    result.closure.extracted_bytes = counters.bytes;
    result.closure.skipped_files = counters.skipped;
    result.closure.from_unpacked = counters.from_unpacked;
    result.closure.unreadable = counters.unreadable;

    recorder.add('closure.complete', 'installed_bytes', 'the dsh-session/dsh-llm/cordis dependency closure is present in the installed archive', () => {
      assert.deepEqual(closure.missing, []);
      assert.ok(closure.versions.size >= 10, `unexpected closure size ${closure.versions.size}`);
      for (const root of ROOT_PACKAGES) assert.ok(closure.versions.has(root), `closure is missing root package ${root}`);
      return { packages: closure.versions.size };
    });

    recorder.add('closure.extracted', 'installed_bytes', 'needed packages extracted to a temp dir; unpacked entries copied from app.asar.unpacked', () => {
      assert.ok(counters.extracted > 0);
      assert.deepEqual(counters.unreadable, []);
      const sessionEntry = resolvePackageEntryFile(path.join(extractRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-session'));
      const expected = compatibilityPins.get('dsh-session/lib/index.js');
      const actual = sha256(fs.readFileSync(sessionEntry));
      assert.equal(actual, expected, 'extracted dsh-session bytes differ from the pinned installed bytes');
      return {
        extracted_files: counters.extracted,
        extracted_bytes: counters.bytes,
        skipped_files: counters.skipped,
        from_unpacked: counters.from_unpacked,
        session_lib_sha256: actual,
      };
    });

    // ---- 3. import real installed package bytes --------------------------
    const sessionEntry = resolvePackageEntryFile(path.join(extractRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-session'));
    const llmEntry = resolvePackageEntryFile(path.join(extractRoot, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-llm'));
    const cordisEntry = resolvePackageEntryFile(path.join(extractRoot, 'dsh', 'node_modules', '@deepseek-ai', 'cordis'));
    const sessionModule = await import(pathToFileURL(sessionEntry).href);
    const llmModule = await import(pathToFileURL(llmEntry).href);
    const cordisModule = await import(pathToFileURL(cordisEntry).href);

    recorder.add('import.real_installed_bytes', 'installed_bytes', 'real installed dsh-session/dsh-llm/cordis modules import from the extracted closure', () => {
      assert.equal(typeof sessionModule.Session, 'function');
      assert.equal(typeof sessionModule.SessionStore, 'function');
      assert.equal(typeof sessionModule.default, 'function');
      assert.equal(typeof llmModule.LlmRuntime, 'function');
      assert.equal(typeof llmModule.LlmAdapter, 'function');
      assert.equal(typeof cordisModule.Context, 'function');
      return {
        session_entry: path.relative(extractRoot, sessionEntry),
        llm_entry: path.relative(extractRoot, llmEntry),
        cordis_entry: path.relative(extractRoot, cordisEntry),
      };
    });

    const { Session, SessionStore } = sessionModule;
    const { Context } = cordisModule;
    const { LlmRuntime, LlmAdapter, createUserMessage } = llmModule;

    // ---- 4a. real Session deriveMessages frozen snapshot ------------------
    recorder.add('session.detached_create_and_append', 'installed_bytes', 'real Session.create/append accepts a real rc.5 message event', () => {
      const session = Session.create('probe-detached-session');
      session.append('user/message', {
        id: 'probe-msg-1',
        role: 'user',
        content: [{ type: 'text', text: 'hello installed bytes' }],
        source: { kind: 'user' },
      }, { surfaceOp: 'append' });
      assert.equal(session.seq, 1);
      assert.equal(session.surface.contentGeneration, 0, 'plain appends do not bump contentGeneration');
      return { id: session.id, seq: session.seq, content_generation: session.surface.contentGeneration };
    });

    let detachedSession = null;
    recorder.add('session.deriveMessages_frozen', 'installed_bytes', 'deriveMessages() returns a new array of shared deep-frozen messages', () => {
      detachedSession = Session.create('probe-frozen-session');
      const message = {
        id: 'probe-msg-frozen',
        role: 'user',
        content: [{ type: 'text', text: 'immutable content' }],
        source: { kind: 'user' },
      };
      detachedSession.append('user/message', message, { surfaceOp: 'append' });
      const first = detachedSession.deriveMessages();
      const second = detachedSession.deriveMessages();
      assert.ok(Array.isArray(first));
      assert.notEqual(first, second, 'each call returns a fresh array');
      assert.equal(first[0], second[0], 'message objects are shared, not copied');
      // rc.5 returns a caller-owned array of shared deep-frozen messages.
      assert.equal(Object.isFrozen(first), false, 'the returned array is a fresh caller-owned snapshot');
      assert.equal(Object.isFrozen(first[0]), true);
      assert.equal(Object.isFrozen(first[0].content), true);
      assert.equal(Object.isFrozen(first[0].content[0]), true);
      return { messages: first.length, keys: Object.keys(first[0]).sort() };
    });

    recorder.add('session.deriveMessages_mutation_rejected', 'installed_bytes', 'mutating a derived message throws and leaves the session log untouched', () => {
      assert.ok(detachedSession !== null);
      const derived = detachedSession.deriveMessages();
      assert.throws(() => { derived[0].content[0].text = 'mutated'; }, TypeError, 'frozen content block accepted a write');
      assert.throws(() => { derived[0].id = 'other'; }, TypeError, 'frozen message accepted a write');
      // The array itself is a fresh caller-owned snapshot: growing it cannot
      // reach the session (the log is append-only and never aliases it).
      derived.push({});
      assert.equal(detachedSession.log[0].data.content[0].text, 'immutable content');
      assert.equal(detachedSession.deriveMessages().length, 1);
      return { log_messages: detachedSession.log.length };
    });

    recorder.add('session.deriveMessages_snapshot_stability', 'installed_bytes', 'later appends never grow or mutate an earlier derived snapshot', () => {
      assert.ok(detachedSession !== null);
      const before = detachedSession.deriveMessages();
      detachedSession.append('assistant/message', {
        message: {
          id: 'probe-msg-assistant',
          role: 'assistant',
          content: [{ type: 'text', text: 'answer' }],
          source: { kind: 'model', provider: 'probe', model: 'probe' },
        },
      }, { surfaceOp: 'append' });
      const after = detachedSession.deriveMessages();
      assert.equal(before.length, 1, 'old snapshot length does not change');
      assert.equal(after.length, 2);
      assert.equal(after[0], before[0], 'unchanged message identity is preserved');
      assert.equal(Object.isFrozen(after[1]), true);
      return { before: before.length, after: after.length, seq: detachedSession.seq };
    });

    // ---- 4b. real SessionStore + events + capture layer --------------------
    const liveCtx = new Context();
    const liveSessions = new SessionStore(liveCtx);
    const liveEvents = [];
    liveCtx.on('session/event', (session, event) => liveEvents.push({ session: session.id, seq: event.seq, type: event.type }));
    const liveSession = liveSessions.create('probe-live-session', { meta: { cwd: 'E:/dsh/plugin/07-context-management' } });
    liveSession.append('user/message', {
      id: 'probe-live-msg-1',
      role: 'user',
      content: [{ type: 'text', text: 'live surface content' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' });

    recorder.add('session.store_and_event_dispatch', 'installed_bytes', 'real SessionStore publishes session/event through the real cordis Context', () => {
      assert.ok(liveEvents.length >= 1, 'no session/event was dispatched');
      assert.equal(liveEvents.at(-1).session, 'probe-live-session');
      assert.equal(liveEvents.at(-1).type, 'user/message');
      assert.equal(typeof liveSessions.get('probe-live-session'), 'object');
      assert.equal(liveSessions.list().length, 1);
      assert.equal(liveSession.seq, 1);
      assert.equal(liveSession.surface.contentGeneration, 0);
      return { events: liveEvents.length, seq: liveSession.seq };
    });

    recorder.add('session.deriveMessages_live_frozen', 'installed_bytes', 'live SessionStore session deriveMessages() is frozen too', () => {
      const derived = liveSession.deriveMessages();
      assert.equal(Object.isFrozen(derived[0]), true);
      assert.equal(Object.isFrozen(derived[0].content[0]), true);
      assert.throws(() => { derived[0].content[0].text = 'x'; }, TypeError);
      return { messages: derived.length };
    });

    // Workspace plugin modules (not Host bytes): they are driven against the
    // real bytes above so the adapter/observation seam is exercised end-to-end.
    const pluginHostModule = await import(new URL('../src/host-rc5.mjs', import.meta.url).href);
    const pluginCaptureModule = await import(new URL('../src/capture.mjs', import.meta.url).href);
    const pluginObservationsModule = await import(new URL('../src/observations.mjs', import.meta.url).href);
    const pluginAccessModule = await import(new URL('../src/access.mjs', import.meta.url).href);
    const pluginRedactModule = await import(new URL('../src/redact.mjs', import.meta.url).href);
    const contracts = await import(new URL('../src/contracts.mjs', import.meta.url).href);

    const probeScopeDigest = contracts.sha256Hex('probe-scope');
    const liveBinding = {
      context_ref: 'probe-context',
      session_ref: 'probe-live-session',
      scope: { scope_id: 'probe-scope', generation: 1, identity_digest: probeScopeDigest },
      read: true,
      export_root_refs: [],
      active: true,
    };
    const liveAccess = pluginAccessModule.createAccessRegistry({
      registry: { schema_version: 1, revision: 1, bindings: [liveBinding], export_roots: [] },
    });
    const liveStore = pluginObservationsModule.createObservationStore({ limits: contracts.LIMITS, clock: () => new Date() });
    const liveHost = pluginHostModule.createRc5Host(liveCtx);
    const liveCapture = pluginCaptureModule.createCapture({
      host: liveHost,
      access: liveAccess,
      store: liveStore,
      redactor: pluginRedactModule.createRedactor({ policyRevision: contracts.REDACTION_POLICY_REVISION }),
      policy: { redactionPolicyRevision: contracts.REDACTION_POLICY_REVISION },
      clock: () => new Date(),
      limits: contracts.LIMITS,
      config: { autoSampleSurface: true, requestObservation: true, agentPreStep: true, coalesceWindowMs: 10, maxRefreshHz: 20 },
      logger: liveCtx.logger,
    });

    recorder.add('capture.surface_read_real_session', 'installed_bytes', 'this plugin reads a real live session surface through the installed Session bytes', () => {
      const surface = liveHost.readSurface(liveSession);
      assert.ok(Array.isArray(surface.messages) && surface.messages.length === 1);
      assert.equal(surface.last_event_seq, 1);
      assert.equal(surface.surface_generation, 0);
      assert.equal(surface.header.id, 'probe-live-session');
      assert.equal(surface.header.cwd, 'E:/dsh/plugin/07-context-management');
      assert.ok(Array.isArray(surface.tool_definitions));
      assert.equal(Object.isFrozen(surface.messages[0]), true);
      return { messages: surface.messages.length, last_event_seq: surface.last_event_seq, header: surface.header };
    });

    let capturedObservation = null;
    await recorder.addAsync('capture.observation_real_session', 'installed_bytes', 'captureSurface produces a contract-valid history projection with a stable boundary', async () => {
      const captured = await liveCapture.captureSurface({ binding: liveBinding, stage: 'session_surface' });
      assert.equal(captured.status, 'ok', JSON.stringify(captured));
      capturedObservation = captured.observation;
      const validation = contracts.validateObservation(capturedObservation);
      assert.equal(validation.ok, true, JSON.stringify(validation.errors));
      assert.equal(capturedObservation.capture_stage, 'session_surface');
      assert.equal(capturedObservation.fidelity, 'history_projection');
      assert.equal(capturedObservation.wire_verified, false);
      assert.equal(capturedObservation.boundary.session_ref, 'probe-live-session');
      assert.equal(capturedObservation.boundary.last_event_seq, liveSession.seq);
      assert.equal(capturedObservation.boundary.surface_generation, liveSession.surface.contentGeneration);
      assert.ok(capturedObservation.groups.length >= 1);
      assert.match(capturedObservation.observed_digest, /^[0-9a-f]{64}$/);
      assert.equal(liveStore.getLatest('probe-live-session', 'session_surface').revision, capturedObservation.revision);
      return { revision: capturedObservation.revision, groups: capturedObservation.groups.length, boundary: capturedObservation.boundary };
    });

    await recorder.addAsync('capture.group_read_real_session', 'installed_bytes', 'readGroupTexts re-reads the live real session and returns redacted group text', async () => {
      assert.ok(capturedObservation !== null, 'no observation was captured');
      const result = await liveCapture.readGroupTexts({ binding: liveBinding, observation: capturedObservation });
      assert.equal(result.status, 'ok', JSON.stringify(result));
      assert.ok(result.groups instanceof Map && result.groups.size >= 1);
      const text = [...result.groups.values()].map((group) => group.text).join('');
      assert.ok(text.includes('live surface content'), `group text missing expected content: ${text.slice(0, 120)}`);
      return { groups: result.groups.size };
    });

    await recorder.addAsync('capture.event_coalescing_real_dispatch', 'installed_bytes', 'real session/event dispatch triggers one coalesced background sample and a new revision', async () => {
      liveCapture.install();
      const revisionBefore = capturedObservation.revision;
      liveSession.append('user/message', {
        id: 'probe-live-msg-2',
        role: 'user',
        content: [{ type: 'text', text: 'second live message' }],
        source: { kind: 'user' },
      }, { surfaceOp: 'append' });
      await sleep(150);
      const latest = liveStore.getLatest('probe-live-session', 'session_surface');
      assert.ok(latest !== null, 'no background observation after a real session/event');
      assert.ok(latest.revision > revisionBefore, 'the new event must produce a newer revision');
      assert.equal(latest.observation.boundary.last_event_seq, liveSession.seq);
      const validation = contracts.validateObservation(latest.observation);
      assert.equal(validation.ok, true, JSON.stringify(validation.errors));
      return { revision: latest.revision, last_event_seq: latest.observation.boundary.last_event_seq };
    });

    // ---- 4c. real cordis + dsh-llm waterfall through our middleware -------
    const llmCtx = new Context();
    const llmSessions = new SessionStore(llmCtx);
    const llmSession = llmSessions.create('probe-llm-session');
    const llm = new LlmRuntime(llmCtx);

    const llmBinding = {
      context_ref: 'probe-llm-context',
      session_ref: 'probe-llm-session',
      scope: { scope_id: 'probe-scope', generation: 1, identity_digest: probeScopeDigest },
      read: true,
      export_root_refs: [],
      active: true,
    };
    const llmAccess = pluginAccessModule.createAccessRegistry({
      registry: { schema_version: 1, revision: 1, bindings: [llmBinding], export_roots: [] },
    });
    const llmStore = pluginObservationsModule.createObservationStore({ limits: contracts.LIMITS, clock: () => new Date() });
    const llmHost = pluginHostModule.createRc5Host(llmCtx);
    const llmCapture = pluginCaptureModule.createCapture({
      host: llmHost,
      access: llmAccess,
      store: llmStore,
      redactor: pluginRedactModule.createRedactor({ policyRevision: contracts.REDACTION_POLICY_REVISION }),
      policy: { redactionPolicyRevision: contracts.REDACTION_POLICY_REVISION },
      clock: () => new Date(),
      limits: contracts.LIMITS,
      config: { autoSampleSurface: true, requestObservation: true, agentPreStep: true, coalesceWindowMs: 10, maxRefreshHz: 20 },
      logger: llmCtx.logger,
    });

    const CHUNKS = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'probe text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'probe text' } },
      { type: 'usage', usage: { inputTokens: 21, outputTokens: 7, totalTokens: 28, cacheReadTokens: 4 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ];

    class ProbeFakeAdapter extends LlmAdapter {
      constructor() {
        super();
        this.streamCalls = 0;
      }
      providerInfo(provider) { return { id: provider, name: 'Probe fake provider' }; }
      async *stream(_options) {
        this.streamCalls += 1;
        for (const chunk of CHUNKS) yield chunk;
      }
    }

    const fakeAdapter = new ProbeFakeAdapter();
    recorder.add('llm.runtime_and_adapter', 'installed_bytes', 'real LlmRuntime accepts a fake provider adapter on a real cordis Context', () => {
      llm.registerAdapter(['probe-fake'], fakeAdapter);
      assert.equal(llm.listProviders().length, 1);
      assert.equal(llm.listProviders()[0].id, 'probe-fake');
      return { providers: llm.listProviders() };
    });

    llmCapture.install();
    // A second, INNER listener registered after the capture middleware lets the
    // probe count how many times this plugin's middleware advanced the real
    // waterfall chain (a second guarded next() would not advance it again).
    const chainProbe = { nextCalls: 0, listenerArgs: null };
    llmCtx.on('llm/stream', (streamOptions, next) => {
      chainProbe.nextCalls += 1;
      chainProbe.listenerArgs = [typeof streamOptions, typeof next];
      return next();
    });

    const requestMessage = createUserMessage({ content: [{ type: 'text', text: 'probe request' }], source: { kind: 'user' } });
    const llmOptions = {
      provider: 'probe-fake',
      model: 'probe-model',
      sessionId: 'probe-llm-session',
      messages: [requestMessage],
      tools: [],
    };
    const optionsSnapshot = JSON.stringify(llmOptions);

    let capturedStream = null;
    recorder.add('llm.waterfall_single_next', 'installed_bytes', 'real ctx.waterfall(llm/stream) dispatch reaches the adapter with exactly one middleware next()', () => {
      capturedStream = llm.stream(llmOptions);
      assert.ok(capturedStream !== null && typeof capturedStream[Symbol.asyncIterator] === 'function');
      assert.equal(chainProbe.nextCalls, 1, 'plugin middleware advanced the waterfall chain exactly once');
      assert.deepEqual(chainProbe.listenerArgs, ['object', 'function'], 'middleware receives (options, next)');
      return { chain_next_calls: chainProbe.nextCalls };
    });

    const receivedChunks = [];
    await recorder.addAsync('llm.chunk_identity_order_count', 'installed_bytes', 'wrapped stream yields the original chunk objects in order without buffering changes', async () => {
      assert.ok(capturedStream !== null);
      for await (const chunk of capturedStream) receivedChunks.push(chunk);
      assert.equal(receivedChunks.length, CHUNKS.length);
      receivedChunks.forEach((chunk, index) => assert.equal(chunk, CHUNKS[index], `chunk ${index} identity changed`));
      assert.equal(fakeAdapter.streamCalls, 1, 'adapter stream created exactly once');
      assert.equal(JSON.stringify(llmOptions), optionsSnapshot, 'llm/stream options were modified');
      assert.equal(llmOptions.messages[0], requestMessage, 'request messages were replaced');
      const duplicateNextWarnings = (llmCtx.logger.buffer ?? []).filter((message) => JSON.stringify(message).includes('LLM_NEXT_CALLED_TWICE'));
      assert.equal(duplicateNextWarnings.length, 0, 'the plugin middleware called next() more than once');
      return { chunks: receivedChunks.length, adapter_calls: fakeAdapter.streamCalls };
    });

    await recorder.addAsync('llm.usage_captured', 'installed_bytes', 'provider usage chunk is captured into a request_observed observation of the original request', async () => {
      await sleep(10);
      const entries = llmStore.entriesForSession('probe-llm-session').filter((entry) => entry.stage === 'llm_waterfall');
      assert.equal(entries.length, 1);
      const observation = entries[0].observation;
      const validation = contracts.validateObservation(observation);
      assert.equal(validation.ok, true, JSON.stringify(validation.errors));
      assert.equal(observation.capture_stage, 'llm_waterfall');
      assert.equal(observation.fidelity, 'request_observed');
      assert.equal(observation.wire_verified, false);
      assert.equal(observation.boundary.session_ref, 'probe-llm-session');
      assert.equal(observation.provider_ref, 'probe-fake');
      assert.equal(observation.model_ref, 'probe-model');
      assert.ok(observation.request_ref !== null && observation.request_ref.length > 0);
      assert.equal(observation.reported_usage.source, 'provider_usage_chunk');
      assert.equal(observation.reported_usage.request_ref, observation.request_ref);
      assert.equal(observation.reported_usage.input_tokens, 21);
      assert.equal(observation.reported_usage.output_tokens, 7);
      assert.equal(observation.reported_usage.cached_input_tokens, 4);
      assert.equal(observation.reported_usage.is_final, true);
      return { request_ref: observation.request_ref, usage: observation.reported_usage };
    });

    // Main-request error passthrough: an inner middleware returns a stream that
    // throws; our transparent wrapper must rethrow the exact error unchanged.
    const sentinel = new Error('probe main-request sentinel');
    const throwingObserver = llmCtx.on('llm/stream', () => {
      return (async function* throwsAfterOneChunk() {
        yield CHUNKS[0];
        throw sentinel;
      })();
    });
    let caught = null;
    const passthroughReceived = [];
    await recorder.addAsync('llm.main_error_passthrough', 'installed_bytes', 'an error thrown by the downstream stream is propagated unchanged by the transparent wrapper', async () => {
      try {
        for await (const chunk of llm.stream({ ...llmOptions, sessionId: 'probe-llm-session' })) passthroughReceived.push(chunk);
      } catch (error) {
        caught = error;
      }
      throwingObserver();
      assert.equal(caught, sentinel, 'the main-request error was swallowed or replaced');
      assert.equal(passthroughReceived.length, 1);
      assert.equal(passthroughReceived[0], CHUNKS[0]);
      return { error: caught.message, chunks_before_error: passthroughReceived.length };
    });

    await recorder.addAsync('llm.unbound_session_passthrough', 'installed_bytes', 'unbound sessions are passed through with no observation and no content projection', async () => {
      const before = JSON.stringify(llmOptions);
      const chunks = [];
      for await (const chunk of llm.stream({ ...llmOptions, sessionId: 'probe-unbound-session' })) chunks.push(chunk);
      assert.equal(chunks.length, CHUNKS.length);
      chunks.forEach((chunk, index) => assert.equal(chunk, CHUNKS[index]));
      assert.equal(JSON.stringify(llmOptions), before);
      assert.equal(llmStore.entriesForSession('probe-unbound-session').length, 0);
      return { chunks: chunks.length };
    });

    // ---- 5. layers and summary -------------------------------------------
    llmCapture.dispose();
    liveCapture.dispose();

    result.layers = {
      pinned_files: layerStatus(recorder.checks, 'installed_bytes'),
      installed_bytes: layerStatus(recorder.checks, 'installed_bytes'),
      full_host: {
        layer: 'full host',
        status: 'not_run',
        reason: 'No rc.5 AgentLoop/host boot, no real model call, no GUI/Chromium journey and no network egress check were run; this probe only drives installed package bytes with synthetic adapters.',
      },
    };
    result.summary = summarize(recorder.checks);
    result.ok = result.summary.fail === 0 && result.summary.pass > 0;
    result.finished_at = new Date().toISOString();

    const exitCode = result.ok ? 0 : 1;
    if (!options.keep) {
      try { fs.rmSync(extractRoot, { recursive: true, force: true }); } catch { /* best effort temp cleanup */ }
      result.closure.temp_dir = null;
    }
    await writeResult(result, options.out);
    return exitCode;
  } catch (error) {
    result.unexpected_error = String(error instanceof Error ? error.stack ?? error.message : error).slice(0, 2000);
    result.summary = summarize(recorder.checks);
    result.ok = false;
    result.finished_at = new Date().toISOString();
    await writeResult(result, options.out);
    return 2;
  } finally {
    try { fs.closeSync(asar.fd); } catch { /* already closed */ }
    if (extractRoot !== null && !options.keep) {
      try { fs.rmSync(extractRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

async function writeResult(result, outPath) {
  const summary = result.summary ?? summarize(result.checks);
  for (const check of result.checks) {
    if (check.status === 'fail') process.stdout.write(`FAIL ${check.id}: ${check.detail}\n`);
    else if (check.status === 'skip') process.stdout.write(`SKIP ${check.id}: ${check.detail}\n`);
    else process.stdout.write(`PASS ${check.id}\n`);
  }
  process.stdout.write(`SUMMARY pass=${summary.pass} fail=${summary.fail} skip=${summary.skip} total=${summary.total}\n`);
  if (result.unexpected_error !== undefined) process.stdout.write(`UNEXPECTED_ERROR ${result.unexpected_error.split('\n')[0]}\n`);
  const destination = outPath === null
    ? path.join(os.tmpdir(), `dsh-07-probe-${Date.now()}.json`)
    : path.resolve(outPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(result, null, 2));
  process.stdout.write(`EVIDENCE ${destination}\n`);
}

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    process.stderr.write(`probe failed to start: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 2;
  });
