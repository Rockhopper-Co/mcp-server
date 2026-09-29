import { McpServer } from '@modelcontextprotocol/server';
import { ApiClient } from './api-client.js';
import { runWithCorrelationId } from './correlation.js';
import { log, serviceVersion } from './logger.js';
import { registerPrompts } from './prompts/index.js';
import { registerResources } from './resources/index.js';
import {
  registerTools,
  resolveCapabilities,
  type RegisterToolsOptions,
} from './tools/index.js';
import { buildInstructions } from './instructions.js';
import {
  classifyToolResult,
  describeError,
  emitToolTelemetry,
  type ToolTelemetrySink,
} from './tool-telemetry.js';

/**
 * Phase 1.1 / KI-226 + Phase 1.5 / KI-225 — wrap every tool handler once.
 * Intercepting `registerTool` here (vs. wrapping each of the ~16 handlers)
 * means all current and future tools are covered automatically. The wrapper:
 *   - runs the handler inside {@link runWithCorrelationId}, so every outbound
 *     `ApiClient` call it makes — including multi-call fan-outs like search —
 *     shares one `X-Correlation-Id` (1.1), and
 *   - times the handler and logs a `tool_call` / `tool_call_failed` line to
 *     the local diagnostic file (1.5). Only the tool NAME is logged — never
 *     the tool arguments, which may carry file refs / PII.
 * The handler callback is always the last positional argument to
 * `registerTool`; the loose casts insulate this seam from the SDK's generic
 * `ToolCallback` union. On a handler throw we log then re-throw — behavior
 * (the error surfacing to the SDK) is preserved.
 */
function installCorrelationScope(
  server: McpServer,
  telemetry?: ToolTelemetrySink,
): void {
  const baseRegisterTool = server.registerTool.bind(server);
  server.registerTool = ((
    name: string,
    config: unknown,
    cb: unknown,
  ): ReturnType<typeof baseRegisterTool> => {
    const handler = cb as (...args: unknown[]) => unknown;
    const wrapped = (...args: unknown[]): unknown =>
      runWithCorrelationId(async () => {
        const start = Date.now();
        try {
          const result = await handler(...args);
          // ENG-2823: an MCP tool refuses by RETURNING `isError`, never by
          // throwing, so this branch is where every refusal lands. Reporting
          // it as `ok` made a refused enrolment and a successful one the same
          // line — see `tool-telemetry.ts`.
          const outcome = classifyToolResult(result);
          const durationMs = Date.now() - start;
          log.info({ event: 'tool_call', tool: name, durationMs, outcome }, 'tool_call');
          emitToolTelemetry(telemetry, {
            event: 'tool_call',
            tool: name,
            outcome,
            durationMs,
          });
          return result;
        } catch (err) {
          const durationMs = Date.now() - start;
          log.error(
            { event: 'tool_call_failed', tool: name, durationMs, err },
            'tool_call_failed',
          );
          // The sink gets the error's TYPE and status, never `err` itself —
          // the local file may carry the message, a collected log may not.
          emitToolTelemetry(telemetry, {
            event: 'tool_call',
            tool: name,
            outcome: 'failed',
            durationMs,
            ...describeError(err),
          });
          throw err;
        }
      });
    return (
      baseRegisterTool as (
        name: string,
        config: unknown,
        cb: unknown,
      ) => ReturnType<typeof baseRegisterTool>
    )(name, config, wrapped);
  }) as typeof server.registerTool;
}

