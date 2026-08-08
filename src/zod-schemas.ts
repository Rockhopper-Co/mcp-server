/**
 * Zod schemas for ApiClient response validation (KI-096).
 *
 * Opt-in per call site via the `responseSchema` argument to
 * `ApiClient.request()`. Parse failures throw with a clear message so
 * future backend↔mcp-server contract drift fails loudly instead of
 * silently rendering `undefined` in tool outputs (as it did pre-fix for
 * `get_cell_history`, `resolve_comment`, and `rename_file`).
 *
 * Each schema only declares fields the formatters actually consume —
 * unknown fields are stripped, missing required fields throw. Optional
 * fields keep their typed-as-undefined shape if absent.
 *
 * Schemas live in their own file rather than alongside `types.ts` so a
 * future sweep ticket can migrate the remaining ApiClient methods
 * without each fix needing to touch the shared types module.
 */
import { z } from 'zod';

/**
 * Backend `PATCH /file-chat/:chatId` returns the updated FileChat
 * entity after KI-096 (was UpdateResult). The formatter only reads
 * `internalId` + `resolved`, but the schema captures the common
 * surface that mcp-server depends on.
 */
export const FileChatSchema = z
  .object({
    internalId: z.number().int(),
    message: z.string().nullable().optional(),
    resolved: z.boolean().nullable().optional(),
    cellReference: z.string().nullable().optional(),
    createdAt: z.union([z.string(), z.date()]).optional(),
    updatedAt: z.union([z.string(), z.date()]).optional(),
  })
  .passthrough();

/**
 * Backend `PATCH /enrolled-files/:fileMsId` returns the updated
 * EnrolledFile entity after KI-096 (was UpdateResult). The
 * `rename_file` formatter reads `name` + `platformId`.
 */
export const EnrolledFileSchema = z
  .object({
    internalId: z.number().int().optional(),
    platformId: z.string(),
    name: z.string(),
    fileType: z.string().optional(),
    driveMsId: z.string().optional(),
    hasUncommittedChanges: z.boolean().nullable().optional(),
  })
  .passthrough();

/**
 * Backend `GET /file-versions/file/:fileMsId/cell-history?format=mcp`
 * returns the normalized projection added by KI-096. The mcp-server
 * formatter reads all four fields.
 */
export const CellHistoryEntrySchema = z.object({
  versionId: z.string(),
  value: z.unknown(),
  changedBy: z.string().nullable(),
  changedAt: z.string(),
  // ENG-1638 (P3-2) remainder: the widened ledger-served projection. Optional —
  // the legacy normalized fallback (not-eligible file / Google / old backend)
  // carries only the four core fields.
  formula: z.string().nullable().optional(),
  provenance: z.string().optional(),
  actorKind: z.string().nullable().optional(),
  drivingHuman: z.string().nullable().optional(),
  formatted: z.string().optional(),
});

export const CellHistoryEntryArraySchema = z.array(CellHistoryEntrySchema);

/**
 * Backend `GET /file-versions/file/:fileMsId/fold-status` (KI-1399) — the
 * authoritative queue read the strict no-partial gate consults before any
 * change-history surface serves a row (plan 02 ruling 5). Schema-parsed
 * because a drifted/absent `foldPending` must fail loudly: silently
 * `undefined` would coerce falsy and serve partial rows, which is the exact
 * failure the gate exists to prevent.
 */
export const FoldStatusSchema = z
  .object({
    fileMsId: z.string().optional(),
    foldPending: z.boolean(),
    foldTargetVersionId: z.number().int().nullable(),
    checkedAt: z.string().optional(),
  })
  .passthrough();
