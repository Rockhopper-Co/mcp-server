/**
 * ENG-8021 — the safety hints every tool states, all three explicitly.
 *
 * The MCP spec lets a tool omit any hint and gives each a default, but a host
 * reading an omitted hint has to guess which default the author meant, and
 * OpenAI's connector review rejects a tool that leaves any of the three out.
 * So each one is REQUIRED here: a registration written as
 * `annotations: { ... } satisfies ToolAnnotations` that forgets one is a type
 * error, not a silent default.
 *
 * - `readOnlyHint` — the call changes nothing, in Rockhopper or anywhere else.
 * - `destructiveHint` — the call overwrites or removes something a user cannot
 *   get back by running the tool again. Always `false` for a read tool.
 * - `openWorldHint` — the call reaches Microsoft (Graph) or Google (Drive)
 *   rather than only Rockhopper's own stored data.
 *
 * `idempotentHint` stays optional: it only means something for a write.
 *
 * The type does not see a registration that skips `satisfies`; the catalogue
 * test `tool-annotations.explicit.test.ts` reads every tool off `tools/list`
 * in every scope and fails naming the tool that lacks a hint.
 */
export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly openWorldHint: boolean;
  readonly idempotentHint?: boolean;
}

/** The three hints a tool must state; the test enumerates exactly these. */
export const REQUIRED_TOOL_HINTS = [
  'readOnlyHint',
  'destructiveHint',
  'openWorldHint',
] as const satisfies readonly (keyof ToolAnnotations)[];
