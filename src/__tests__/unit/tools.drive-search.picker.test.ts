import { describe, expect, it, vi } from 'vitest';
import { registerDriveSearchTool } from '../../tools/drive-search.js';
import {
  candidateLabel,
  confirmationForm,
} from '../../tools/drive-search.contract.js';
import type { Candidate } from '../../drive-search.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

/**
 * ENG-2789 / ENG-2784 / ENG-2787 — one elicitation, three defects, all of them
 * about what the PERSON sees rather than what the model receives.
 *
 * Every assertion here is written against a measured render, not against a
 * guess about the client. The prompt David photographed on 2026-08-19 showed
 * the elicitation `message` on screen and the candidates behind a collapsed
 * required field, which is why these specs pin the message and the required
 * set rather than trying to control the widget.
 */

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    msId: 'ms-item-9',
    driveMsId: 'drive-9',
    name: 'Becklar_RMR_Model.xlsx',
    parentPath: '/drives/b!YmtA8jQX3OSHJRQ88OabcdefghijklmnopQRS',
    lastModifiedAt: '2026-08-01T10:00:00Z',
    enrollmentState: 'not_enrolled',
    ...over,
  };
}

/** The width the real client truncated a picker row to (ENG-2787, measured). */
const CLIENT_ROW_WIDTH = 48;

/** Drive an elicitation-capable session and return the tool's answer. */
async function elicitWith(answer: unknown): Promise<ToolResult> {
  const server = createMockMcpServer();
  (server as unknown as { server: unknown }).server = {
    getClientCapabilities: () => ({ elicitation: {} }),
  };
  registerDriveSearchTool(server as never, createMockApiClient() as never);
  const handler = server.registerTool.mock.calls[0][2] as (
    args: Record<string, unknown>,
    ctx?: unknown,
  ) => Promise<ToolResult>;

  return handler(
    { query: 'Becklar' },
    {
      mcpReq: {
        elicitInput: vi.fn().mockResolvedValue(answer),
        requestState: () => undefined,
      },
    },
  );
}

function outcomeOf(result: ToolResult): string {
  const line = result.content[0].text.split('\n').at(-1) ?? '{}';
  return (JSON.parse(line) as { outcome: string }).outcome;
}

function detailOf(result: ToolResult): Record<string, unknown> {
  const line = result.content[0].text.split('\n').at(-1) ?? '{}';
  return JSON.parse(line) as Record<string, unknown>;
}

describe('ENG-2789 — the candidates are on screen without expanding anything', () => {
  it('names every candidate in the message the client renders as prose', () => {
    const form = confirmationForm([
      candidate({ name: 'Q3_Forecast.xlsx' }),
      candidate({ msId: 'ms-item-10', name: 'Q4_Forecast.xlsx' }),
    ]);

    // The measured prompt showed `message` on screen and the field collapsed
    // to "not set". Anything the user must READ has to be in the message.
    expect(form.message).toContain('Q3_Forecast.xlsx');
    expect(form.message).toContain('Q4_Forecast.xlsx');
  });

  it('asks for nothing, so Accept is never refused for an unset field', () => {
    const form = confirmationForm([candidate()]);
    // Three consecutive real attempts died here: the only visible buttons were
    // Accept and Decline, and Accept was refused because `choice` was required
    // and invisible.
    expect(form.requestedSchema.required ?? []).not.toContain('choice');
  });

  it('separates a dismissed prompt from a rejected list', async () => {
    const dismissed = await elicitWith({ action: 'cancel' });
    const rejected = await elicitWith({
      action: 'accept',
      content: { choice: 'none' },
    });

    // `declined` used to mean both, so a prompt nobody could read reported
    // itself as a choice the user made.
    expect(outcomeOf(dismissed)).toBe('dismissed');
    expect(outcomeOf(rejected)).toBe('declined');
  });
});

describe('ENG-2784 — the link route is offered to the user, not to the model', () => {
  it('carries a field the user can paste a workbook link into', () => {
    const form = confirmationForm([candidate()]);
    const link = form.requestedSchema.properties.link as
      | { type: string; description?: string }
      | undefined;

    expect(link?.type).toBe('string');
  });

  it('says so in the message, in words written for a person', () => {
    const form = confirmationForm([candidate()]);

    expect(form.message.toLowerCase()).toContain('link');
    // Written for the person at the keyboard: no tool names, no identifiers.
    expect(form.message).not.toContain('enroll_file');
    expect(form.message).not.toContain('driveMsId');
  });

  it('hands a pasted link back as the file to add', async () => {
    const result = await elicitWith({
      action: 'accept',
      content: {
        choice: 'none',
        link: 'https://contoso.sharepoint.com/:x:/r/Docs/Q3.xlsx',
      },
    });

    expect(outcomeOf(result)).toBe('link_supplied');
    expect(detailOf(result).url).toBe(
      'https://contoso.sharepoint.com/:x:/r/Docs/Q3.xlsx',
    );
  });
});

describe('ENG-2787 — every row states whether Rockhopper already holds it', () => {
  it('keeps the marking inside the width the client renders', () => {
    const enrolled = candidateLabel(candidate({ enrollmentState: 'enrolled' }));
    const fresh = candidateLabel(candidate({ enrollmentState: 'not_enrolled' }));

    // The flag was already on the wire and was TRUNCATED off the end: the row
    // read `RE_Forecast.xlsx · /drives/b!YmtA8jQX3OSHJRQ88O…`. Ordering is the
    // whole fix, so the assertion is on what survives the cut.
    expect(enrolled.slice(0, CLIENT_ROW_WIDTH)).toContain(
      'already in Rockhopper',
    );
    expect(fresh.slice(0, CLIENT_ROW_WIDTH)).toContain('not in Rockhopper');
  });

  it('still separates a removed file from one that was never added', () => {
    const hidden = candidateLabel(candidate({ enrollmentState: 'hidden' }));
    expect(hidden.slice(0, CLIENT_ROW_WIDTH)).toContain('previously removed');
  });
});
