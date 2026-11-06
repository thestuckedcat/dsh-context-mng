/**
 * T3 export tests (CTX-05, design §4/§8).
 *
 * Contract under test:
 *   createReportWriter({limits, clock, fs?}) ->
 *     writeReport({rootPath, report, fileName}) ->
 *       {status: 'saved'|'conflict', report_ref, digest}
 *
 * Negative paths are the point of this suite: path traversal, symlinked
 * target/parent, non-regular target, oversize body, invalid report and
 * secret-like content must be rejected before any bytes land outside the
 * registered root. Temp artifacts live under $env:TEMP only; the repository
 * never receives test output.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import * as fs from 'node:fs';
import {
  canonicalJson,
  sha256Hex,
} from '../src/contracts.mjs';
import { fixedClock, group, observation, report } from './helpers.mjs';
import { ExportError, createReportWriter } from '../src/export.mjs';

const TMP_ROOT = process.env.TEMP || process.env.TMP || tmpdir();
const ROOTS = [];

function makeRoot(label = 'report-root') {
  const root = mkdtempSync(path.join(TMP_ROOT, `dsh07-${label}-`));
  ROOTS.push(root);
  return root;
}

function listings(dir) {
  return readdirSync(dir).sort();
}

function assertNoAbsolutePath(value, rootPath) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const variants = [rootPath, rootPath.replace(/\\/g, '/'), realpathSync(rootPath)];
  for (const variant of variants) {
    assert.equal(text.includes(variant), false, `wire value must not expose the absolute root path: ${text}`);
  }
}

function assertNoTempLeftovers(root) {
  const stray = listings(root).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(stray, [], `temporary files must be cleaned up, found: ${stray.join(',')}`);
}

test.afterEach(() => {
  while (ROOTS.length > 0) {
    const root = ROOTS.pop();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup under the OS temp area */
    }
  }
});

test('writes canonical JSON atomically and returns a root-relative receipt', () => {
  const root = makeRoot();
  const writer = createReportWriter({ clock: fixedClock() });
  const fixture = report();
  const result = writer.writeReport({
    rootPath: root,
    report: fixture,
    fileName: 'ctx-report-fixture-1.json',
  });

  assert.equal(result.status, 'saved');
  assert.equal(result.report_ref, 'ctx-report-fixture-1.json');
  assert.equal(path.isAbsolute(result.report_ref), false);
  assert.equal(result.digest, sha256Hex(canonicalJson(fixture)));

  const target = path.join(root, 'ctx-report-fixture-1.json');
  assert.equal(existsSync(target), true);
  assert.equal(readFileSync(target, 'utf8'), canonicalJson(fixture));
  assert.equal(lstatSync(target).isFile(), true);
  assertNoAbsolutePath(result, root);
  assertNoTempLeftovers(root);

  if (process.platform !== 'win32') {
    assert.equal(lstatSync(target).mode & 0o777, 0o600, 'best-effort 0600 mode');
  }
});

test('creates the temporary file in the same directory and fsyncs before rename', () => {
  const root = makeRoot('order');
  const calls = [];
  const tracked = {
    ...fs,
    openSync(targetPath, flags, mode) {
      calls.push(['open', path.basename(targetPath), flags]);
      return fs.openSync(targetPath, flags, mode);
    },
    writeSync(fd, buffer) {
      calls.push(['write']);
      return fs.writeSync(fd, buffer);
    },
    fsyncSync(fd) {
      calls.push(['fsync']);
      return fs.fsyncSync(fd);
    },
    closeSync(fd) {
      calls.push(['close']);
      return fs.closeSync(fd);
    },
    renameSync(from, to) {
      calls.push(['rename', path.basename(from), path.basename(to)]);
      return fs.renameSync(from, to);
    },
  };
  const writer = createReportWriter({ clock: fixedClock(), fs: tracked });
  const result = writer.writeReport({ rootPath: root, report: report(), fileName: 'ordered.json' });
  assert.equal(result.status, 'saved');

  const open = calls.find((call) => call[0] === 'open');
  const rename = calls.find((call) => call[0] === 'rename');
  assert.ok(open, 'temp file must be opened');
  assert.ok(rename, 'rename must happen');
  assert.ok(open[1].endsWith('.tmp'), `temp file must be a temp name, got ${open[1]}`);
  assert.equal(open[2], 'wx'); // exclusive create, never clobber a concurrent file
  assert.equal(rename[1], open[1], 'rename source is the opened temp file');
  assert.equal(rename[2], 'ordered.json');

  const order = calls.map((call) => call[0]);
  assert.ok(order.indexOf('fsync') < order.indexOf('rename'), 'fsync must precede rename');
  assert.ok(order.indexOf('write') < order.indexOf('fsync'), 'write must precede fsync');
  assertNoTempLeftovers(root);
});

