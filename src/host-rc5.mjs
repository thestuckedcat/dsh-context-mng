/**
 * 07 context-mng: thin adapter over the rc.5 Host seams (0.2.1-rc.5).
 *
 * Everything in this module is a read-only binding to bytes that exist in the
 * installed Harness. It never imports Host source and never copies it:
 *
 *  - `ctx.sessions.get/list` + `Session.deriveMessages()` + immutable header;
 *  - `Session.surface.contentGeneration` and `Session.seq` (event count) as the
 *    observation boundary;
 *  - `ctx.on('session/event' | 'session/disposed')` lifecycle notifications;
 *  - `ctx.waterfall(ctx, 'llm/stream', options, next)` middleware: the wrapped
 *    call invokes `next()` exactly once and yields the original chunk objects
 *    without buffering or rewriting them;
 *  - `ctx.waterfall(agent, 'agent/pre-step', payload, next)` middleware: the
 *    observer can tag the stage but the existing decision is returned
 *    unchanged.
 *
 * Failure containment is deliberate: an observer exception is reduced to a
 * non-secret log code and the downstream request/decision continues; a failure
 * thrown by the downstream stream itself is never swallowed.
 */

const BOUNDARY_FIELDS = Object.freeze(['last_event_seq', 'surface_generation']);

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function createRc5Host(ctx) {
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.on !== 'function') {
    throw new TypeError('createRc5Host requires a cordis context with ctx.on()');
  }

  const service = () => {
    try {
      return ctx.sessions ?? null;
    } catch {
      return null;
    }
  };

  function log(level, code) {
    try {
      const sink = ctx.logger?.[level] ?? ctx.logger?.warn ?? ctx.logger?.info;
      if (typeof sink === 'function') sink.call(ctx.logger, `context-mng: ${String(code).slice(0, 128)}`);
    } catch {
      // Diagnostics must never affect the Host request path.
    }
  }

  const sessions = {
    get(id) {
      const store = service();
      try {
        return typeof store?.get === 'function' ? store.get(id) : undefined;
      } catch {
        return undefined;
      }
    },
    list() {
      const store = service();
      try {
        return typeof store?.list === 'function' ? store.list() : [];
      } catch {
        return [];
      }
    },
  };

  function isSessionLive(id) {
    return sessions.get(id) !== undefined;
  }

  /**
   * Cheap boundary read: only immutable metadata, never message content.
   * `last_event_seq` is the accepted event count (`Session.seq`), which is a
   * stable "accepted event count" even for a brand-new empty session.
   */
  function readBoundary(session) {
    if (session === null || typeof session !== 'object') throw new Error('session is not an object');
    const lastEventSeq = typeof session.seq === 'number'
      ? session.seq
      : (Array.isArray(session.log) ? session.log.length : 0);
    const surfaceGeneration = session.surface?.contentGeneration;
    return {
      last_event_seq: Number.isSafeInteger(lastEventSeq) && lastEventSeq >= 0 ? lastEventSeq : 0,
      surface_generation: Number.isSafeInteger(surfaceGeneration) && surfaceGeneration >= 0 ? surfaceGeneration : 0,
    };
  }

  /**
   * Read the current surface projection plus its boundary metadata.
   *
   * `deriveMessages()` returns a fresh array of shared deep-frozen messages;
   * `requestHeader().tools` is the concrete tool list of the last logged
   * request header (tool-history updates are not invented here).
   */
  function readSurface(session) {
    const messages = session.deriveMessages();
    const boundary = readBoundary(session);
    let toolDefinitions = [];
    try {
      const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined;
      if (Array.isArray(header?.tools)) toolDefinitions = header.tools;
    } catch {
      toolDefinitions = [];
    }
    const header = { id: session.id };
    if (typeof session.header?.cwd === 'string' && session.header.cwd.length > 0) header.cwd = session.header.cwd;
    return {
      messages,
      last_event_seq: boundary.last_event_seq,
      surface_generation: boundary.surface_generation,
      header,
      tool_definitions: toolDefinitions,
    };
  }

  /** `session/event` and `session/disposed`, normalized to one observer shape. */
  function onSessionEvent(fn) {
    if (typeof fn !== 'function') throw new TypeError('onSessionEvent requires a function');
    const disposers = [];
    try {
      disposers.push(ctx.on('session/event', (session, event) => {
        try {
          fn({ kind: 'event', session, event });
        } catch (error) {
          log('warn', `SESSION_OBSERVER_FAILURE:${error instanceof Error ? error.name : 'unknown'}`);
        }
      }));
      disposers.push(ctx.on('session/disposed', (session) => {
        try {
          fn({ kind: 'disposed', session });
        } catch (error) {
          log('warn', `SESSION_DISPOSED_OBSERVER_FAILURE:${error instanceof Error ? error.name : 'unknown'}`);
        }
      }));
    } catch (error) {
      while (disposers.length > 0) {
        try { disposers.pop()(); } catch { /* already gone */ }
      }
      throw error;
    }
    return disposeAll(disposers);
  }

  /**
   * `llm/stream` middleware registration.
   *
   * The observer receives `(options, next)` and must call the guarded `next`
   * at most once, returning the stream to expose downstream (the wrapped
   * stream or the original one). This adapter guarantees:
   *  - exactly one invocation of the real `next()`: repeated calls return the
   *    already-created stream instead of corrupting the chain;
   *  - an observer throw before `next()` still starts the real request;
   *  - an observer throw after `next()` returns the real stream, never dropping
   *    it;
   *  - downstream stream/chain errors propagate unchanged.
   */
  function onLlmStream(fn) {
    if (typeof fn !== 'function') throw new TypeError('onLlmStream requires a function');
    return ctx.on('llm/stream', (options, next) => {
      let called = false;
      let downstream;
      let duplicate = false;
      const once = () => {
        if (called) {
          duplicate = true;
          log('warn', 'LLM_NEXT_CALLED_TWICE');
          return downstream;
        }
        called = true;
        downstream = next();
        return downstream;
      };
      let result;
      try {
        result = fn(options, once);
      } catch (error) {
        log('warn', `LLM_OBSERVER_FAILURE:${error instanceof Error ? error.name : 'unknown'}`);
        // A throw after the downstream stream was created is an observer bug:
        // keep the real stream. A throw while creating it is a main-request
        // error and must propagate — never swallow it.
        if (!called) return once();
        if (downstream === undefined) throw error;
        return downstream;
      }
      if (duplicate) log('warn', 'LLM_NEXT_CALLED_TWICE');
      if (result !== null && result !== undefined && typeof result[Symbol.asyncIterator] === 'function') return result;
      if (!called) return once();
      return downstream;
    });
  }

  /**
   * `agent/pre-step` middleware registration.
   *
   * The observer receives the payload and returns nothing: stage tagging is
   * observation-only. This adapter always calls `next()` exactly once and
   * returns its result untouched, so an existing waterfall decision (enter or
   * reject) is preserved and observer failures are contained.
   */
  function onAgentPreStep(fn) {
    if (typeof fn !== 'function') throw new TypeError('onAgentPreStep requires a function');
    return ctx.on('agent/pre-step', (payload, next) => {
      try {
        fn(payload);
      } catch (error) {
        log('warn', `PRE_STEP_OBSERVER_FAILURE:${error instanceof Error ? error.name : 'unknown'}`);
      }
      return next();
    });
  }

  return {
    sessions,
    readBoundary,
    readSurface,
    isSessionLive,
    onSessionEvent,
    onLlmStream,
    onAgentPreStep,
    log,
    BOUNDARY_FIELDS,
  };
}

function disposeAll(disposers) {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    while (disposers.length > 0) {
      try {
        disposers.pop()();
      } catch {
        // Listener already detached by its owner fiber.
      }
    }
  };
}