/**
 * ENG-2176 — what we tell a 2026-07-28 client it may cache, and for how long.
 *
 * The SDK requires `ttlMs` + `cacheScope` on every cacheable result and fills
 * them with `{ ttlMs: 0, cacheScope: 'private' }` when we say nothing. These
 * are the places where saying nothing is worse than deciding.
 *
 * **Everything is `private`, and that is not laziness.** One URL serves every
 * principal, and two of these results already differ per principal: the tool
 * list withholds the nine write tools from a read-only token
 * (`tools/index.ts` `grantsWriteTools`), and `server/discover` returns
 * scope-dependent `instructions` (below). A shared cache keyed on the URL
 * would hand one token's surface to another. `public` on the currently
 * uniform lists would also be a bet that they stay uniform — and the tool
 * list shows that bet already lost once.
 *
 * TTL is where the actual win is, so that is what varies:
 *
 * - `tools/list` — five minutes. The set is fixed for a process and changes
 *   only when the presenting token's scope changes. A stale list is bounded
 *   and harmless: scope is re-enforced on every call, so a tool that has gone
 *   away answers method-not-found rather than running.
 * - `prompts/list` / `resources/list` / `resources/templates/list` — an hour.
 *   These are the static REGISTRATION sets (never the contents), identical
 *   for the life of the process; `registerPrompts` and `registerResources`
 *   take no scope and branch on nothing.
 * - `server/discover` — an hour. Server identity, capabilities and supported
 *   versions are constant per process.
 *
 * `resources/read` is deliberately ABSENT, keeping the SDK's `ttlMs: 0`.
 * Its results are live collaborative data — another user committing a version
 * changes the answer — and we publish no invalidation signal, so any non-zero
 * TTL would serve a stale review surface with nothing to correct it.
 */
const CACHE_HINTS = {
  'tools/list': { ttlMs: 5 * 60 * 1000, cacheScope: 'private' },
  'prompts/list': { ttlMs: 60 * 60 * 1000, cacheScope: 'private' },
  'resources/list': { ttlMs: 60 * 60 * 1000, cacheScope: 'private' },
  'resources/templates/list': { ttlMs: 60 * 60 * 1000, cacheScope: 'private' },
  'server/discover': { ttlMs: 60 * 60 * 1000, cacheScope: 'private' },
} as const;

/**
 * ENG-2823 — everything `registerTools` needs, plus where this HOST wants tool
 * telemetry to go. Separate from `RegisterToolsOptions` because the sink is
 * not a registration input: it changes nothing about which tools exist.
 */
export interface CreateServerOptions extends RegisterToolsOptions {
  /**
   * Optional per-call telemetry destination. Omitted on the stdio surface,
   * whose only writable destination is the local file (stdout is the
   * transport). The gateway supplies its request logger, which is stdout and
   * therefore CloudWatch.
   */
  telemetry?: ToolTelemetrySink;
}

export function createServer(
  apiClient: ApiClient,
  options?: CreateServerOptions,
): McpServer {
  // ENG-2208 / ENG-2212: derived from the SAME resolution that decides which
  // registrars run, so the instructions can never advertise a write tool the
  // model has not been given. `=== 'read-only'` used to answer this
  // separately, and an unrecognised scope was told nine write tools existed;
  // a coarse boolean then told a `comments:write` token the same nine.
  const capabilities = resolveCapabilities(options);

  const server = new McpServer(
    {
      name: 'rockhopper',
      // ENG-1955: read from package.json (see logger.ts) so the version a
      // client sees in `initialize` is the version it is actually running.
      version: serviceVersion,
    },
    {
      instructions: buildInstructions(capabilities),
      // Consumed only by the 2026-07-28 encode seam; the 2025-era codec has
      // no cache path, so this cannot change what a 2025 client sees.
      cacheHints: CACHE_HINTS,
    },
  );

  installCorrelationScope(server, options?.telemetry);
  // ENG-2883 (plan 23 SP04) — tell the API client where to find the APP that
  // connected. A PROVIDER, not a value: `clientInfo` arrives with the client's
  // `initialize` and does not exist yet at this line, so reading it here would
  // record nothing forever.
  apiClient.setClientToolProvider(() => server.server.getClientVersion());
  registerResources(server, apiClient);
  registerTools(server, apiClient, options);
  registerPrompts(server, apiClient);

  return server;
}
