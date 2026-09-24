/**
 * ENG-4347 — a `sheetName` the workbook does not have used to render as an
 * EMPTY ANSWER: `No unattributed changes on sheet "Project Acruals"` and
 * `No history found for BS11 on "Project Acruals"` were byte-identical to the
 * answers a real sheet with genuinely nothing on it produces. The tool named
 * the misspelling back to the caller, which reads as confirmation that the
 * sheet was found.
 *
 * That matters here more than it would in a user interface. Both tool
 * descriptions establish that an empty result is a POSITIVE claim — they
 * promise `CHANGE_HISTORY_NOT_READY` as an `isError` while history is
 * computing and warn that the error "is NOT 'no changes'". The corollary is
 * that a plain empty answer asserts there are none. So one wrong character
 * turned a sheet holding pending edits into a clean bill of health.
 *
 * The rule this module enforces: `No unattributed changes on sheet X` is
 * reachable only for a sheet that EXISTS.
 *
 * WHY THE CHECK IS EXACT-MATCH, WHICH IS THE ONE DECISION WORTH READING.
 * Both backend lanes filter on the caller's string with case-SENSITIVE SQL
 * equality — `unattributed-changes.service.ts!findChangesBySheet` binds
 * `change.sheetName = :sheetName`, and `cell-history.query.ts!sheetPredicate`
 * binds `"sheet_name" = $N`. So `project accruals` matches nothing on a
 * workbook whose sheet is `Project Accruals`, and produces the identical
 * false negative a misspelling does. A case-INSENSITIVE existence check would
 * therefore wave through the input class that reaches this guard most often,
 * and the guard would be satisfied by accident.
 *
 * Case is not ignored, then — it is REPORTED. A name that matches only
 * case-insensitively is its own refusal carrying the exact spelling, so the
 * caller can re-send something the query can match. The comparison used to
 * find that near-match is `sheetNamesAgree`, deliberately: ENG-4340 already
 * chose case-insensitive-and-trimmed for the address prefix and the two must
 * not disagree about what "the same sheet" means.
 *
 * COST. The catalogue read happens ONLY on the empty path. A non-empty answer
 * is its own proof that the sheet exists, so it pays nothing. This is the
 * trade `search.ts` already makes one ambiguity over (ENG-2824: "an empty
 * answer is the only ambiguous one, so it is the only one that pays for the
 * version read").
 *
 * DISCLOSURE. The refusal lists the sheet names of the SAME workbook the
 * caller just queried, fetched through a route guarded for that same file
 * (`EnrolledFileUserAccessGuard` / Google's own per-user ACL). It never
 * reaches another file, so it can reveal nothing the caller could not already
 * read. No near-match is suggested from anywhere else.
 */
import { changeModelForFileType, type KnownFileType } from './document-changes.js';
import { isDefinitiveRejection } from './not-ready.js';
import { sheetNamesAgree } from './tools/cell-address.js';

/** Why a sheet-scoped answer is being refused instead of served empty. */
export type UnknownSheetReason =
  /** No sheet in the workbook matches, even ignoring case and surrounding space. */
  | 'sheet_not_found'
  /**
   * A sheet matches ignoring case/space but NOT exactly. The backend filters on
   * the caller's literal string, so this name can never match a row — the empty
   * answer would be as false as a misspelling's.
   */
  | 'sheet_name_not_exact'
  /**
   * The catalogue could not be read, so existence is UNKNOWN. This is the one
   * reason that is not a statement about the workbook. It fails CLOSED for the
   * same reason `assertChangeHistoryComplete` does: on a machine surface a
   * wrong "there are no changes" is a fabricated fact, and an unproven sheet
   * cannot license one.
   */
  | 'sheet_catalogue_unavailable';

/** Grep markers; also the first token of the refusal an assistant sees. */
export const SHEET_NOT_FOUND_MARKER = 'SHEET_NOT_FOUND';
export const SHEET_NAME_NOT_EXACT_MARKER = 'SHEET_NAME_NOT_EXACT';
export const SHEET_CATALOGUE_UNAVAILABLE_MARKER = 'SHEET_CATALOGUE_UNAVAILABLE';

