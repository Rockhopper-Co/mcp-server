import {
  AI_ATTRIBUTION_SHOWN,
  PLAN_LOCKED,
  PLAN_LOCKED_ROW_MARK,
  aiAttributionSuffix,
  isPlanLocked,
  type AiAttribution,
} from '../ai-attribution.js';
import type { ApiClient } from '../api-client.js';
import {
  aiLinksClause,
  aiLinksUnavailableSuffix,
} from '../change-row-vocabulary.js';
import {
  cellHistoryUnavailableToolResult,
  isCellHistoryUnavailable,
} from '../cell-history-unavailable.js';
import {
  CURRENT,
  foldFreshness,
  mergeFreshness,
  updatingLine,
  type ReadFreshness,
} from '../ledger-freshness.js';
import { isNotReady, notReadyToolResult } from '../not-ready.js';
import {
  isPlanExcludesFeature,
  planExcludesFeatureToolResult,
} from '../plan-excludes-feature.js';
import {
  assertSheetExistsForFile,
  isUnknownSheet,
  unknownSheetToolResult,
} from '../sheet-catalogue.js';
import type { CellHistoryEntry } from '../types.js';

/**
 * The sheetName + cellAddress arm of `get_cell_history`, after the address
 * has been parsed. Its own module so `get-cell-history.ts` keeps the address
 * routing and stays under the file cap, as the anchor and Smartsheet arms do.
 */

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * A row whose AI provenance or actor kind the organization's plan withheld.
 * The backend re-renders `formatted` from the stripped entry, so that line
 * then carries the raw `plan_locked` in its provenance slot; it is detected
 * there too, by the separator the backend's template puts before it.
 */
function isWithheldRow(h: CellHistoryEntry): boolean {
  return (
    isPlanLocked(h.provenance) ||
    isPlanLocked(h.actorKind) ||
    (h.formatted?.includes(` — ${PLAN_LOCKED}`) ?? false)
  );
}

/**
 * A ledger-served entry carries a backend-rendered
 * `formatted` line — 'vX.Y.Z: <value> — <provenance> (driven by <human>) —
 * <ts>' — printed verbatim. An older backend's entry has only the four core
 * fields; it keeps the original rendering. The AI clause follows
 * either form; the display name wins.
 *
 * A withheld row never prints `formatted`, because `plan_locked` is not a
 * provenance: it prints the original rendering plus the withheld mark.
 */
export function cellHistoryLine(h: CellHistoryEntry): string {
  const ai = aiLinksClause(h.aiLinks);
  const withheld = isWithheldRow(h);
  if (h.formatted && !withheld) return `- ${h.formatted}${ai}`;
  const actor = h.changedByName ?? h.changedBy;
  return (
    `- Version ${h.versionId}: **${JSON.stringify(h.value)}**` +
    (withheld && h.formula ? ` [${h.formula}]` : '') +
    (actor ? ` — by ${actor}` : '') +
    (withheld ? ` — ${PLAN_LOCKED_ROW_MARK}` : '') +
    `${ai} — ${h.changedAt}`
  );
}

export async function readCellHistory(
  api: ApiClient,
  fileMsId: string,
  sheetName: string,
  cell: string,
): Promise<ToolResult> {
  try {
    // ledger reads never refuse: a pending fold no longer
    // withholds the rows, it marks them UPDATING. Either source saying
    // `updating` wins: the fold probe, or the backend's `X-Ledger-Freshness`
    // answer to the capability header.
    const fold = await foldFreshness(api, fileMsId);
    let served: ReadFreshness = CURRENT;
    // the backend's `X-AI-Links-Available`; true when absent.
    let linksChecked = true;
    // The backend's `X-AI-Attribution`; shown when absent.
    let attribution: AiAttribution = AI_ATTRIBUTION_SHOWN;
    const history = await api.getCellHistory(fileMsId, sheetName, cell, {
      onFreshness: (f) => {
        served = f;
      },
      onAiLinksAvailable: (available) => {
        linksChecked = available;
      },
      onAiAttribution: (a) => {
        attribution = a;
      },
    });
    const freshness = mergeFreshness(fold, served);

    // a caller who misspells the sheet the same way in both
    // arguments passed every address check and got "No history found", which
    // this tool's own description establishes as a positive claim about the
    // cell. Only the empty answer pays for the existence check: a row that
    // came back names the sheet it is on.
    if (history.length === 0) {
      await assertSheetExistsForFile(api, fileMsId, sheetName);
    }

    const summary = history.map(cellHistoryLine).join('\n');

    // Render the normalized cell, so the qualified and bare forms of one
    // address answer identically rather than merely equivalently.
    const listed = `Cell ${cell} on "${sheetName}" — ${history.length} change(s)`;
    // never "No history found" while updating: that sentence is a
    // positive claim about the cell, and an updating zero is not one.
    const text =
      freshness.state === 'updating'
        ? `${updatingLine(history.length, freshness.retryAfterSeconds)}\n\n` +
          (history.length ? `${listed}:\n\n${summary}` : `${listed} so far.`)
        : history.length
          ? `${listed}:\n\n${summary}`
          : `No history found for ${cell} on "${sheetName}".`;
    return {
      content: [
        {
          type: 'text',
          text:
            text +
            aiLinksUnavailableSuffix(linksChecked) +
            aiAttributionSuffix(attribution),
        },
      ],
    };
  } catch (error) {
    // A not-ready answer is a refusal, never an error string: the generic
    // branch below hands the model prose it may read as "the tool is broken,
    // answer from what I already have".
    if (isNotReady(error)) return notReadyToolResult(error);
    // a sheet that cannot be shown to exist is a refusal naming the
    // sheet, never the "No history found" branch above.
    if (isUnknownSheet(error)) return unknownSheetToolResult(error);
    // the backend cannot reconstruct this file's history.
    if (isCellHistoryUnavailable(error)) {
      return cellHistoryUnavailableToolResult(cell, sheetName);
    }
    // The organization's plan does not include what the read asked for.
    if (isPlanExcludesFeature(error)) return planExcludesFeatureToolResult();
    return {
      content: [
        {
          type: 'text',
          text: `Failed to get cell history: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}
