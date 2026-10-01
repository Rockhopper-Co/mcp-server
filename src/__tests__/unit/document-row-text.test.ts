/**
 * ENG-6608 — a document change row sent to an AI client says what the
 * change-log row says: the row's own word for the kind, never the ledger's
 * event type, and the two side words the change log uses for a missing side.
 *
 * Rules: knowledge-base `docs/features/change-log-row-vocabulary.md` §2 (the
 * edit-type word) and §4 (from→to sides).
 */
import { describe, expect, it } from 'vitest';

import { formatDocumentRow } from '../../document-changes.js';
import type { DocumentChangeRow } from '../../types.js';

const row = (over: Partial<DocumentChangeRow>): DocumentChangeRow => ({
  eventId: '1',
  kind: 'block',
  containerProviderId: null,
  anchorProviderId: 'w14-paraId-7A3B',
  anchorLabel: null,
  changeKind: 'block_edit',
  editorPlatformId: null,
  occurredAt: '2026-09-15T10:00:00.000Z',
  firstObservedAt: '2026-09-15T10:00:01.000Z',
  fromValue: { v: 'Net 30 days' },
  toValue: { v: 'Net 60 days' },
  truncated: false,
  ...over,
});

const deckRow = (over: Partial<DocumentChangeRow>): DocumentChangeRow =>
  row({
    kind: 'shape',
    containerProviderId: 'slide-id-9',
    anchorProviderId: 'slide:256/shape:7',
    ...over,
  });

describe('formatDocumentRow — the row word, never the event type', () => {
  it('names a paragraph text edit "text", not block_edit', () => {
    const text = formatDocumentRow(row({ changeKind: 'block_edit' }));
    expect(text).toBe(
      '- **w14-paraId-7A3B** (text): "Net 30 days" → "Net 60 days" — ' +
        '2026-09-15T10:00:00.000Z',
    );
  });

  it('names a shape restyle "formatting", not shape_format', () => {
    const text = formatDocumentRow(deckRow({ changeKind: 'shape_format' }));
    expect(text).toContain('(formatting):');
    expect(text).not.toContain('shape_format');
  });

  it('names a slide design edit by its part when the anchor carries one', () => {
    const layout = formatDocumentRow(
      deckRow({
        changeKind: 'slide_design',
        anchorProviderId: 'design:layout:abc',
        fromValue: null,
        toValue: null,
      }),
    );
    expect(layout).toContain('(layout):');
    const bare = formatDocumentRow(
      deckRow({
        changeKind: 'slide_design',
        anchorProviderId: 'design:other:abc',
        fromValue: null,
        toValue: null,
      }),
    );
    expect(bare).toContain('(design):');
    const unanchored = formatDocumentRow(
      deckRow({ changeKind: 'slide_design', anchorProviderId: null }),
    );
    expect(unanchored).toContain('(design):');
  });

  it('says Word regenerated a field, in the change log words', () => {
    const text = formatDocumentRow(
      row({ changeKind: 'block_field_regenerated' }),
    );
    expect(text).toContain('(text, Updated by Word):');
    expect(text).not.toContain('block_field_regenerated');
  });

  it('prints NO word for a kind this build cannot read — never the raw kind', () => {
    const text = formatDocumentRow(row({ changeKind: 'block_teleport' }));
    expect(text).toBe(
      '- **w14-paraId-7A3B**: "Net 30 days" → "Net 60 days" — ' +
        '2026-09-15T10:00:00.000Z',
    );
  });
});

describe('formatDocumentRow — the two side words, and no third', () => {
  it('says Not recorded for a side the ledger did not store', () => {
    const text = formatDocumentRow(row({ fromValue: null }));
    expect(text).toContain(': Not recorded → "Net 60 days"');
    expect(text).not.toContain('(not recorded)');
  });

  it('says Not recorded for a stored facet with no text in it', () => {
    const text = formatDocumentRow(row({ toValue: { f: '=SUM(A1)' } }));
    expect(text).toContain('"Net 30 days" → Not recorded');
  });

  it('says — for a side that was emptied', () => {
    const text = formatDocumentRow(row({ toValue: { v: '' } }));
    expect(text).toContain('"Net 30 days" → —');
    expect(text).not.toContain('(empty)');
  });

  it('says — for a side holding only blank lines', () => {
    const text = formatDocumentRow(row({ toValue: { v: '\n\n  \n' } }));
    expect(text).toContain('"Net 30 days" → —');
  });

  it('prints only the after side of an added unit', () => {
    const text = formatDocumentRow(
      row({ changeKind: 'block_insert', fromValue: null }),
    );
    expect(text).toContain('(added): "Net 60 days" —');
    expect(text).not.toContain('Not recorded');
  });

  it('prints only the before side of a removed unit', () => {
    const text = formatDocumentRow(
      deckRow({ changeKind: 'shape_delete', toValue: null }),
    );
    expect(text).toContain('(removed): "Net 30 days" —');
    expect(text).not.toContain('Not recorded');
  });
});
