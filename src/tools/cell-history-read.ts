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
  billingRefusalCodeOf,
  billingRefusalToolResult,
} from '../billing-refusal.js';
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
 * A row whose AI provenance, actor kind or actor claim the organization's plan
 * withheld. The claim matters on its own: a person accepting an AI suggestion
 * keeps the `human_direct` cause and the `user` actor kind, so the backend
 * locks only `actorClaim` on that row.
 */
function isWithheldRow(h: CellHistoryEntry): boolean {
  return (
    isPlanLocked(h.provenance) ||
    isPlanLocked(h.actorKind) ||
    isPlanLocked(h.actorClaim)
  );
}

/**
 * The backend's line for a withheld row, kept so its time wording (an edit
 * window, or "first seen") matches the rows around it. When the provenance is
 * locked, the backend wrote `plan_locked` into its provenance slot, the last
 * ` — plan_locked` on the line (the value comes before it); only that slot is
 * replaced. A lock carried by the actor kind or claim alone leaves nothing to
 * replace, so the mark is appended.
 */
function withheldFormatted(h: CellHistoryEntry, formatted: string): string {
  const slot = ` — ${PLAN_LOCKED}`;
  const at = isPlanLocked(h.provenance) ? formatted.lastIndexOf(slot) : -1;
  if (at === -1) return `${formatted} — ${PLAN_LOCKED_ROW_MARK}`;
  return (
    `${formatted.slice(0, at)} — ${PLAN_LOCKED_ROW_MARK}` +
    formatted.slice(at + slot.length)
  );
}

/**
 * A ledger-served entry carries a backend-rendered
 * `formatted` line — 'vX.Y.Z: <value> — <provenance> (driven by <human>) —
 * <when>' — printed verbatim. An older backend's entry has only the four core
 * fields; it keeps the original rendering. The AI clause follows
 * either form; the display name wins.
 *
 * A withheld row never prints the raw `plan_locked`: it is not a provenance.
 */
export function cellHistoryLine(h: CellHistoryEntry): string {
  const ai = aiLinksClause(h.aiLinks);
  const withheld = isWithheldRow(h);
  if (h.formatted) {
    return `- ${withheld ? withheldFormatted(h, h.formatted) : h.formatted}${ai}`;
  }
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
    // A billing refusal is not "still producing": render it by its code.
    const billing = billingRefusalCodeOf(error);
    if (billing !== null) return billingRefusalToolResult(billing);
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