const MARKER_FOR: Record<UnknownSheetReason, string> = {
  sheet_not_found: SHEET_NOT_FOUND_MARKER,
  sheet_name_not_exact: SHEET_NAME_NOT_EXACT_MARKER,
  sheet_catalogue_unavailable: SHEET_CATALOGUE_UNAVAILABLE_MARKER,
};

/**
 * How many sheet names the refusal prints. A workbook can carry hundreds and
 * the point of the list is to let the caller spot their typo, not to dump the
 * file. The count DROPPED is always stated — a bound that hides what it cut
 * reads as "that is all of them".
 */
export const MAX_LISTED_SHEETS = 50;

/** Poll hint for the one reason that may clear by itself. */
export const CATALOGUE_RETRY_AFTER_SECONDS = 15;

export class UnknownSheetError extends Error {
  /** Structural marker, so a wrapper can be recognised without importing. */
  readonly unknownSheet = true as const;
  readonly reason: UnknownSheetReason;
  readonly sheetName: string;
  readonly fileName: string | null;
  /** The workbook's real sheet names. EMPTY when the catalogue was unreadable. */
  readonly knownSheets: readonly string[];
  /** The spelling the query CAN match; only set for `sheet_name_not_exact`. */
  readonly exactSheetName: string | null;

  constructor(ctx: {
    reason: UnknownSheetReason;
    sheetName: string;
    fileName?: string | null;
    knownSheets?: readonly string[];
    exactSheetName?: string | null;
  }) {
    super(
      `${MARKER_FOR[ctx.reason]}: sheetName=${JSON.stringify(ctx.sheetName)} ` +
        `reason=${ctx.reason} — nothing was looked up, and this is NOT an ` +
        `empty result.`,
    );
    this.name = 'UnknownSheetError';
    this.reason = ctx.reason;
    this.sheetName = ctx.sheetName;
    this.fileName = ctx.fileName ?? null;
    this.knownSheets = ctx.knownSheets ?? [];
    this.exactSheetName = ctx.exactSheetName ?? null;
  }
}

/** Matches the typed error AND any error carrying one as `cause`. */
export function isUnknownSheet(err: unknown): err is UnknownSheetError {
  if (err instanceof UnknownSheetError) return true;
  const cause = (err as { cause?: unknown } | null | undefined)?.cause;
  return cause instanceof UnknownSheetError;
}

export interface UnknownSheetToolResult {
  /** The SDK's `CallToolResult` carries an index signature; mirror it. */
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
}

function unwrap(err: unknown): UnknownSheetError {
  if (err instanceof UnknownSheetError) return err;
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof UnknownSheetError) return cause;
  /* istanbul ignore next — `isUnknownSheet` gates every call site. */
  throw err;
}

/** The sheet list, bounded, with the bound stated rather than implied. */
function describeSheets(sheets: readonly string[]): string {
  const shown = sheets.slice(0, MAX_LISTED_SHEETS);
  const dropped = sheets.length - shown.length;
  const names = shown.map((s) => JSON.stringify(s)).join(', ');
  return dropped > 0
    ? `${names} — and ${dropped} more not listed here (${sheets.length} sheets in total).`
    : `${names}.`;
}

/**
 * The tool answer for a sheet that cannot be shown to exist. Three defences,
 * the same three `notReadyToolResult` uses, because one is not enough against
 * a model that wants to be helpful: `isError`, prose that names the wrong
 * inference explicitly, and a JSON object to branch on.
 *
 * Every sentence is selected by the reason that FIRED — none is written to
 * cover several cases at once, so a refusal never carries a claim its own
 * branch did not establish.
 */
