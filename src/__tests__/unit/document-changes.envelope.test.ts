import { describe, expect, expectTypeOf, it } from 'vitest';
import type { DocumentChangesResponse } from '../../types.js';
import { DocumentChangesResponseSchema } from '../../zod-schemas.js';
import { SERVED_WINDOW_ENVELOPES } from '../goldens/served-window-envelope.js';

/**
 * ENG-6058 — `DocumentChangesResponse` must name every key the backend puts on
 * the document-changes envelope.
 *
 * The client type omitted `nextCursor` and its comments said no cursor
 * existed, while backend `DocumentChangesResponseDto` (ENG-5634) serves one on
 * every response. A type that silently lacks a served key is how a client
 * comes to state the opposite of what the server offers.
 *
 * ## HOW THE TYPE IS BROUGHT INTO A RUNTIME ASSERTION
 *
 * `satisfies Record<keyof DocumentChangesResponse, true>` makes the object
 * below carry EXACTLY the type's keys — a missing key and an extra key are
 * both compile errors under `npm run typecheck`. So its runtime keys ARE the
 * type's keys, and comparing them to the backend's own golden compares the
 * type to the producer by identity, not by count.
 */
const DECLARED_ENVELOPE_KEYS = {
  rows: true,
  truncated: true,
  declineReason: true,
  windowStart: true,
  nextCursor: true,
} satisfies Record<keyof DocumentChangesResponse, true>;

const declaredKeys = Object.keys(DECLARED_ENVELOPE_KEYS).sort();

describe('document-changes envelope (ENG-6058)', () => {
  for (const [arm, envelope] of Object.entries(SERVED_WINDOW_ENVELOPES)) {
    it(`declares exactly the keys the backend serves (${arm} arm)`, () => {
      expect(declaredKeys).toEqual(Object.keys(envelope).sort());
    });

    it(`keeps nextCursor through the client's response schema (${arm} arm)`, () => {
      const parsed = DocumentChangesResponseSchema.parse(envelope);
      expect(Object.keys(parsed)).toContain('nextCursor');
      expect(parsed).toHaveProperty('nextCursor', null);
    });
  }

  it('types nextCursor as the backend does: an opaque string, or null on the last page', () => {
    expectTypeOf<DocumentChangesResponse['nextCursor']>().toEqualTypeOf<string | null>();
  });
});
