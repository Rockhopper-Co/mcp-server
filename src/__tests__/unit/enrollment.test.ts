import { describe, expect, it, vi } from 'vitest';
import { RockhopperApiError } from '../../api-client.js';
import {
  classifyEnrollmentFailure,
  outcomeForState,
  resolveTeamShareTargets,
  TeamUnresolvedError,
} from '../../enrollment.js';

/**
 * ENG-2200 — the branch table behind `enroll_file`, tested without a server.
 *
 * The property under test is that four refusals which SHARE an HTTP status
 * stay four different answers. Collapsing them to "403 — forbidden" is the
 * failure this mapping exists to prevent: three of the four users would then
 * be sent to fix something that is not their problem.
 */

const err = (status: number, code: string | null) =>
  new RockhopperApiError(status, `Rockhopper API ${status}: x`, code);

describe('outcomeForState', () => {
  it('maps the three states to the three conversations they imply', () => {
    expect(outcomeForState('enrolled')).toBe('already_enrolled');
    expect(outcomeForState('hidden')).toBe('restore_confirmation_required');
    // `not_enrolled` is the only state with nothing to say before the write.
    expect(outcomeForState('not_enrolled')).toBeNull();
  });
});

describe('classifyEnrollmentFailure', () => {
  it('keeps the four 403 refusals distinct', () => {
    expect(classifyEnrollmentFailure(err(403, 'ACCESS_UNPROVEN')).message).toContain(
      'connect_microsoft',
    );
    expect(
      classifyEnrollmentFailure(err(403, 'MS_SIGN_IN_REQUIRED')).message,
    ).toContain('connect_microsoft');
    // Access denied is the one with NO retry — saying otherwise starts a loop.
    const denied = classifyEnrollmentFailure(err(403, 'FILE_ACCESS_DENIED'));
    expect(denied.message).toContain('Retrying will not help');
    expect(denied.message).not.toContain('connect_microsoft');
    expect(classifyEnrollmentFailure(err(403, 'URL_FOREIGN_TENANT')).outcome).toBe(
      'unresolvable',
    );
  });

  it('sends the admin-consent refusal to IT, never to connect_microsoft (ENG-2614)', () => {
    // The user CANNOT grant Sites.Read.All — Microsoft reserves it for an
    // administrator. Telling them to reconnect points at a Microsoft screen
    // that refuses them and lands them right back here.
    const blocked = classifyEnrollmentFailure(err(403, 'ADMIN_CONSENT_REQUIRED'));
    expect(blocked.outcome).toBe('admin_approval_required');
    expect(blocked.message).toContain('administrator');
    expect(blocked.message).toContain(
      'https://docs.rockhopper.co/it-setup/approve-file-access',
    );
    expect(blocked.message).not.toContain('connect_microsoft');
    expect(blocked.message).toContain('retrying will not help');
  });

  it('separates an unsupported provider from an unreadable link', () => {
    expect(
      classifyEnrollmentFailure(err(400, 'URL_UNSUPPORTED_PROVIDER')).outcome,
    ).toBe('unsupported_provider');
    expect(classifyEnrollmentFailure(err(400, 'URL_UNRESOLVABLE')).outcome).toBe(
      'unresolvable',
    );
  });

  it('reads a 404 as a backend that has not shipped the route', () => {
    const result = classifyEnrollmentFailure(err(404, null));
    expect(result.outcome).toBe('backend_unsupported');
    expect(result.message).toContain('Nothing was changed');
  });

  it('falls back to the status when the backend sent no code', () => {
    expect(classifyEnrollmentFailure(err(400, null)).outcome).toBe('unresolvable');
    // A 500 is a real failure and is reported as one, not renamed.
    expect(classifyEnrollmentFailure(err(500, null)).outcome).toBe('error');
  });

  it('ignores a code it has never heard of rather than guessing', () => {
    expect(classifyEnrollmentFailure(err(403, 'SOMETHING_NEW')).outcome).toBe(
      'error',
    );
  });

  it('passes a non-API error through as an error', () => {
    expect(classifyEnrollmentFailure(new Error('socket hang up')).message).toBe(
      'socket hang up',
    );
    expect(classifyEnrollmentFailure('a string').outcome).toBe('error');
  });
});