export function unknownSheetToolResult(err: unknown): UnknownSheetToolResult {
  const e = unwrap(err);
  const inFile = e.fileName ? ` in "${e.fileName}"` : '';
  const doNot =
    `Do NOT say there are no changes on that sheet, that it is unchanged, ` +
    `or that its history is empty — none of that is known.\n`;

  let body: string;
  if (e.reason === 'sheet_not_found') {
    body =
      `${JSON.stringify(e.sheetName)} is not a worksheet${inFile}, so nothing ` +
      `was looked up.\n` +
      doNot +
      `The worksheets are: ${describeSheets(e.knownSheets)}\n` +
      `Re-send with one of those names, spelled exactly as listed.\n`;
  } else if (e.reason === 'sheet_name_not_exact') {
    body =
      `${JSON.stringify(e.sheetName)} is not spelled the way this worksheet` +
      `${inFile} is stored — it differs in capitalisation or surrounding ` +
      `spaces, and the lookup matches the name exactly, so nothing was found ` +
      `and nothing was looked up.\n` +
      doNot +
      `The exact name is ${JSON.stringify(e.exactSheetName)}. Re-send with ` +
      `that spelling.\n`;
  } else {
    body =
      `Rockhopper could not read the list of worksheets${inFile}, so it ` +
      `cannot confirm that ${JSON.stringify(e.sheetName)} is one of them.\n` +
      doNot +
      `Retry in ${CATALOGUE_RETRY_AFTER_SECONDS} seconds.\n`;
  }

  return {
    content: [
      {
        type: 'text',
        text:
          `${MARKER_FOR[e.reason]} — this is NOT a result and NOT an empty ` +
          `result.\n` +
          body +
          JSON.stringify({
            status: 'unknown_sheet',
            reason: e.reason,
            sheetName: e.sheetName,
            exactSheetName: e.exactSheetName,
            knownSheets: e.knownSheets.slice(0, MAX_LISTED_SHEETS),
            knownSheetCount: e.knownSheets.length,
          }),
      },
    ],
    isError: true,
  };
}

/** Which route carries a workbook's sheet catalogue, or `null` for no catalogue. */
export type SheetCatalogueRoute = 'workbook_manifest' | 'google_sheets';

/**
 * The catalogue route for a file type, or `null` when the type has none.
 *
 * TOTAL over `KnownFileType` on purpose (same reason as
 * `changeModelForFileType`): a file type added to that union with no arm here
 * narrows to `never` and FAILS THE BUILD, so a new platform cannot be
 * silently left unvalidated. `null` is a refusal to guess, never a default —
 * this server ships to customers on npm and is routinely older than the
 * backend it talks to.
 *
 * Native Google Sheets take the Sheets API route; an `.xlsx` in Google Drive
 * takes the parser manifest, because the Sheets API will not open one.
 */
export function sheetCatalogueRouteFor(
  fileType: string,
): SheetCatalogueRoute | null {
  // The runtime membership test: `null` here means a type this build predates.
  if (changeModelForFileType(fileType) === null) return null;
  const known = fileType as KnownFileType;
  switch (known) {
    case 'microsoft_xlsx':
    case 'microsoft_xlsm':
    case 'gdrive_xlsx':
      return 'workbook_manifest';
    case 'gsheet_native':
      return 'google_sheets';
    case 'microsoft_docx':
    case 'google_doc':
    case 'microsoft_pptx':
    case 'google_slides':
      // Not addressed by sheet, so there is no sheet name to validate.
      return null;
  }
  const unmapped: never = known;
  return unmapped;
}

/** The catalogue readers this module needs from the API client. */
export interface SheetCatalogueApi {
  getWorkbookSheetNames(enrolledFileInternalId: number): Promise<string[]>;
  getGoogleSheetNames(platformId: string): Promise<string[]>;
}

/** The file fields the catalogue lookup keys on. */
export interface SheetCatalogueFile {
  internalId: number;
  platformId: string;
  fileType: string;
  name?: string | null;
}

/**
 * Throws {@link UnknownSheetError} unless `sheetName` is a worksheet of this
 * file, spelled the way the change queries match it.
 *
 * Call this ONLY where the answer would otherwise be an empty one. A row that
 * came back names its own sheet, so a non-empty answer has already proved what
 * this would go and ask.
 */
