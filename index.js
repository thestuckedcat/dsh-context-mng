/**
 * 07 context-mng: Host plugin entry.
 *
 * Read-only context observation. The plugin:
 *  - loads the trusted access registry from explicit configuration;
 *  - samples authorized sessions through the rc.5 seams (src/host-rc5.mjs);
 *  - keeps bounded in-memory observations (src/observations.mjs);
 *  - exposes four owner-only browser endpoints as rc.5 exact Fetch routes
 *    (`/api/context-mng/*`) with fixed BusinessResponse errors;
 *  - never modifies prompts, messages, sessions or model requests, and never
 *    performs network I/O or spawns processes.
 *
 * Maintenance (context rewriting) is a post-first-version increment. The
 * configuration schema rejects it while disabled, so no write path can be
 * activated accidentally.
 */

import { LIMITS, REDACTION_POLICY_REVISION, normalizeConfig } from './src/contracts.mjs';
import { createAccessRegistry } from './src/access.mjs';
import { createObservationStore } from './src/observations.mjs';
import { createRc5Host } from './src/host-rc5.mjs';
import { createCapture } from './src/capture.mjs';
import { createRedactor } from './src/redact.mjs';
import { createReportWriter } from './src/export.mjs';
import { createContextService } from './src/service.mjs';
import { createRpcHandler } from './src/rpc.mjs';
import { API_BASE, createContextFetchTransport } from './src/transport.mjs';

export const name = 'dsh-context-mng';
// Observation only needs the session service. The browser transport is mounted
// lazily only when a `connection` service exists (Web profiles); headless/CLI
// profiles still get the observation loop and can be used for Host-side gates.
export const inject = ['sessions'];

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object|undefined} rawConfig plugin row config from cordis.patch.yml
 */
export function apply(ctx, rawConfig) {
  const clock = () => new Date();
  const logger = ctx.logger;

  // Fail closed: an invalid registry/security configuration must not silently
  // degrade into an implicit grant.
  const config = normalizeConfig(rawConfig);

  const access = createAccessRegistry({ registry: config.access.registry });
  const store = createObservationStore({ limits: LIMITS, clock });
  const redactor = createRedactor({ policyRevision: REDACTION_POLICY_REVISION });
  const host = createRc5Host(ctx);
  const capture = createCapture({
    host,
    access,
    store,
    redactor,
    policy: { redactionPolicyRevision: REDACTION_POLICY_REVISION },
    clock,
    limits: LIMITS,
    config: config.capture,
    logger,
  });
  const reportWriter = createReportWriter({ limits: LIMITS, clock });
  const service = createContextService({
    access,
    store,
    capture,
    reportWriter,
    policy: { redactionPolicyRevision: REDACTION_POLICY_REVISION },
    clock,
    limits: LIMITS,
  });

  const disposers = [];
  const disposeAll = () => {
    while (disposers.length > 0) {
      const dispose = disposers.pop();
      try {
        dispose?.();
      } catch (error) {
        logger?.warn?.(`context-mng: disposer failed: ${error instanceof Error ? error.name : 'unknown'}`);
      }
    }
    service.dispose();
    access.dispose();
    store.dispose();
  };

  // Observation loop is independent of the Web UI; it must work even when no
  // browser carrier exists (CLI/headless still observe authorized sessions).
  try {
    disposers.push(capture.install());
  } catch (error) {
    logger?.warn?.(`context-mng: capture install failed: ${error instanceof Error ? error.name : 'unknown'}`);
  }

  // Browser transport: rc.5 exact Fetch routes (/api/context-mng/*). The
  // design's assumed `connection.rpc.handle` is not served to profile plugins
  // by the installed rc.5 bytes (see docs/design-change-ctx-rpc-02.md
  // CTX-RPC-03). The Fetch route keeps the same peer-derived caller and the
  // same fixed BusinessResponse/error mapping. Headless/CLI profiles have no
  // `connection` service, so this block simply never runs there.
  const rpcHandler = createRpcHandler({ service, limits: LIMITS, logger });
  try {
    ctx.inject(['connection'], (connectionCtx) => {
      try {
        disposers.push(createContextFetchTransport({ connection: connectionCtx.connection, rpcHandler, logger }));
      } catch (error) {
        logger?.warn?.(`context-mng: browser transport unavailable: ${error instanceof Error ? error.name : 'unknown'}`);
      }
    });
  } catch (error) {
    logger?.warn?.(`context-mng: connection service unavailable: ${error instanceof Error ? error.name : 'unknown'}`);
  }

  ctx.effect(() => disposeAll, 'context-mng: dispose observation, browser transport and access registry');
}

/** Exported for probe/smoke tooling: the exact Fetch-route base path. */
export { API_BASE };
