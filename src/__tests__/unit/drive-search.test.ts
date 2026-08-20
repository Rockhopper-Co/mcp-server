import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RockhopperApiError } from '../../api-client.js';
import {
  DRIVE_SEARCH_SESSION_BUDGET,
  SearchBudget,
  candidateAt,
  classifyDriveSearchFailure,
  createConfirmationCodec,
  isNoDelegatedToken,
  toCandidate,
  type Candidate,
} from '../../drive-search.js';
import { createMockApiClient } from './test-helpers.js';

/**
 * ENG-2204 — the two guards, tested where they live.
 *
 * Both exist because a model driving this session reads content it did not
 * author. A tool description asking it not to enumerate a customer's drive is
 * a request; these are the parts that can refuse.
 */

function candidate(name: string, msId: string): Candidate {
  return {
    msId,
    driveMsId: 'drive-9',
    name,
    parentPath: '/Finance',
    lastModifiedAt: '2026-08-01T10:00:00Z',
    enrollmentState: 'not_enrolled',
  };
}

describe('SearchBudget', () => {
  it('grants exactly its ceiling and then refuses forever', () => {
    const budget = new SearchBudget(3);
    expect([budget.claim(), budget.claim(), budget.claim()]).toEqual([
      true,
      true,
      true,
    ]);
    expect(budget.claim()).toBe(false);
    // Refusal is terminal, not a per-window pause: an attacker cannot lift it
    // by waiting, which is what makes it different from the backend's
    // 6-per-minute bucket.
    expect(budget.claim()).toBe(false);
    expect(budget.spent).toBe(3);
  });

  it('does not count a refused claim against the session', () => {
    const budget = new SearchBudget(1);
    budget.claim();
    budget.claim();
    budget.claim();
    expect(budget.spent).toBe(1);
  });

  it('defaults to the documented session ceiling', () => {
    expect(DRIVE_SEARCH_SESSION_BUDGET).toBe(20);
    const budget = new SearchBudget();
    expect(budget.ceiling).toBe(DRIVE_SEARCH_SESSION_BUDGET);
  });

  it('is per-instance, so two sessions never share a ceiling', () => {
    const first = new SearchBudget(1);
    const second = new SearchBudget(1);
    expect(first.claim()).toBe(true);
    expect(first.claim()).toBe(false);
    expect(second.claim()).toBe(true);
  });
});

describe('the confirmation codec (ENG-2816)', () => {
  const codec = createConfirmationCodec(createMockApiClient() as never);
  const ctx = {} as never;
  const offered = [candidate('A.xlsx', 'ms-a'), candidate('B.xlsx', 'ms-b')];

  it('carries the set across a round trip a different server verifies', async () => {
    // The gateway builds a fresh server per request over two production
    // replicas, so "the same process minted this" is never a safe assumption.
    // A SECOND codec over the same session credential is what a retry meets.
    const state = await codec.mint(offered, ctx);
    const other = createConfirmationCodec(createMockApiClient() as never);
    expect((await other.verify(state, ctx)).map((c) => c.msId)).toEqual([
      'ms-a',
      'ms-b',
    ]);
  });

  it('refuses a set the session never signed', async () => {
    // The whole point: the state round-trips through the client. A payload it
    // authored must not be readable back as a candidate set, or a model that
    // read a hostile file name could name any file it liked.
    const forged =
      'v1.' +
      Buffer.from(
        JSON.stringify({
          p: [candidate('Payroll.xlsx', 'ms-not-offered')],
          exp: Math.floor(Date.now() / 1000) + 600,
        }),
      ).toString('base64url') +
      '.' +
      Buffer.from('not-a-real-mac').toString('base64url');
    await expect(codec.verify(forged, ctx)).rejects.toThrow();
  });

  it('refuses a state signed for a DIFFERENT principal', async () => {
    // ENG-2816's 12:08 case generalised: one session must never be able to
    // answer with another's list. The key is derived from the credential, so
    // a different principal cannot verify — no separate check needed.
    const stranger = createConfirmationCodec({
      deriveStateKey: () => createHmac('sha256', 'someone-else').update('x').digest(),
    } as never);
    const state = await stranger.mint(offered, ctx);
    await expect(codec.verify(state, ctx)).rejects.toThrow();
  });
});

describe('candidateAt', () => {
  const offered = [candidate('A.xlsx', 'ms-a'), candidate('B.xlsx', 'ms-b')];

  it('resolves a position in the set it was given', () => {
    expect(candidateAt(offered, 1)?.msId).toBe('ms-b');
  });

  it('refuses a position outside the set that was offered', () => {
    expect(candidateAt(offered, 2)).toBeNull();
    expect(candidateAt(offered, -1)).toBeNull();
    expect(candidateAt(offered, 0.5)).toBeNull();
    expect(candidateAt(offered, Number.NaN)).toBeNull();
  });
});

describe('toCandidate', () => {
  it('keeps only what a user is shown and what enroll_file needs', () => {
    expect(
      toCandidate({
        msId: 'ms-a',
        driveMsId: 'drive-9',
        name: 'A.xlsx',
        webUrl: 'https://contoso.sharepoint.com/a.xlsx',
        lastModifiedAt: '2026-08-01T10:00:00Z',
        size: 10,
        parentPath: '/Finance',
        enrollmentState: 'hidden',
      }),
    ).toEqual({
      msId: 'ms-a',
      driveMsId: 'drive-9',
      name: 'A.xlsx',
      parentPath: '/Finance',
      lastModifiedAt: '2026-08-01T10:00:00Z',
      enrollmentState: 'hidden',
    });
  });
});

describe('classifyDriveSearchFailure', () => {
  it('names the deployment, not the drive, when the route is absent', () => {
    const { outcome, message } = classifyDriveSearchFailure(
      new RockhopperApiError(404, 'Not Found', null),
    );
    expect(outcome).toBe('backend_unsupported');
    expect(message).toContain('enroll_file');
  });

  it('never reports an unreachable Microsoft as an empty drive', () => {
    const { outcome, message } = classifyDriveSearchFailure(
      new RockhopperApiError(503, 'unavailable', 'DRIVE_SEARCH_UNAVAILABLE'),
    );
    expect(outcome).toBe('search_unavailable');
    expect(message).toContain('not an empty drive');
  });

  it('treats a thrown non-API error as unavailable rather than as data', () => {
    expect(classifyDriveSearchFailure(new Error('socket hang up')).outcome).toBe(
      'search_unavailable',
    );
  });
});

describe('isNoDelegatedToken', () => {
  it('keys on the code, not the status', () => {
    expect(
      isNoDelegatedToken(
        new RockhopperApiError(403, 'no grant', 'NO_DELEGATED_TOKEN'),
      ),
    ).toBe(true);
    // Four distinct refusals share 403 and they name four different remedies;
    // matching the status would send three of the four users to fix the wrong
    // thing.
    expect(
      isNoDelegatedToken(
        new RockhopperApiError(403, 'denied', 'FILE_ACCESS_DENIED'),
      ),
    ).toBe(false);
    expect(isNoDelegatedToken(new Error('403'))).toBe(false);
  });
});
