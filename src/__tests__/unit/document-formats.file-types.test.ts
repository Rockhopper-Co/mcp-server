import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { changeModelForFileType } from '../../document-changes.js';
import { sheetCatalogueRouteFor } from '../../sheet-catalogue.js';
import { registerTools } from '../../tools/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

/**
 * ENG-8069 — the MCP server knows the ten file types the document-formats
 * release admits (PDF, Markdown, plain text, JSON, XML on Microsoft and Google
 * Drive), so an assistant can read a `.json` file's changes instead of being
 * refused as `unknown_file_type`.
 *
 * Every model assertion is by VALUE, and every block carries a positive
 * control: `changeModelForFileType` answers `null` for a type it does not
 * know, so a test that only checked "not null" would pass on a lookup that
 * returned the wrong model, and a test that only checked `null` would pass on a
 * type this build had never heard of.
 */

const EXPECTED_MODEL: ReadonlyArray<readonly [string, string]> = [
  ['microsoft_pdf', 'pdf'],
  ['gdrive_pdf', 'pdf'],
  ['microsoft_md', 'plain_text'],
  ['gdrive_md', 'plain_text'],
  ['microsoft_txt', 'plain_text'],
  ['gdrive_txt', 'plain_text'],
  ['microsoft_json', 'structured_data'],
  ['gdrive_json', 'structured_data'],
  ['microsoft_xml', 'structured_data'],
  ['gdrive_xml', 'structured_data'],
];

describe('changeModelForFileType — the ten document-format types', () => {
  it('positive control: a type this build does not know answers null, a known one its model', () => {
    expect(changeModelForFileType('microsoft_rtf')).toBeNull();
    expect(changeModelForFileType('microsoft_docx')).toBe('text');
  });

  it.each(EXPECTED_MODEL)('%s → %s', (fileType, model) => {
    expect(changeModelForFileType(fileType)).toBe(model);
  });
});

describe('sheetCatalogueRouteFor — the new types have no worksheets', () => {
  it('positive control: a workbook DOES have a catalogue route', () => {
    expect(sheetCatalogueRouteFor('microsoft_xlsx')).toBe('workbook_manifest');
  });

  it.each(EXPECTED_MODEL)('%s is KNOWN and has no sheet catalogue', (fileType) => {
    // Both halves: `null` alone is also what an unknown type answers.
    expect(changeModelForFileType(fileType)).not.toBeNull();
    expect(sheetCatalogueRouteFor(fileType)).toBeNull();
  });
});

function changesHandler(api: ReturnType<typeof createMockApiClient>) {
  const server = createMockMcpServer();
  registerTools(server as never, api as never);
  return server.registerTool.mock.calls.find(
    (c) => c[0] === 'get_unattributed_changes',
  )?.[2];
}

function enrolled(
  api: ReturnType<typeof createMockApiClient>,
  fileType: string,
  name: string,
) {
  api.getEnrolledFile.mockResolvedValue({
    internalId: 40,
    platformId: 'file-new',
    fileType,
    driveMsId: 'drive-1',
    name,
    hasUncommittedChanges: true,
  });
}

/** A served field row, shaped as the backend's document row contract. */
const FIELD_ROW = {
  eventId: '90001',
  kind: 'field',
  locationKind: 'path',
  containerOrdinal: null,
  containerProviderId: null,
  anchorOrdinal: null,
  anchorProviderId: 'invoice/currency',
  anchorLabel: null,
  changeKind: 'field-changed',
  actorKind: 'human',
  actorPlatformId: 'ms-user-1',
  attributionConfidence: 'version_level',
  editorPlatformId: 'ms-user-1',
  occurredAt: '2026-10-26T10:00:00.000Z',
  firstObservedAt: '2026-10-26T10:00:01.000Z',
  fromValue: { v: 'USD' },
  toValue: { v: 'EUR' },
  truncated: false,
};

const TEXT_ROW = {
  ...FIELD_ROW,
  eventId: '90002',
  kind: 'block',
  locationKind: 'block',
  anchorProviderId: 'md-block-3',
  changeKind: 'block_edit',
  fromValue: { v: 'Revenue grows 4%' },
  toValue: { v: 'Revenue grows 6%' },
};

function served(rows: unknown[]) {
  return {
    rows,
    truncated: false,
    declineReason: null,
    windowStart: '2026-10-01T00:00:00.000Z',
  };
}

describe('get_unattributed_changes on the new formats', () => {
  it('returns a JSON file’s field rows from the document lane', async () => {
    const api = createMockApiClient();
    enrolled(api, 'microsoft_json', 'invoice.json');
    api.getDocumentChanges.mockResolvedValue(served([FIELD_ROW]));

    const result = await changesHandler(api)({ fileMsId: 'file-new' });
    const text = result.content[0].text as string;

    expect(api.getDocumentChanges).toHaveBeenCalledWith('file-new');
    expect(text).toContain('invoice/currency');
    expect(text).toContain('USD');
    expect(text).toContain('EUR');
    expect(text).not.toContain('unknown_file_type');
    expect(result.isError).toBeFalsy();
  });

  it('returns a Markdown file’s block rows from the document lane', async () => {
    const api = createMockApiClient();
    enrolled(api, 'gdrive_md', 'notes.md');
    api.getDocumentChanges.mockResolvedValue(served([TEXT_ROW]));

    const result = await changesHandler(api)({ fileMsId: 'file-new' });
    const text = result.content[0].text as string;

    expect(text).toContain('md-block-3');
    expect(text).toContain('Revenue grows 6%');
    expect(result.isError).toBeFalsy();
  });

  it('REFUSES a PDF by name instead of serving an empty window as "no changes"', async () => {
    const api = createMockApiClient();
    enrolled(api, 'microsoft_pdf', 'minutes.pdf');
    // The backend would serve an empty window: PDF change rows are not
    // recorded. Rendering it would read as "nothing changed".
    api.getDocumentChanges.mockResolvedValue(served([]));

    const result = await changesHandler(api)({ fileMsId: 'file-new' });
    const text = result.content[0].text as string;

    // Pinned to the REASON, so `unknown_file_type` cannot satisfy it.
    expect(text).toContain('DOCUMENT_CHANGES_UNAVAILABLE');
    expect(text).toContain('"reason":"change_list_not_recorded"');
    expect(text).not.toContain('No changes recorded');
    expect(result.isError).toBe(true);
  });

  it('positive control: an unknown type is refused for a DIFFERENT reason, naming the new kinds', async () => {
    const api = createMockApiClient();
    enrolled(api, 'microsoft_rtf', 'memo.rtf');

    const result = await changesHandler(api)({ fileMsId: 'file-new' });
    const text = result.content[0].text as string;

    expect(text).toContain('"reason":"unknown_file_type"');
    expect(text).not.toContain('change_list_not_recorded');
    expect(text).toContain('JSON and XML files');
    expect(api.getDocumentChanges).not.toHaveBeenCalled();
  });
});

describe('orchestration guide — file-type table', () => {
  const guide = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../resources/orchestration-guide.md',
    ),
    'utf8',
  );
  const tableRow =
    guide.split('\n').find((line) => line.startsWith('| `fileType` |')) ?? '';

  it('positive control: the row exists and lists an existing type', () => {
    expect(tableRow).toContain('`microsoft_docx`');
  });

  it.each(EXPECTED_MODEL)('lists %s', (fileType) => {
    expect(tableRow).toContain(`\`${fileType}\``);
  });
});
