// ENG-4347 — nothing validated `sheetName` against the workbook's real sheets.
// A misspelled sheet rendered as "No unattributed changes on sheet X" /
// "No history found for <cell> on X", byte-identical to a real sheet that
// genuinely has nothing on it. The tool descriptions establish that an empty
// answer is a POSITIVE claim, so a one-character typo became a clean bill of
// health on a sheet holding pending edits.
//
// Every assertion here is on the CONTENT of the answer, never on a count and
// never on "it refused". Three different refusals are reachable from this one
// argument — the sheet is absent, the sheet is there under a different
// spelling, the catalogue could not be read — and they mean different things
// to the caller. A test that only pins `isError` cannot tell you which one you
// got, and a later change that collapses two of them would stay green.
import { describe, expect, it } from 'vitest';
import { registerTools } from '../../tools/index.js';
import { RockhopperApiError } from '../../api-client.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

const getHandler = (
  api: ReturnType<typeof createMockApiClient>,
  name: string,
) => {
  const server = createMockMcpServer();
  registerTools(server as any, api as any);
  return server.registerTool.mock.calls.find((c) => c[0] === name)?.[2];
};

/** The default mock file is `microsoft_xlsx`, internalId 11, platformId file-1. */
const REAL_SHEETS = ['Sheet1', 'Project Accruals', 'Summary'];

const withCatalogue = (
  api: ReturnType<typeof createMockApiClient>,
  sheets: string[] = REAL_SHEETS,
) => {
  api.getWorkbookSheetNames.mockResolvedValue(sheets);
  api.getGoogleSheetNames.mockResolvedValue(sheets);
  return api;
};

const textOf = (result: { content: Array<{ text: string }> }) =>
  result.content[0].text;