describe('resolveTeamShareTargets', () => {
  const directory = (me: unknown, team: unknown) => ({
    getMe: vi.fn().mockResolvedValue(me),
    getTeam: vi.fn().mockResolvedValue(team),
  });

  it('returns the roster minus the caller', async () => {
    const api = directory(
      { msId: 'me-1', teamMembers: [{ team: { id: 'team-uuid' } }] },
      {
        teamMembers: [
          { user: { msId: 'me-1' } },
          { user: { msId: 'them-2' } },
          { user: { msId: 'them-3' } },
        ],
      },
    );
    await expect(resolveTeamShareTargets(api as never)).resolves.toEqual([
      'them-2',
      'them-3',
    ]);
    expect(api.getTeam).toHaveBeenCalledWith('team-uuid');
  });

  it('falls back to the numeric internalId on a backend without the uuid', async () => {
    const api = directory(
      { msId: 'me-1', teamMembers: [{ team: { internalId: 7 } }] },
      { teamMembers: [{ user: { msId: 'them-2' } }] },
    );
    await resolveTeamShareTargets(api as never);
    expect(api.getTeam).toHaveBeenCalledWith(7);
  });

  it('skips a membership row carrying no team', async () => {
    const api = directory(
      { msId: 'me-1', teamMembers: [{ team: null }, { team: { id: 'team-2' } }] },
      { teamMembers: [{ user: { msId: 'them-2' } }] },
    );
    await resolveTeamShareTargets(api as never);
    expect(api.getTeam).toHaveBeenCalledWith('team-2');
  });

  // ENG-3410 (plan 30, SP07, R3) — THE PRIMARY MEMBERSHIP, NOT THE FIRST ONE.
  //
  // The fixture's primary is at index 1 deliberately. One whose primary is at
  // index 0 passes under both the correct implementation and the broken one it
  // replaces, so it proves nothing.
  it('chooses the primary membership when it is not first in the array', async () => {
    const api = directory(
      {
        msId: 'me-1',
        teamMembers: [
          { isPrimary: false, team: { id: 'secondary-team' } },
          { isPrimary: true, team: { id: 'primary-team' } },
        ],
      },
      { teamMembers: [{ user: { msId: 'them-2' } }] },
    );
    await resolveTeamShareTargets(api as never);
    expect(api.getTeam).toHaveBeenCalledWith('primary-team');
  });

  // The installed-client window: `is_primary` starts being written when the
  // backend deploys, and a person whose rows predate the backfill has none.
  // Falling through to the first membership with a team keeps them working
  // rather than throwing `TeamUnresolvedError` at every user of an older server.
  it('falls back to the first membership with a team when none is marked primary', async () => {
    const api = directory(
      {
        msId: 'me-1',
        teamMembers: [{ team: { id: 'first-team' } }, { team: { id: 'second-team' } }],
      },
      { teamMembers: [{ user: { msId: 'them-2' } }] },
    );
    await resolveTeamShareTargets(api as never);
    expect(api.getTeam).toHaveBeenCalledWith('first-team');
  });

  // A primary row carrying no team is not a usable answer. Selecting it and
  // then reading `team?.id` off it yields `undefined`, which reports "you are
  // not on a team" to somebody who is.
  it('skips a primary membership that carries no team', async () => {
    const api = directory(
      {
        msId: 'me-1',
        teamMembers: [
          { isPrimary: true, team: null },
          { isPrimary: false, team: { id: 'real-team' } },
        ],
      },
      { teamMembers: [{ user: { msId: 'them-2' } }] },
    );
    await resolveTeamShareTargets(api as never);
    expect(api.getTeam).toHaveBeenCalledWith('real-team');
  });

  it('throws rather than returning [] when there is no team', async () => {
    // An empty list would enroll privately — a different answer from the one
    // the user gave, and one nobody would notice.
    const api = directory({ msId: 'me-1', teamMembers: [] }, {});
    await expect(resolveTeamShareTargets(api as never)).rejects.toBeInstanceOf(
      TeamUnresolvedError,
    );
    expect(api.getTeam).not.toHaveBeenCalled();
  });

  it('throws when the caller is the only member', async () => {
    const api = directory(
      { msId: 'me-1', teamMembers: [{ team: { id: 't' } }] },
      { name: 'Finance', teamMembers: [{ user: { msId: 'me-1' } }] },
    );
    await expect(resolveTeamShareTargets(api as never)).rejects.toThrow(
      /only member of the Finance team/,
    );
  });

  it('drops a teammate with no platform id instead of sending a null', async () => {
    const api = directory(
      { msId: 'me-1', teamMembers: [{ team: { id: 't' } }] },
      { teamMembers: [{ user: { msId: null } }, { user: { msId: 'them-2' } }] },
    );
    await expect(resolveTeamShareTargets(api as never)).resolves.toEqual([
      'them-2',
    ]);
  });

  it('identifies a Google caller by googleId when there is no msId', async () => {
    const api = directory(
      { googleId: 'g-1', teamMembers: [{ team: { id: 't' } }] },
      { teamMembers: [{ user: { msId: 'g-1' } }, { user: { msId: 'them-2' } }] },
    );
    await expect(resolveTeamShareTargets(api as never)).resolves.toEqual([
      'them-2',
    ]);
  });

  // ENG-4219 — AN ALL-GOOGLE TEAM IS THE CASE THAT FAILS CLOSED.
  //
  // The target side used to read `msId` alone while the SELF side at :346
  // already read both. Every member of a Google-only team therefore mapped to
  // null, the roster filtered to empty, and the caller was told "you are the
  // only member of your team" — a false statement the assistant relays as
  // fact. A MIXED Microsoft/Google team hides this: the surviving Microsoft
  // members keep the list non-empty and nothing throws. Hence all-Google, and
  // hence asserting on the RETURNED IDS — a test that merely calls the
  // function passes against the broken code, because throwing is what it did.
  it('returns Google-linked teammates on a team with no Microsoft members', async () => {
    const api = directory(
      { googleId: 'g-me', teamMembers: [{ team: { id: 't' } }] },
      {
        name: 'Finance',
        teamMembers: [
          { user: { googleId: 'g-me' } },
          { user: { googleId: 'g-2' } },
          { user: { googleId: 'g-3' } },
        ],
      },
    );
    await expect(resolveTeamShareTargets(api as never)).resolves.toEqual([
      'g-2',
      'g-3',
    ]);
  });

  // ENG-4219 defect 2 — THE CALLER MUST BE EXCLUDED BY EITHER OF THEIR IDS.
  //
  // `mine` used to be a single `msId ?? googleId` value compared against ids
  // drawn from a different field, so a caller holding BOTH providers whose
  // roster row is serialized with only the Google one matched nothing and was
  // handed their own file to be shared with. Comparing against the SET of the
  // caller's identities removes the cross-namespace comparison rather than
  // patching it.
  it('excludes the caller when the roster identifies them by their other provider', async () => {
    const api = directory(
      { msId: 'ms-me', googleId: 'g-me', teamMembers: [{ team: { id: 't' } }] },
      {
        teamMembers: [
          { user: { googleId: 'g-me' } },
          { user: { msId: 'them-2' } },
        ],
      },
    );
    await expect(resolveTeamShareTargets(api as never)).resolves.toEqual([
      'them-2',
    ]);
  });
});

