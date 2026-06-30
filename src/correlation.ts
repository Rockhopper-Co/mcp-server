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
 * `randomUUID` comes from `node:crypto` (NOT the global `crypto`) because the
 * package supports Node 18, where global `crypto.randomUUID` is not
 * guaranteed.
 */
const als = new AsyncLocalStorage<string>();

/**
 * Runs `fn` inside an AsyncLocalStorage scope carrying `id`. Reads via
 * {@link getCorrelationId} anywhere in the (sync or async) continuation
 * return the same id. Mints a fresh UUID v4 when `id` is omitted.
 */
export const runWithCorrelationId = <T>(
  fn: () => T,
  id: string = randomUUID(),
): T => als.run(id, fn);

/** Current correlation id, or `undefined` when called outside a scope. */
export const getCorrelationId = (): string | undefined => als.getStore();