describe('an unknown sheetName is refused, not answered empty (ENG-4347)', () => {
  describe('get_unattributed_changes', () => {
    it('refuses a sheet the workbook does not have, and names the real ones', async () => {
      const api = withCatalogue(createMockApiClient());
      // The backend takes sheetName as a FILTER and returns [] for a name that
      // matches nothing — there is no 404, so the miss is indistinguishable
      // from a real sheet with no pending changes.
      api.getUnattributedChangesBySheet.mockResolvedValue([]);

      const result = await getHandler(api, 'get_unattributed_changes')({
        fileMsId: 'file-1',
        sheetName: 'Project Acruals',
      });

      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toContain('SHEET_NOT_FOUND');
      expect(text).toContain('Project Acruals');
      // The list is the fix: the caller almost always has the name slightly
      // wrong rather than invented.
      expect(text).toContain('Project Accruals');
      expect(text).toContain('Summary');
      expect(text).not.toContain('No unattributed changes on sheet');
    });

    it('still reports a GENUINE absence on a sheet that exists', async () => {
      const api = withCatalogue(createMockApiClient());
      api.getUnattributedChangesBySheet.mockResolvedValue([]);

      const result = await getHandler(api, 'get_unattributed_changes')({
        fileMsId: 'file-1',
        sheetName: 'Summary',
      });

      // The true negative has to keep reading cleanly, or the fix has traded
      // one lie for another.
      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('No unattributed changes on sheet');
      expect(textOf(result)).toContain('Summary');
    });

    it('does not read the catalogue at all when rows came back', async () => {
      const api = withCatalogue(createMockApiClient());

      const result = await getHandler(api, 'get_unattributed_changes')({
        fileMsId: 'file-1',
        // Not a sheet in REAL_SHEETS — and it must STILL not be checked,
        // because a row that came back names its own sheet. This is the whole
        // cost argument: only the ambiguous answer pays.
        sheetName: 'Whatever',
      });

      expect(result.isError).toBeFalsy();
      expect(api.getWorkbookSheetNames).not.toHaveBeenCalled();
      expect(api.getGoogleSheetNames).not.toHaveBeenCalled();
    });
  });

  describe('get_cell_history', () => {
    it('refuses a sheet the workbook does not have', async () => {
      const api = withCatalogue(createMockApiClient());
      api.getCellHistory.mockResolvedValue([]);

      const result = await getHandler(api, 'get_cell_history')({
        fileMsId: 'file-1',
        sheetName: 'Project Acruals',
        cellAddress: 'BS11',
      });

      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toContain('SHEET_NOT_FOUND');
      expect(text).toContain('Project Acruals');
      expect(text).toContain('Project Accruals');
      expect(text).not.toContain('No history found');
    });

    it('still reports a GENUINE empty history on a sheet that exists', async () => {
      const api = withCatalogue(createMockApiClient());
      api.getCellHistory.mockResolvedValue([]);

      const result = await getHandler(api, 'get_cell_history')({
        fileMsId: 'file-1',
        sheetName: 'Summary',
        cellAddress: 'ZZ99',
      });

      expect(result.isError).toBeFalsy();
      expect(textOf(result)).toContain('No history found for ZZ99');
    });

    it('does not fetch the file or the catalogue when history came back', async () => {
      const api = withCatalogue(createMockApiClient());
      api.getCellHistory.mockResolvedValue([
        {
          versionId: '1.0.0',
          value: 5,
          changedBy: 'a@b.c',
          changedAt: '2026-01-01T00:00:00Z',
        },
      ]);

      const result = await getHandler(api, 'get_cell_history')({
        fileMsId: 'file-1',
        sheetName: 'Nonexistent',
        cellAddress: 'A1',
      });

      expect(result.isError).toBeFalsy();
      expect(api.getEnrolledFile).not.toHaveBeenCalled();
      expect(api.getWorkbookSheetNames).not.toHaveBeenCalled();
    });
  });

  describe('the three refusals are different answers, by content', () => {
    // The backend filters on the caller's literal string with case-SENSITIVE
    // SQL equality — `unattributed-changes.service.ts!findChangesBySheet`
    // binds `change.sheetName = :sheetName`, `cell-history.query.ts!
    // sheetPredicate` binds `"sheet_name" = $N`. So a case-wrong name matches
    // nothing and produces the identical false negative a typo does. A
    // case-INSENSITIVE existence check would wave exactly this through.
    it('a case-wrong name is refused with the exact spelling, not listed as missing', async () => {
      const api = withCatalogue(createMockApiClient());
      api.getUnattributedChangesBySheet.mockResolvedValue([]);

      const result = await getHandler(api, 'get_unattributed_changes')({
        fileMsId: 'file-1',
        sheetName: 'project accruals',
      });

      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toContain('SHEET_NAME_NOT_EXACT');
      expect(text).not.toContain('SHEET_NOT_FOUND');
      expect(text).toContain('Project Accruals');
      expect(text).not.toContain('No unattributed changes on sheet');
    });

    it('a surrounding-space difference takes the same branch', async () => {
      const api = withCatalogue(createMockApiClient());
      api.getCellHistory.mockResolvedValue([]);

      const result = await getHandler(api, 'get_cell_history')({
        fileMsId: 'file-1',
        sheetName: '  Summary ',
        cellAddress: 'A1',
      });

      expect(textOf(result)).toContain('SHEET_NAME_NOT_EXACT');
      expect(textOf(result)).toContain('"Summary"');
    });

    it('an unreadable catalogue refuses WITHOUT claiming the sheet is missing', async () => {
      const api = createMockApiClient();
      api.getUnattributedChangesBySheet.mockResolvedValue([]);
      api.getWorkbookSheetNames.mockRejectedValue(
        new RockhopperApiError(500, 'Rockhopper API 500: parser timed out'),
      );

      const result = await getHandler(api, 'get_unattributed_changes')({
        fileMsId: 'file-1',
        sheetName: 'Summary',
      });

      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toContain('SHEET_CATALOGUE_UNAVAILABLE');
      // Existence is UNKNOWN here. Saying "not a worksheet" would be a
      // fabricated fact, and saying "no changes" would be the original one.
      expect(text).not.toContain('SHEET_NOT_FOUND');
      expect(text).not.toContain('No unattributed changes on sheet');
      // ENG-5904 — the upstream body never reaches the answer; a raw 500/403
      // rendered into a tool result reads to a model as a statement about the
      // caller's access.
      expect(text).not.toContain('parser timed out');
    });

    it('an EMPTY catalogue is unreadable, never proof the sheet is missing', async () => {
      // Every workbook has at least one sheet, so `[]` is a failed read
      // wearing a successful one's clothes. Proving an absence from it is the
      // same class of error as the defect being fixed.
      const api = withCatalogue(createMockApiClient(), []);
      api.getUnattributedChangesBySheet.mockResolvedValue([]);

      const result = await getHandler(api, 'get_unattributed_changes')({
        fileMsId: 'file-1',
        sheetName: 'Summary',
      });

      expect(textOf(result)).toContain('SHEET_CATALOGUE_UNAVAILABLE');
      expect(textOf(result)).not.toContain('SHEET_NOT_FOUND');
    });

    it('a definitive rejection is not dressed as a retryable "could not check"', async () => {
      const api = createMockApiClient();
      api.getUnattributedChangesBySheet.mockResolvedValue([]);
      api.getWorkbookSheetNames.mockRejectedValue(
        new RockhopperApiError(403, 'Rockhopper API 403: Forbidden'),
      );

      const result = await getHandler(api, 'get_unattributed_changes')({
        fileMsId: 'file-1',
        sheetName: 'Summary',
      });

      expect(result.isError).toBe(true);
      // A 403 has answered the question. Telling the caller to retry in 15
      // seconds sends an assistant into a loop against a wall — the same rule
      // `assertChangeHistoryComplete` applies to its own probe.
      expect(textOf(result)).not.toContain('SHEET_CATALOGUE_UNAVAILABLE');
      expect(textOf(result)).not.toContain('No unattributed changes on sheet');
    });
  });

  describe('platform routing — the same capability on both, not one lane', () => {
    it('a Microsoft workbook is looked up by its INTERNAL id, not its platformId', async () => {
      const api = withCatalogue(createMockApiClient());
      api.getUnattributedChangesBySheet.mockResolvedValue([]);

      await getHandler(api, 'get_unattributed_changes')({
        fileMsId: 'file-1',
        sheetName: 'Nope',
      });

      // Assert the REQUEST, not only the answer. The manifest route resolves
      // on `enrolledFile.internalId`; handing it the platformId would 404 on
      // every real call while a mock that ignores its argument stayed green.
      expect(api.getWorkbookSheetNames).toHaveBeenCalledWith(11);
      expect(api.getGoogleSheetNames).not.toHaveBeenCalled();
    });

    it('a native Google Sheet takes the Sheets route, keyed by platformId', async () => {
      const api = withCatalogue(createMockApiClient());
      api.getEnrolledFile.mockResolvedValue({
        internalId: 22,
        platformId: 'gsheet-abc',
        fileType: 'gsheet_native',
        driveMsId: 'gdrive-1',
        name: 'Model.gsheet',
        hasUncommittedChanges: true,
      });
      api.getUnattributedChangesBySheet.mockResolvedValue([]);

      const result = await getHandler(api, 'get_unattributed_changes')({
        fileMsId: 'gsheet-abc',
        sheetName: 'Nope',
      });

      expect(api.getGoogleSheetNames).toHaveBeenCalledWith('gsheet-abc');
      expect(api.getWorkbookSheetNames).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('SHEET_NOT_FOUND');
    });

    it('an xlsx living in Google Drive takes the parser manifest, not the Sheets API', async () => {
      // The Sheets API will not open a non-native workbook, so `gdrive_xlsx`
      // is a Google file on the Microsoft-shaped lane.
      const api = withCatalogue(createMockApiClient());
      api.getEnrolledFile.mockResolvedValue({
        internalId: 33,
        platformId: 'gdrive-xlsx-1',
        fileType: 'gdrive_xlsx',
        driveMsId: 'gdrive-1',
        name: 'Budget.xlsx',
        hasUncommittedChanges: true,
      });
      api.getUnattributedChangesBySheet.mockResolvedValue([]);

      await getHandler(api, 'get_unattributed_changes')({
        fileMsId: 'gdrive-xlsx-1',
        sheetName: 'Nope',
      });

      expect(api.getWorkbookSheetNames).toHaveBeenCalledWith(33);
      expect(api.getGoogleSheetNames).not.toHaveBeenCalled();
    });
  });
});