test('repeating identical content is idempotent (saved, same digest, no rewrite)', () => {
  const root = makeRoot('idem');
  const writer = createReportWriter({ clock: fixedClock() });
  const first = writer.writeReport({ rootPath: root, report: report(), fileName: 'same.json' });
  const target = path.join(root, 'same.json');
  const before = readFileSync(target);
  const second = writer.writeReport({ rootPath: root, report: report(), fileName: 'same.json' });
  const after = readFileSync(target);

  assert.equal(first.status, 'saved');
  assert.equal(second.status, 'saved');
  assert.equal(first.digest, second.digest);
  assert.deepEqual(before, after, 'identical re-export must not change the stored bytes');
  assertNoTempLeftovers(root);
});

test('different content under the same file name conflicts without overwrite', () => {
  const root = makeRoot('conflict');
  const writer = createReportWriter({ clock: fixedClock() });
  const original = report();
  const saved = writer.writeReport({ rootPath: root, report: original, fileName: 'ctx-report.json' });
  assert.equal(saved.status, 'saved');

  const changed = report({ report_id: 'ctx-report-fixture-2', observation: observation({ revision: 2 }) });
  const conflict = writer.writeReport({ rootPath: root, report: changed, fileName: 'ctx-report.json' });

  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.report_ref, 'ctx-report.json');
  assert.equal(conflict.digest, sha256Hex(canonicalJson(original)), 'conflict digest identifies the stored bytes');
  assert.equal(readFileSync(path.join(root, 'ctx-report.json'), 'utf8'), canonicalJson(original));
  assertNoAbsolutePath(conflict, root);
  assertNoTempLeftovers(root);
});

test('rejects relative and missing export roots', () => {
  const writer = createReportWriter({ clock: fixedClock() });
  assert.throws(
    () => writer.writeReport({ rootPath: 'relative/reports', report: report(), fileName: 'x.json' }),
    (error) => error instanceof ExportError && error.reasonCode === 'INVALID_REQUEST',
  );
  const missing = path.join(TMP_ROOT, 'dsh07-does-not-exist-export-root');
  assert.throws(
    () => writer.writeReport({ rootPath: missing, report: report(), fileName: 'x.json' }),
    (error) => error instanceof ExportError && ['OUTPUT_REF_DENIED', 'INVALID_REQUEST'].includes(error.reasonCode),
  );
});

test('rejects path traversal and non-leaf file names before touching disk', () => {
  const root = makeRoot('traversal');
  const writer = createReportWriter({ clock: fixedClock() });
  const denied = [
    '../escape.json',
    '..\\escape.json',
    'nested/escape.json',
    'nested\\escape.json',
    '/absolute.json',
    'C:/absolute.json',
    'C:\\absolute.json',
    '.',
    '..',
    '',
    '.hidden.json',
    'x'.repeat(200) + '.json',
  ];
  for (const fileName of denied) {
    assert.throws(
      () => writer.writeReport({ rootPath: root, report: report(), fileName }),
      (error) => {
        assert.equal(error instanceof ExportError, true, `fileName=${JSON.stringify(fileName)} must throw ExportError`);
        assert.ok(['INVALID_REQUEST', 'OUTPUT_REF_DENIED', 'LIMIT_EXCEEDED'].includes(error.reasonCode));
        assertNoAbsolutePath(error.message, root);
        return true;
      },
    );
  }
  assert.deepEqual(listings(root), [], 'no file may be created for a rejected name');
  // The parent directory must not receive the escaped file either.
  assert.equal(existsSync(path.join(path.dirname(root), 'escape.json')), false);
});

test('rejects an existing directory target and never replaces it', () => {
  const root = makeRoot('nonregular');
  mkdirSync(path.join(root, 'ctx-report.json'));
  const writer = createReportWriter({ clock: fixedClock() });
  assert.throws(
    () => writer.writeReport({ rootPath: root, report: report(), fileName: 'ctx-report.json' }),
    (error) => error instanceof ExportError && error.reasonCode === 'OUTPUT_REF_DENIED',
  );
  assert.equal(lstatSync(path.join(root, 'ctx-report.json')).isDirectory(), true);
});

test('rejects a symlinked target (real symlink when the host allows it)', (t) => {
  const root = makeRoot('symlink-target');
  const outside = makeRoot('symlink-outside');
  const outsideFile = path.join(outside, 'outside-target.json');
  fs.writeFileSync(outsideFile, 'outside', { mode: 0o600 });
  const link = path.join(root, 'ctx-report.json');
  let symlinkAvailable = true;
  try {
    symlinkSync(outsideFile, link);
  } catch (error) {
    symlinkAvailable = false;
    t.diagnostic(`real symlink unavailable on this host (${error.code ?? error.message}); using injected fs adapter for the same code path`);
  }
  if (symlinkAvailable) {
    const writer = createReportWriter({ clock: fixedClock() });
    assert.throws(
      () => writer.writeReport({ rootPath: root, report: report(), fileName: 'ctx-report.json' }),
      (error) => error instanceof ExportError && error.reasonCode === 'OUTPUT_REF_DENIED',
    );
    assert.equal(readFileSync(outsideFile, 'utf8'), 'outside', 'symlink target must not be overwritten');
  }
});