export async function assertSheetExists(
  api: SheetCatalogueApi,
  file: SheetCatalogueFile,
  sheetName: string,
): Promise<void> {
  const route = sheetCatalogueRouteFor(file.fileType);
  // A type with no sheet catalogue has no sheet name to be wrong about.
  if (route === null) return;

  const fileName = file.name ?? null;

  // `internalId` is typed as required and IS served — it is a
  // `@PrimaryGeneratedColumn()` with no `@Exclude`, spread into the response by
  // `enrolled-files.controller.ts!findOne`, whose own comment says the route
  // carries "the internal id the guard authorised on". But nothing in this
  // package read it before now, so that is measured from the backend's source
  // and not from a live response. If it ever arrives absent, the URL would be
  // `/by-enrolled-file/undefined/...`, the backend would answer 400, and every
  // empty-path Microsoft call would hard-fail. Refuse honestly instead of
  // asking a question that cannot be asked.
  const needsInternalId = route === 'workbook_manifest';
  if (needsInternalId && !Number.isInteger(file.internalId)) {
    throw new UnknownSheetError({
      reason: 'sheet_catalogue_unavailable',
      sheetName,
      fileName,
    });
  }

  let sheets: readonly string[];
  try {
    sheets =
      route === 'google_sheets'
        ? await api.getGoogleSheetNames(file.platformId)
        : await api.getWorkbookSheetNames(file.internalId);
  } catch (err) {
    // A definitive rejection is the caller's real answer — let it through so
    // the tool reports it rather than "could not check, retry in 15s", which
    // would send an assistant into a retry loop against a wall. Same rule
    // `assertChangeHistoryComplete` applies to its own probe.
    if (isDefinitiveRejection(err)) throw err;
    // Otherwise: deliberately NOT carrying the backend's message through.
    // ENG-5904 — a raw upstream body rendered into a tool answer reads to a
    // model as a statement about the caller's access. What this branch knows
    // is only that the catalogue could not be read.
    throw new UnknownSheetError({
      reason: 'sheet_catalogue_unavailable',
      sheetName,
      fileName,
    });
  }

  // Every workbook has at least one sheet, so an EMPTY catalogue is a failed
  // read wearing a successful one's clothes — never evidence that a sheet does
  // not exist. Refusing to prove absence from it is the whole point.
  if (sheets.length === 0) {
    throw new UnknownSheetError({
      reason: 'sheet_catalogue_unavailable',
      sheetName,
      fileName,
    });
  }

  // EXACT, because the queries are exact. See the header.
  if (sheets.includes(sheetName)) return;

  const near = sheets.find((s) => sheetNamesAgree(s, sheetName));
  throw new UnknownSheetError({
    reason: near === undefined ? 'sheet_not_found' : 'sheet_name_not_exact',
    sheetName,
    fileName,
    knownSheets: sheets,
    exactSheetName: near ?? null,
  });
}

/**
 * {@link assertSheetExists} for a caller that holds only a `platformId`.
 *
 * `get_cell_history` is that caller: it never fetches the file, so it pays the
 * id hop too — and, like the catalogue read itself, ONLY on the empty path.
 * `get_unattributed_changes` already has the file in hand (ENG-5397 fetches it
 * unconditionally to route on type) and calls {@link assertSheetExists}
 * directly.
 */
export async function assertSheetExistsForFile(
  api: SheetCatalogueApi & {
    getEnrolledFile(fileMsId: string): Promise<SheetCatalogueFile>;
  },
  fileMsId: string,
  sheetName: string,
): Promise<void> {
  let file: SheetCatalogueFile;
  try {
    file = await api.getEnrolledFile(fileMsId);
  } catch (err) {
    if (isDefinitiveRejection(err)) throw err;
    throw new UnknownSheetError({
      reason: 'sheet_catalogue_unavailable',
      sheetName,
    });
  }
  await assertSheetExists(api, file, sheetName);
}
