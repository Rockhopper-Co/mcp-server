import {
  GRAPH_LINK_FAILURE_TEXT,
  graphLinkFailureFrom,
} from '../graph-link-failure.js';
import type {
  DriveInventoryFreshness,
  DriveInventoryItem,
  DriveInventoryLaneFreshness,
  FileProvider,
} from '../types.js';

/**
 * ENG-6410 — what `list_unenrolled_files` prints, derived from the backend's
 * per-provider freshness rather than from a hardcoded provider.
 *
 * Moved out of `list-unenrolled-files.ts` so that file holds the tool's
 * contract and this one holds its words. The Microsoft-only output is
 * byte-identical to what shipped before the Google lane existed; that is
 * pinned by `tools.list-unenrolled.google.test.ts`.
 */

/**
 * ENG-4283 / ENG-6409 — the backend's codes for "this lane does not serve this
 * account". Duplicated rather than imported: this package ships over npm and
 * takes no build dependency on the API tree. EXACT match — an unknown value
 * falls through rather than being guessed at (ENG-4311).
 */
const INAPPLICABLE: Readonly<Record<string, { covers: string; lacks: string }>> = {
  NO_MICROSOFT_TENANT: { covers: 'OneDrive and SharePoint', lacks: 'no Microsoft link' },
  NO_GOOGLE_GRANT: { covers: 'Google Drive', lacks: 'no Google connection' },
};

/**
 * Every lane the backend reported. A backend older than ENG-6409 sends no
 * `providers` and served Microsoft alone, so its top level IS that one lane.
 */
function lanesOf(freshness: DriveInventoryFreshness): DriveInventoryLaneFreshness[] {
  if (freshness.providers?.length) return freshness.providers;
  const { providers: _absent, ...top } = freshness;
  return [{ ...top, provider: 'microsoft' }];
}

/**
 * The lanes that serve this caller — the ones its rows can come from. A code
 * this package does not know is NOT read as "unserved" (ENG-4311: match the
 * known codes exactly and fall through on anything else).
 */
function servedLanes(freshness: DriveInventoryFreshness): DriveInventoryLaneFreshness[] {
  return lanesOf(freshness).filter(
    (lane) => !lane.inapplicableReason || !INAPPLICABLE[lane.inapplicableReason],
  );
}

/** Total over the provider union: a new provider fails to compile here. */
function readerName(provider: FileProvider): string {
  switch (provider) {
    case 'microsoft':
      return 'Microsoft';
    case 'google':
      return 'Google';
    default: {
      const unhandled: never = provider;
      return String(unhandled);
    }
  }
}

/**
 * "workbook" while only Microsoft serves the caller, exactly as before; "file"
 * once a Google lane does, because that lane lists Docs and Slides too.
 */
function noun(freshness: DriveInventoryFreshness): string {
  return servedLanes(freshness).some((lane) => lane.provider === 'google')
    ? 'file'
    : 'workbook';
}

/**
 * ENG-2814 — the "there is more" line, and it is never optional when a cursor
 * came back. Written to the MODEL: it names the exact next call, because a
 * hint that only says "more available" gets summarised away.
 */
function moreToCome(nextCursor: string | null): string {
  if (!nextCursor) return '';
  return (
    `\n\nMORE FILES REMAIN — this is not the whole list. Call ` +
    `\`list_unenrolled_files\` again with \`cursor="${nextCursor}"\`, and ` +
    'keep going until a response comes back with no cursor. Do not tell the ' +
    'user what they do or do not have until then. The cursor stops working 30 ' +
    'minutes after the first page; if it is refused as expired, start again ' +
    'from the first page rather than retrying it.'
  );
}

/**
 * The identity line `enroll_file` can act on, in the row's own provider's
 * terms. A Microsoft row keeps its id pair. A Google row has no drive id and
 * `enroll_file` takes a Google file only by its link, so the link is the id
 * printed; with no link recorded the row says so rather than composing one.
 */
function identityLine(item: DriveInventoryItem): string {
  const provider = item.provider ?? 'microsoft';
  switch (provider) {
    case 'microsoft':
      return `  msId: ${item.msId}, driveMsId: ${item.driveMsId}`;
    case 'google':
      return item.webUrl
        ? `  provider: google, fileId: ${item.msId} — enroll with url: ${item.webUrl}`
        : `  provider: google, fileId: ${item.msId} — no link recorded; ask ` +
            'the user for its link and pass that to `enroll_file` as `url`';
    default: {
      const unhandled: never = provider;
      return `  provider: ${String(unhandled)}, fileId: ${item.msId}`;
    }
  }
}

export function renderFound(
  items: readonly DriveInventoryItem[],
  freshness: DriveInventoryFreshness,
  nextCursor: string | null = null,
): string {
  const lines = items.map((item) => {
    const where = item.parentPath ? ` in ${item.parentPath}` : '';
    const modified = item.lastModifiedAt
      ? `, modified ${item.lastModifiedAt}`
      : '';
    // `hidden` means the user REMOVED this file before; enrolling restores
    // rather than duplicates, the only thing distinguishing it from new.
    const previously =
      item.enrollmentState === 'hidden' ? ' [previously removed]' : '';
    return (
      `- **${item.name}**${where}${modified}${previously}\n` +
      identityLine(item)
    );
  });

  // "on this page", never a bare count: with a cursor outstanding the number
  // is a page size, not a total.
  const counted = nextCursor
    ? `${items.length} ${noun(freshness)}(s) not yet in Rockhopper on this page:`
    : `${items.length} ${noun(freshness)}(s) not yet in Rockhopper:`;

  return (
    `${counted}\n\n` +
    `${lines.join('\n')}\n\n${dateline(freshness)}${moreToCome(nextCursor)}`
  );
}


