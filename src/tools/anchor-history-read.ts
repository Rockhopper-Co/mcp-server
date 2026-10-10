import type { ApiClient } from '../api-client.js';
import {
  anchorHistoryUnavailableToolResult,
  isCellHistoryUnavailable,
} from '../cell-history-unavailable.js';
import { formatDocumentRow } from '../document-changes.js';
import {
  CURRENT,
  foldFreshness,
  mergeFreshness,
  updatingLine,
  type ReadFreshness,
} from '../ledger-freshness.js';
import { isNotReady, notReadyToolResult } from '../not-ready.js';
import type { DocumentAnchorHistory } from '../types.js';

/**
 * ENG-6433 — the anchorId arm of `get_cell_history`: the history of ONE Word /
 * Google Docs paragraph or PowerPoint / Google Slides shape.
 *
 * Its own module so `get-cell-history.ts` keeps the address routing and stays
 * under the file cap; rows render through `document-changes.ts`'s row
 * renderer, the one `get_unattributed_changes` uses for the same rows.
 *
 * EVERY EXIT IS ROWS, AN EMPTY ANSWER ABOUT THIS ELEMENT ONLY, OR A NAMED
 * REFUSAL — the same three the cell arm has.
 */

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function versionNote(boundVersionId: number | null): string {
  return boundVersionId === null
    ? ' [not yet saved in a version]'
    : ` [saved in version id ${boundVersionId}]`;
}

/** Facts about what the rows cover, stated about the result, never the mechanism. */
function coverageNotes(response: DocumentAnchorHistory): string[] {
  const notes: string[] = [];
  if (response.anchorLane !== 'both') {
    notes.push(
      'These are the changes recorded under this id. The same shape may also ' +
        'have changes recorded under a different id, so this is not the whole ' +
        'history of the shape.',
    );
  }
  if (response.anchorIdentity === 'positional') {
    notes.push(
      'This element was matched by its position, so these rows follow that ' +
        'position, which may have held different paragraphs over time.',
    );
  }
  if (response.truncated) {
    notes.push(
      'More changes exist than are shown here; the most recent ones are not ' +
        'listed.',
    );
  }
  return notes;
}

export function formatAnchorHistory(
  response: DocumentAnchorHistory,
  freshness: ReadFreshness = CURRENT,
): string {
  const notes = coverageNotes(response);
  // ENG-7243 — an updating answer opens with the marker, and an updating zero
  // is never the "No change recorded" sentence, which is a claim about the
  // element.
  if (freshness.state === 'updating') {
    const n = response.history.length;
    const rows = response.history
      .map((row) => formatDocumentRow(row) + versionNote(row.boundVersionId))
      .join('\n');
    return [
      updatingLine(n, freshness.retryAfterSeconds),
      '',
      `Element "${response.anchorId}" — ${n} change(s) so far, oldest first` +
        (n ? ':' : '.'),
      ...(n ? ['', rows] : []),
      ...(notes.length ? ['', ...notes] : []),
    ].join('\n');
  }
  if (response.history.length === 0) {
    return [
      `No change recorded for element "${response.anchorId}". This is an ` +
        'answer about that one element: it says nothing about the rest of ' +
        'the file and is never grounds for saying the file is unchanged.',
      ...notes,
    ].join('\n');
  }
  const rows = response.history
    .map((row) => formatDocumentRow(row) + versionNote(row.boundVersionId))
    .join('\n');
  return [
    `Element "${response.anchorId}" — ${response.history.length} change(s), ` +
      'oldest first:',
    '',
    rows,
    ...(notes.length ? ['', ...notes] : []),
  ].join('\n');
}

export async function readAnchorHistory(
  api: ApiClient,
  fileMsId: string,
  anchorId: string,
): Promise<ToolResult> {
  try {
    // ENG-7243 — same freshness inputs as the cell arm, plus the body field
    // this envelope can carry: any one saying `updating` marks the answer.
    const fold = await foldFreshness(api, fileMsId);
    let served: ReadFreshness = CURRENT;
    const response = await api.getAnchorHistory(fileMsId, anchorId, {
      onFreshness: (f) => {
        served = f;
      },
    });
    const body: ReadFreshness =
      response.ledgerFreshness?.state === 'updating'
        ? { ...CURRENT, state: 'updating' }
        : CURRENT;
    const freshness = mergeFreshness(mergeFreshness(fold, served), body);
    return {
      content: [{ type: 'text', text: formatAnchorHistory(response, freshness) }],
    };
  } catch (error) {
    if (isNotReady(error)) return notReadyToolResult(error);
    if (isCellHistoryUnavailable(error)) {
      return anchorHistoryUnavailableToolResult(anchorId);
    }
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
