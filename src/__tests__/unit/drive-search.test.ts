import { describe, expect, it } from 'vitest';
import { RockhopperApiError } from '../../api-client.js';
import {
  CandidateRegistry,
  DRIVE_SEARCH_SESSION_BUDGET,
  SearchBudget,
  classifyDriveSearchFailure,
  isNoDelegatedToken,
  toCandidate,
  type Candidate,
} from '../../drive-search.js';

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

describe('CandidateRegistry', () => {
  it('resolves a position in a set it was given', () => {
    const registry = new CandidateRegistry();
    registry.remember('nonce-1', [candidate('A.xlsx', 'ms-a'), candidate('B.xlsx', 'ms-b')]);
    expect(registry.resolve('nonce-1', 1)?.msId).toBe('ms-b');
  });

  it('refuses a nonce it never issued', () => {
    const registry = new CandidateRegistry();
    registry.remember('nonce-1', [candidate('A.xlsx', 'ms-a')]);
    // The whole point: the nonce round-trips through the client and nothing
    // signs it. An unrecognised one must find nothing rather than be trusted
    // to describe a file.
    expect(registry.resolve('forged', 0)).toBeNull();
  });

  it('refuses a position outside the set it offered', () => {
    const registry = new CandidateRegistry();
    registry.remember('nonce-1', [candidate('A.xlsx', 'ms-a')]);
    expect(registry.resolve('nonce-1', 1)).toBeNull();
    expect(registry.resolve('nonce-1', -1)).toBeNull();
    expect(registry.resolve('nonce-1', 0.5)).toBeNull();
    expect(registry.resolve('nonce-1', Number.NaN)).toBeNull();
  });

  it('forgets the oldest sets so a long session cannot grow without bound', () => {
    const registry = new CandidateRegistry();
    for (let i = 0; i <= CandidateRegistry.MAX_REMEMBERED; i += 1) {
      registry.remember(`nonce-${i}`, [candidate('A.xlsx', `ms-${i}`)]);
    }
    expect(registry.recall('nonce-0')).toBeNull();
    expect(registry.recall(`nonce-${CandidateRegistry.MAX_REMEMBERED}`)).not.toBeNull();
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