/**
 * DRIFT SENTINEL — the mirrored denial-code list against the backend's.
 *
 * `enrollment.ts:60-78` copies the backend's refusal codes by hand, with the
 * reason stated: this package ships to customers over npm and cannot import
 * the backend tree. So nothing in either repo compares the two, and the copy
 * can fall behind in silence — every test in this file, including the ones
 * above, exercises the copy against itself.
 *
 * Measured 2026-08-22 against `Rockhopper-Co/backend` `origin/dev`
 * `src/resources/enrolled-files/enrollment-access.types.ts:40-46`, whose
 * `EnrollmentAccessDenialCode` union carries SIX values. The copy carries five
 * of them, and does not carry:
 *
 * - `GOOGLE_SIGN_IN_REQUIRED` — unreachable here on purpose. `enroll_file`
 *   refuses a non-Microsoft link with `URL_UNSUPPORTED_PROVIDER` before any
 *   Google access check runs, so the omission is a scope decision, not drift.
 * - `ACCESS_CHECK_UNAVAILABLE` — reachable, and the backend's own docblock
 *   calls it "Retryable" (line 38). It is unmapped here, so it falls past the
 *   switch to the generic `error` arm and the model is handed a bare
 *   `Rockhopper API 403` with no statement that trying again may work.
 *
 * The cases below PIN what the code does today rather than assert what it
 * should do — mapping a new code is a product decision about what the user is
 * told, not a test fix. Whoever makes that decision should find this failing.
 */
describe('mirrored denial-code vocabulary vs the backend', () => {
  it('classifies the retryable ACCESS_CHECK_UNAVAILABLE as a generic error today', () => {
    const result = classifyEnrollmentFailure(err(403, 'ACCESS_CHECK_UNAVAILABLE'));

    expect(result.outcome).toBe('error');
    // The two things the code path does NOT say, and the backend says it is.
    expect(result.message).not.toMatch(/try again|retry/i);
    expect(result.message).not.toContain('connect_microsoft');
  });

  it('does not misroute it to an account problem the user would go and fix', () => {
    // The failure that would be worse than the generic message: telling a user
    // whose provider merely failed to answer that their access is unproven.
    const result = classifyEnrollmentFailure(err(403, 'ACCESS_CHECK_UNAVAILABLE'));

    expect(result.outcome).not.toBe('access_unproven');
    expect(result.outcome).not.toBe('admin_approval_required');
  });

  it('leaves GOOGLE_SIGN_IN_REQUIRED unmapped — enroll_file is Microsoft-only', () => {
    // Pinned so that adding Google enrollment has to come back through here.
    expect(
      classifyEnrollmentFailure(err(403, 'GOOGLE_SIGN_IN_REQUIRED')).outcome,
    ).toBe('error');
    expect(
      classifyEnrollmentFailure(err(400, 'URL_UNSUPPORTED_PROVIDER')).message,
    ).toContain('Microsoft Excel workbooks only');
  });
});
