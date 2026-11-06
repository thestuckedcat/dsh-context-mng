/**
 * 07 context-mng: local filtered-report writer (CTX-05, design §4/§8).
 *
 * The writer is the only place this plugin puts observation content on disk.
 * Its job is deliberately narrow and defensive:
 *
 *  - only an already-redacted `ReportV1` (validated by `contracts.validateReport`)
 *    is accepted; schema errors and secret-like content are refused before any
 *    filesystem call;
 *  - the destination is a leaf file name inside a trusted, explicitly
 *    registered root; traversal, non-leaf names, symlinked targets and
 *    symlinked/realpath-divergent roots are denied;
 *  - bytes land atomically: same-directory temp file, full write, `fsync`,
 *    `rename`, then a best-effort directory `fsync`; a failure never leaves a
 *    partial target behind (and a conflict never overwrites existing content);
 *  - the returned receipt never contains an absolute path (the browser only
 *    ever sees a root-relative `report_ref` and a 64-hex digest).
 *
 * I/O goes through an injectable `fs` seam so the atomic ordering and the
 * symlink branches are testable without an administrative host account.
 */

import * as nodeFs from 'node:fs';
import path from 'node:path';

import {
  ContractError,
  LIMITS,
  canonicalJson,
  sha256Hex,
  validateReport,
} from './contracts.mjs';

/** Export-specific engineering bounds (adjustable defaults, not user targets). */
export const EXPORT_LIMITS = Object.freeze({
  maxReportBytes: 2 * 1024 * 1024,
  maxFileNameChars: 128,
  fileMode: 0o600,
});

/**
 * Fixed export failure. It extends `ContractError` so the RPC boundary maps it
 * to a registered reason code (never a raw exception, never a filesystem path).
 */
export class ExportError extends ContractError {
  constructor(reasonCode, message) {
    super(message, reasonCode);
    this.name = 'ExportError';
  }
}

/**
 * Conservative secret-like detector used as a final exit guard. The projection
 * layer is the authoritative redactor; this is defense in depth so a caller bug
 * cannot persist an unredacted secret through the export path. Patterns are
 * intentionally anchored on well-known secret shapes rather than prose.
 */
const SECRET_PATTERNS = Object.freeze([
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:ghp|gho|ghu|ghs|github_pat|xox[baprs])_[A-Za-z0-9_]{16,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./,
  /\b(?:api[_-]?key|password|passwd|client[_-]?secret|access[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9_+/=.-]{12,}/i,
]);

/** @returns {number} number of secret-like matches (0 = clean). */
export function scanForSecrets(text) {
  const value = String(text);
  let count = 0;
  for (const pattern of SECRET_PATTERNS) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const matcher = new RegExp(pattern.source, flags);
    while (matcher.exec(value) !== null) count += 1;
  }
  return count;
}

/** Same-path comparison that tolerates Windows case/separator normalization. */
function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

function isPositiveCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function normalizeLimits(limits) {
  if (limits === undefined) return { ...EXPORT_LIMITS };
  if (typeof limits !== 'object' || limits === null) throw new TypeError('export limits must be an object');
  const maxReportBytes = limits.maxReportBytes ?? EXPORT_LIMITS.maxReportBytes;
  const maxFileNameChars = limits.maxFileNameChars ?? EXPORT_LIMITS.maxFileNameChars;
  if (!isPositiveCount(maxReportBytes)) throw new TypeError('export limits.maxReportBytes must be a positive safe integer');
  if (!isPositiveCount(maxFileNameChars)) throw new TypeError('export limits.maxFileNameChars must be a positive safe integer');
  return { ...EXPORT_LIMITS, maxReportBytes, maxFileNameChars };
}

/**
 * @param {{limits?: object, clock?: () => Date, fs?: object, secretScan?: (text: string) => number}} [options]
 * @returns {{writeReport: (input: {rootPath: string, report: object, fileName: string}) => {status: 'saved'|'conflict', report_ref: string, digest: string}}}
 */
