import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Phase 1.1 / KI-226 — correlation id propagation.
 *
 * Per-tool-call scope: a single correlation id covers every outbound
 * Rockhopper API call a tool invocation makes (including multi-call
 * fan-outs like search). The id rides the `X-Correlation-Id` header out of
 * {@link ApiClient.request}, so an mcp-server-originated request is
 * traceable as a group in backend logs.
 *
 * The id is a non-sensitive UUID v4 — never co-log the bearer token with it.
 * `randomUUID` comes from `node:crypto` (NOT the global `crypto`): the explicit
 * import is the portable form and does not depend on the global being present.
 */
interface Scope {
  id: string;
  tool?: string;
}

const als = new AsyncLocalStorage<Scope>();

/**
 * Runs `fn` inside an AsyncLocalStorage scope carrying `id`. Reads via
 * {@link getCorrelationId} anywhere in the (sync or async) continuation
 * return the same id. Mints a fresh UUID v4 when `id` is omitted.
 *
 * ENG-8848: `tool` is the MCP tool name for this call. It rides next to the id
 * so {@link ApiClient.request} can send `X-MCP-Tool` (the stdio twin of what
 * mcp-gateway sends), giving the backend the tool name for its audit row.
 */
export const runWithCorrelationId = <T>(
  fn: () => T,
  id: string = randomUUID(),
  tool?: string,
): T => als.run({ id, tool }, fn);

/** Current correlation id, or `undefined` when called outside a scope. */
export const getCorrelationId = (): string | undefined => als.getStore()?.id;

/** Current tool name (ENG-8848), or `undefined` outside a tool-call scope. */
export const getToolName = (): string | undefined => als.getStore()?.tool;
