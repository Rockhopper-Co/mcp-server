/**
 * ENG-2204 — how the confirmation question reaches a human, given a client
 * that may support one, two or three ways of asking one.
 *
 * There are three lanes and they are not alternatives to pick between — they
 * are a ladder, and every client can climb at least the bottom rung:
 *
 * 1. **The tool result** (universal). The answer says "ask the user which one,
 *    then call again with their number". Works on every client that has ever
 *    spoken MCP, because it is just text.
 * 2. **`elicitation/create`** (2025-era sessions that advertise it). The client
 *    renders a real picker; the server waits for the answer inside the call.
 * 3. **`InputRequiredResult`** (2026-07-28 sessions). Elicitation is gone from
 *    that revision as a server→client request; the same question rides back as
 *    a result the client fulfils and retries.
 *
 * The ladder matters more than any one rung. A client that supports none of
 * the richer lanes still gets a usable question — it does NOT get an enrolment
 * it never confirmed, and it does not get an error. Degrading is the design.
 */

import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  type ServerContext,
} from '@modelcontextprotocol/server';

/** The protocol revision on which lane 3 is the only richer lane there is. */
const MRTR_PROTOCOL_VERSION = '2026-07-28';

/** The key both richer lanes carry the confirmation under. */
export const CONFIRM_KEY = 'confirm_file';

export type ConfirmationLane = 'input_required' | 'elicitation' | 'tool_result';

/** Read one key off the per-request envelope, which is typed as an open bag. */
function envelopeValue(ctx: ServerContext | undefined, key: string): unknown {
  const envelope = ctx?.mcpReq?.envelope as Record<string, unknown> | undefined;
  return envelope?.[key];
}

/**
 * Whether this REQUEST is on the 2026-07-28 wire.
 *
 * Read off the request envelope rather than off the connection, because that
 * is where the SDK puts it: `_meta['io.modelcontextprotocol/protocolVersion']`
 * arrives on every modern request, and `stdio-2026-07-28.e2e.test.ts` drives
 * exactly that shape.
 */
export function isModernEra(ctx: ServerContext | undefined): boolean {
  return envelopeValue(ctx, PROTOCOL_VERSION_META_KEY) === MRTR_PROTOCOL_VERSION;
}

/**
 * Whether the client said it can render an elicitation.
 *
 * Two sources, checked in this order and for different reasons. A modern
 * request carries the client's capabilities in its own envelope, which is the
 * authority for THAT request. A 2025-era session declared them once at
 * `initialize`, and the connection is the only place that survives.
 *
 * ABSENT means NO. A client that never said it can ask a question is not
 * assumed to be able to — the cost of guessing wrong is a call that hangs
 * waiting for an answer nobody will ever be shown.
 */
export function advertisesElicitation(
  ctx: ServerContext | undefined,
  connectionCapabilities: Record<string, unknown> | undefined,
): boolean {
  const fromEnvelope = envelopeValue(ctx, CLIENT_CAPABILITIES_META_KEY);
  if (fromEnvelope && typeof fromEnvelope === 'object') {
    return 'elicitation' in fromEnvelope;
  }
  return !!connectionCapabilities && 'elicitation' in connectionCapabilities;
}

/**
 * The best rung this request can climb.
 *
 * Lane 2 is deliberately unreachable on the modern era even when the client
 * advertises `elicitation`: the SDK's `ctx.mcpReq.elicitInput` THROWS on a
 * 2026-07-28 request, so treating the capability as sufficient would turn the
 * richest client into the only one that fails.
 */
export function selectLane(
  ctx: ServerContext | undefined,
  connectionCapabilities: Record<string, unknown> | undefined,
): ConfirmationLane {
  if (isModernEra(ctx)) return 'input_required';
  if (advertisesElicitation(ctx, connectionCapabilities)) return 'elicitation';
  return 'tool_result';
}

/**
 * The nonce a retried modern request is echoing back.
 *
 * Untrusted by construction — it round-trips through the client, nothing signs
 * it, and the SDK hands back whatever arrived. It is used as a Map key and for
 * nothing else: an unrecognised one finds no candidate set, which is the same
 * answer as a malicious one.
 */
export function readRequestState(ctx: ServerContext | undefined): string | null {
  try {
    const state = ctx?.mcpReq?.requestState?.();
    return typeof state === 'string' ? state : null;
  } catch {
    // A configured verify hook rejecting the state is a refusal, not a crash:
    // the caller treats "no usable nonce" and "a nonce we do not know" alike.
    return null;
  }
}