/**
 * No lane serves the account. No retry language (nothing changes on a later
 * call), no `connect_microsoft` (ENG-2614's loop), and the scope named from
 * the lanes the backend reported rather than assumed.
 */
function inapplicableText(freshness: DriveInventoryFreshness): string {
  const known = lanesOf(freshness)
    .map((lane) => INAPPLICABLE[lane.inapplicableReason ?? ''])
    .filter((entry) => entry !== undefined);
  return (
    `Rockhopper's drive inventory covers ${known.map((k) => k.covers).join(' and ')}, ` +
    `and this account has ${known.map((k) => k.lacks).join(' and ')} — so ` +
    'there is nothing for it to list and nothing to retry. This is NOT ' +
    'evidence that every file is already in Rockhopper, and it does not mean ' +
    'the user has no files: it means this particular list cannot see them. ' +
    'Do not call `list_unenrolled_files` again for this user, and do not ' +
    'report their drive as covered. A file the user can link to is still ' +
    'added with `enroll_file` and that link.'
  );
}

/** A Google lane whose refresh could not use the user's Google credential. */
const GOOGLE_LINK_FAILURE_TEXT =
  'Rockhopper cannot see this user\'s Google Drive files: their Google ' +
  'account is not connected, or its connection has expired. Ask the user to ' +
  'connect Google Drive in Rockhopper Settings; do not compose a sign-in link ' +
  'yourself. This list will stay empty until that is done, which is NOT the ' +
  'same as having nothing to add.';

/** The first serving lane whose last refresh failed on its link, as text. */
function linkFailureText(freshness: DriveInventoryFreshness): string | null {
  for (const lane of servedLanes(freshness)) {
    const failure = graphLinkFailureFrom(lane.lastFailureReason);
    if (!failure) continue;
    switch (lane.provider) {
      case 'microsoft':
        return GRAPH_LINK_FAILURE_TEXT[failure];
      case 'google':
        return GOOGLE_LINK_FAILURE_TEXT;
      default: {
        const unhandled: never = lane.provider;
        return String(unhandled);
      }
    }
  }
  return null;
}

export function renderEmpty(
  freshness: DriveInventoryFreshness,
  nextCursor: string | null = null,
): string {
  // ORDER IS LOAD-BEARING (ENG-4283, ENG-4311, ENG-2814). An account no lane
  // serves comes first: every later branch assumes a lane covers the caller,
  // and its never-refreshed branch would otherwise claim a scan "has been
  // started" forever. A broken link and an unfinished first refresh come next,
  // because neither has anything to page THROUGH.
  if (freshness.inapplicableReason && INAPPLICABLE[freshness.inapplicableReason]) {
    return inapplicableText(freshness);
  }

  const linkFailure = linkFailureText(freshness);
  if (linkFailure) return linkFailure;

  if (!freshness.asOf) {
    return (
      'No answer yet — the first scan of this user\'s drive has not finished. ' +
      `${freshness.refreshing ? 'One is running now.' : 'One has been started.'} ` +
      'Try again shortly. This is NOT evidence that every workbook is already ' +
      `in Rockhopper.${failureNote(freshness)}`
    );
  }

  // ENG-2814 — an empty page WITH a cursor is the middle of a walk: the
  // backend filters after cutting a chunk and stops at a scan budget.
  if (nextCursor) {
    return (
      'No un-enrolled workbooks on this page — but the search is NOT ' +
      'finished, and this says nothing yet about what the user has.' +
      `${moreToCome(nextCursor)}`
    );
  }

  if (freshness.consecutiveFailures > 0) {
    return (
      'No un-enrolled workbooks in the stored list, but the list is not ' +
      `trustworthy right now.${failureNote(freshness)}\n\n${dateline(freshness)}`
    );
  }

  return (
    `Every ${noun(freshness)} Rockhopper has seen for this user is already in ` +
    `Rockhopper.\n\n${dateline(freshness)}`
  );
}

/**
 * How old the answer is, on every branch that has an answer, and which
 * providers it was read from — never omitted, because the rows are stored.
 */
function dateline(freshness: DriveInventoryFreshness): string {
  const asOf = freshness.asOf
    ? `As of ${freshness.asOf}`
    : 'Never successfully refreshed';
  const stale = freshness.stale ? ' (stale)' : '';
  const refreshing = freshness.refreshing
    ? ' A refresh is running; call again for a newer answer.'
    : '';
  const served = servedLanes(freshness);
  const readers = (served.length ? served : lanesOf(freshness))
    .map((lane) => readerName(lane.provider))
    .join(' or ');
  return (
    `${asOf}${stale} — from Rockhopper's stored records, not a live ` +
    `${readers} read.${refreshing}${failureNote(freshness)}`
  );
}

function failureNote(freshness: DriveInventoryFreshness): string {
  if (!freshness.consecutiveFailures || !freshness.lastFailureAt) return '';
  return (
    ` Refresh has failed ${freshness.consecutiveFailures} time(s) in a row, ` +
    `last at ${freshness.lastFailureAt}` +
    `${freshness.lastFailureReason ? ` (${freshness.lastFailureReason})` : ''}.`
  );
}