test('denies a symlink reported by an injected fs adapter', () => {
  const root = makeRoot('symlink-adapter');
  const target = path.join(root, 'ctx-report.json');
  fs.writeFileSync(target, 'existing');
  const adapter = {
    ...fs,
    lstatSync(candidate) {
      if (path.resolve(candidate) === path.resolve(target)) {
        return {
          isSymbolicLink: () => true,
          isFile: () => true,
          isDirectory: () => false,
          mode: 0o100666,
        };
      }
      return fs.lstatSync(candidate);
    },
  };
  const writer = createReportWriter({ clock: fixedClock(), fs: adapter });
  assert.throws(
    () => writer.writeReport({ rootPath: root, report: report(), fileName: 'ctx-report.json' }),
    (error) => error instanceof ExportError && error.reasonCode === 'OUTPUT_REF_DENIED',
  );
  assert.equal(readFileSync(target, 'utf8'), 'existing');
});

test('denies a symlinked parent (root realpath differs from the registered root)', () => {
  const root = makeRoot('symlink-parent');
  const outside = makeRoot('symlink-parent-outside');
  const realpath = fs.realpathSync;
  const adapter = {
    ...fs,
    realpathSync(candidate) {
      if (path.resolve(candidate) === path.resolve(root)) return outside;
      return realpath(candidate);
    },
  };
  const writer = createReportWriter({ clock: fixedClock(), fs: adapter });
  assert.throws(
    () => writer.writeReport({ rootPath: root, report: report(), fileName: 'ctx-report.json' }),
    (error) => error instanceof ExportError && error.reasonCode === 'OUTPUT_REF_DENIED',
  );
  assert.deepEqual(listings(outside), [], 'nothing may be written through a symlinked parent');
});

test('rejects an oversize report body via the configured limit', () => {
  const root = makeRoot('oversize');
  const writer = createReportWriter({
    clock: fixedClock(),
    limits: { maxReportBytes: 256, maxFileNameChars: 128 },
  });
  const big = report({
    observation: observation({
      groups: [group({ preview: 'x'.repeat(512), characters: 512, bytes: 512 })],
    }),
  });
  assert.throws(
    () => writer.writeReport({ rootPath: root, report: big, fileName: 'big.json' }),
    (error) => error instanceof ExportError && error.reasonCode === 'LIMIT_EXCEEDED',
  );
  assert.deepEqual(listings(root), []);
});

test('rejects report bodies that do not satisfy the report contract', () => {
  const root = makeRoot('schema');
  const rootCalls = [];
  const tracked = {
    ...fs,
    openSync(...args) {
      rootCalls.push('open');
      return fs.openSync(...args);
    },
  };
  const writer = createReportWriter({ clock: fixedClock(), fs: tracked });
  const invalid = report({ report_id: 42, capability: '08' });
  assert.throws(
    () => writer.writeReport({ rootPath: root, report: invalid, fileName: 'bad.json' }),
    (error) => error instanceof ExportError && error.reasonCode === 'INVALID_REQUEST',
  );
  assert.deepEqual(rootCalls, [], 'schema validation must happen before any filesystem write');
  assert.deepEqual(listings(root), []);
});

test('refuses report bodies containing unredacted secret-like strings', () => {
  const root = makeRoot('secrets');
  const writer = createReportWriter({ clock: fixedClock() });
  const leaked = report({
    observation: observation({
      groups: [group({ preview: 'api_key=sk-CANARYCANARYCANARY1234567890' })],
    }),
  });
  assert.throws(
    () => writer.writeReport({ rootPath: root, report: leaked, fileName: 'leak.json' }),
    (error) => {
      assert.equal(error instanceof ExportError, true);
      assert.equal(error.reasonCode, 'OUTPUT_REF_DENIED');
      assert.equal(String(error.message).includes('CANARYCANARYCANARY'), false, 'error text must not echo the secret');
      assertNoAbsolutePath(error.message, root);
      return true;
    },
  );
  assert.deepEqual(listings(root), []);
});

test('cleans up the temp file and keeps the target absent when rename fails', () => {
  const root = makeRoot('rename-fail');
  const adapter = {
    ...fs,
    renameSync() {
      const error = new Error('synthetic rename failure');
      error.code = 'EIO';
      throw error;
    },
  };
  const writer = createReportWriter({ clock: fixedClock(), fs: adapter });
  assert.throws(
    () => writer.writeReport({ rootPath: root, report: report(), fileName: 'ctx-report.json' }),
    (error) => {
      assert.equal(error instanceof ExportError, true);
      assert.equal(error.reasonCode, 'INTERNAL_FAILURE');
      assert.equal(String(error.message).includes(root), false, 'I/O errors never echo the absolute root');
      assert.equal(String(error.message).includes('synthetic rename failure'), false, 'raw I/O text is not surfaced');
      return true;
    },
  );
  assert.equal(existsSync(path.join(root, 'ctx-report.json')), false);
  assertNoTempLeftovers(root);
});

test('rejects an invalid hidden writer limits object defensively', () => {
  assert.throws(() => createReportWriter({ limits: { maxReportBytes: -1 } }), /limits/i);
  assert.throws(() => createReportWriter({ limits: { maxFileNameChars: 0 } }), /limits/i);
});
