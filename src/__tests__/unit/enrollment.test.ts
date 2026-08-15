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
});
