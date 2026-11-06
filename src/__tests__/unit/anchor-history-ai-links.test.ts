/**
 * ENG-8763 — the anchorId arm of `get_cell_history` (one paragraph's or one
 * shape's history) printed no AI clause both when no AI touched the rows and
 * when the backend could not check. The cell arm says so; this arm now says so
 * too, from the response body's `aiLinksAvailable`.
 *
 * Every "prints nothing extra" case first proves the rows printed, and a
 * linked row is the positive control: its AI clause prints either way.
 */
import { describe, expect, it } from 'vitest';

import { AI_LINKS_UNAVAILABLE_NOTE } from '../../change-row-vocabulary.js';
import { formatAnchorHistory } from '../../tools/anchor-history-read.js';
import { registerTools } from '../../tools/index.js';
import type { DocumentAnchorHistory } from '../../types.js';
import { DocumentAnchorHistorySchema } from '../../zod-schemas.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

const COPILOT = {
  vendor: 'microsoft_copilot',
  evidenceKind: 'response_literal',
  promptId: '4182',
};
const AI_CLAUSE = ' — AI: microsoft_copilot (response_literal, prompt 4182)';
const PARAGRAPH = 'w14-paraId-7A3B';

const row = (eventId: string, to: string, aiLinks: unknown[] = []) => ({
  eventId,
  kind: 'block',
  containerProviderId: null,
  anchorProviderId: PARAGRAPH,
  anchorLabel: null,
  changeKind: 'block_edit',
  editorPlatformId: 'u-1',
  occurredAt: `2026-09-1${eventId.slice(-1)}T10:00:00.000Z`,
  firstObservedAt: '2026-09-10T10:00:01.000Z',
  fromValue: { v: 'Net 30 days' },
  toValue: { v: to },
  truncated: false,
  aiLinks,
  boundVersionId: null,
});

/** The wire body, parsed by the same schema the API client applies. */
const parsed = (over: Record<string, unknown> = {}): DocumentAnchorHistory =>
  DocumentAnchorHistorySchema.parse({
    documentType: 'text',
    anchorId: PARAGRAPH,
    anchorLane: 'both',
    anchorIdentity: 'provider_id',
    history: [row('48121', 'Net 45 days', [COPILOT]), row('48122', 'Net 60 days')],
    truncated: false,
    ...over,
  }) as DocumentAnchorHistory;

describe('anchor history — aiLinksAvailable parsed and printed (ENG-8763)', () => {
  it('a body without the field parses as true; a sent false is kept', () => {
    expect(parsed().aiLinksAvailable).toBe(true);
    expect(parsed({ aiLinksAvailable: false }).aiLinksAvailable).toBe(false);
  });

  it('prints the note once when false, and the linked row keeps its AI clause', () => {
    const text = formatAnchorHistory(parsed({ aiLinksAvailable: false }));
    expect(text).toContain('"Net 60 days"');
    expect(text).toContain(AI_CLAUSE);
    expect(text.split(AI_LINKS_UNAVAILABLE_NOTE)).toHaveLength(2);
  });

  it('prints no note when true, with the rows and the AI clause present', () => {
    const text = formatAnchorHistory(parsed({ aiLinksAvailable: true }));
    expect(text).toContain('"Net 60 days"');
    expect(text).toContain(AI_CLAUSE);
    expect(text).not.toContain(AI_LINKS_UNAVAILABLE_NOTE);
  });

  it('an empty element answer that could not be checked says so too', () => {
    const text = formatAnchorHistory(parsed({ history: [], aiLinksAvailable: false }));
    expect(text).toContain(`No change recorded for element "${PARAGRAPH}"`);
    expect(text).toContain(AI_LINKS_UNAVAILABLE_NOTE);
  });

  it('an updating answer that could not be checked says so too', () => {
    const text = formatAnchorHistory(parsed({ aiLinksAvailable: false }), {
      state: 'updating',
      retryAfterSeconds: 30,
    });
    expect(text.startsWith('UPDATING — incomplete:')).toBe(true);
    expect(text).toContain(AI_CLAUSE);
    expect(text).toContain(AI_LINKS_UNAVAILABLE_NOTE);
  });

  it('the tool output carries the note when the backend reports false', async () => {
    const api = createMockApiClient();
    api.getAnchorHistory.mockResolvedValue(parsed({ aiLinksAvailable: false }));
    const server = createMockMcpServer();
    registerTools(server as never, api as never);
    const handler = server.registerTool.mock.calls.find(
      (c) => c[0] === 'get_cell_history',
    )![2];
    const result = await handler({ fileMsId: 'file-docx', anchorId: PARAGRAPH });
    const text = result.content[0].text as string;
    expect(result.isError).toBeFalsy();
    expect(text).toContain(AI_CLAUSE);
    expect(text).toContain(AI_LINKS_UNAVAILABLE_NOTE);
  });
});

describe('anchor history — lineage identity (ENG-8763)', () => {
  it('parses a lineage-matched element and renders its rows without the positional note', () => {
    const response = parsed({ anchorIdentity: 'lineage' });
    expect(response.anchorIdentity).toBe('lineage');
    const text = formatAnchorHistory(response);
    expect(text).toContain('2 change(s)');
    expect(text).not.toContain('matched by its position');
  });
});