export function createReportWriter(options = {}) {
  const limits = normalizeLimits(options.limits);
  const io = options.fs ?? nodeFs;
  if (options.clock !== undefined && typeof options.clock !== 'function') {
    throw new TypeError('export clock must be a function returning a Date');
  }
  const secretScan = options.secretScan ?? scanForSecrets;
  if (typeof secretScan !== 'function') throw new TypeError('export secretScan must be a function');
  let tempCounter = 0;

  function reject(reasonCode, message) {
    return new ExportError(reasonCode, message);
  }

  function resolveFileName(fileName) {
    if (typeof fileName !== 'string' || fileName.length === 0) {
      throw reject('INVALID_REQUEST', 'report file name must be a non-empty string');
    }
    if (fileName.length > limits.maxFileNameChars) {
      throw reject('LIMIT_EXCEEDED', 'report file name exceeds the configured length limit');
    }
    if (fileName === '.' || fileName === '..' || path.isAbsolute(fileName) || path.basename(fileName) !== fileName) {
      throw reject('OUTPUT_REF_DENIED', 'report file name must be a plain leaf name inside the export root');
    }
    if (fileName.startsWith('.') || /[\\/:*?"<>|\u0000-\u001f]/.test(fileName)) {
      throw reject('OUTPUT_REF_DENIED', 'report file name must be a plain leaf name inside the export root');
    }
    return fileName;
  }

  function resolveRoot(rootPath) {
    if (typeof rootPath !== 'string' || rootPath.length === 0 || rootPath.length > 1024 || rootPath.includes('\u0000')) {
      throw reject('INVALID_REQUEST', 'export root must be an absolute registered path');
    }
    if (!path.isAbsolute(rootPath)) {
      throw reject('INVALID_REQUEST', 'export root must be an absolute registered path');
    }
    let rootReal;
    try {
      rootReal = io.realpathSync(rootPath);
    } catch {
      throw reject('OUTPUT_REF_DENIED', 'export root is not accessible');
    }
    let stat;
    try {
      stat = (io.statSync ?? io.lstatSync)(rootReal);
    } catch {
      throw reject('OUTPUT_REF_DENIED', 'export root is not accessible');
    }
    if (typeof stat.isDirectory !== 'function' || stat.isDirectory() !== true) {
      throw reject('OUTPUT_REF_DENIED', 'export root must be a directory');
    }
    // The registered root must BE its real location: a symlinked/junction
    // parent could redirect writes outside the user-registered directory.
    if (!samePath(rootPath, rootReal)) {
      throw reject('OUTPUT_REF_DENIED', 'export root must not be a symlink or junction');
    }
    return rootReal;
  }

  function serializeReport(report) {
    const result = validateReport(report);
    if (!result.ok) {
      throw reject('INVALID_REQUEST', 'report does not satisfy the report contract');
    }
    const content = canonicalJson(report);
    const byteLength = Buffer.byteLength(content, 'utf8');
    if (byteLength > limits.maxReportBytes) {
      throw reject('LIMIT_EXCEEDED', 'report body exceeds the configured export size limit');
    }
    if (secretScan(content) > 0) {
      throw reject('OUTPUT_REF_DENIED', 'report contains unredacted secret-like content');
    }
    return { content, digest: sha256Hex(content) };
  }

  function readExisting(target) {
    let stats;
    try {
      stats = io.lstatSync(target);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw reject('INTERNAL_FAILURE', 'export destination could not be inspected');
    }
    if (typeof stats.isSymbolicLink === 'function' && stats.isSymbolicLink()) {
      throw reject('OUTPUT_REF_DENIED', 'export destination must not be a symbolic link');
    }
    if (typeof stats.isFile !== 'function' || stats.isFile() !== true) {
      throw reject('OUTPUT_REF_DENIED', 'export destination must be a regular file');
    }
    let content;
    try {
      content = io.readFileSync(target);
    } catch {
      throw reject('INTERNAL_FAILURE', 'existing export destination could not be read');
    }
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    return { content: buffer, digest: sha256Hex(buffer) };
  }

  function tempPathFor(rootReal, fileName) {
    tempCounter += 1;
    const pid = typeof process !== 'undefined' && typeof process.pid === 'number' ? process.pid : 0;
    return path.join(rootReal, `.${fileName}.${pid}.${tempCounter}.tmp`);
  }

  function writeAtomically(target, content) {
    const rootReal = path.dirname(target);
    const tempPath = tempPathFor(rootReal, path.basename(target));
    let fd;
    try {
      fd = io.openSync(tempPath, 'wx', EXPORT_LIMITS.fileMode);
      const buffer = Buffer.from(content, 'utf8');
      let offset = 0;
      while (offset < buffer.length) {
        const written = io.writeSync(fd, buffer, offset, buffer.length - offset);
        if (typeof written !== 'number' || written <= 0) throw new Error('short write');
        offset += written;
      }
      io.fsyncSync(fd);
      io.closeSync(fd);
      fd = undefined;
      if (typeof io.chmodSync === 'function') {
        try {
          io.chmodSync(tempPath, EXPORT_LIMITS.fileMode);
        } catch {
          /* best effort: Windows may not carry POSIX modes */
        }
      }
      io.renameSync(tempPath, target);
      fsyncDirectory(rootReal);
    } catch (error) {
      if (fd !== undefined) {
        try {
          io.closeSync(fd);
        } catch {
          /* ignore cleanup failure */
        }
      }
      try {
        io.unlinkSync(tempPath);
      } catch {
        /* the temp file may never have been created */
      }
      if (error instanceof ContractError) throw error;
      throw reject('INTERNAL_FAILURE', 'report could not be written atomically');
    }
  }

  function fsyncDirectory(rootReal) {
    let fd;
    try {
      fd = io.openSync(rootReal, 'r');
      io.fsyncSync(fd);
    } catch {
      /* best effort; some platforms cannot fsync a directory */
    } finally {
      if (fd !== undefined) {
        try {
          io.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }
  }

  function writeReport({ rootPath, report, fileName } = {}) {
    const leafName = resolveFileName(fileName);
    const rootReal = resolveRoot(rootPath);
    // Validate + serialize before any filesystem access or temp creation.
    const { content, digest } = serializeReport(report);
    const target = path.join(rootReal, leafName);
    if (!samePath(path.dirname(target), rootReal)) {
      throw reject('OUTPUT_REF_DENIED', 'export destination escapes the registered root');
    }

    const existing = readExisting(target);
    if (existing !== null) {
      if (existing.digest === digest) {
        return { status: 'saved', report_ref: leafName, digest };
      }
      return { status: 'conflict', report_ref: leafName, digest: existing.digest };
    }

    writeAtomically(target, content);
    return { status: 'saved', report_ref: leafName, digest };
  }

  return { writeReport };
}
