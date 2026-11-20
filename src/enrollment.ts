/**
 * ENG-2200 (plan 13 / SP03) — the vocabulary and the refusal mapping behind
 * `enroll_file`, kept out of the tool so the branch table can be tested
 * without a registered server and so neither file crosses 300 lines.
 *
 * **Why this tool exists.** A customer asked Claude to enroll a SharePoint
 * workbook. A name-substring search matched a DIFFERENT, already-enrolled file
 * and the assistant answered "already enrolled". Told it had the wrong file,
 * it enumerated its tools and found no enroll tool existed at all (ENG-1647).
 * Two failures: a wrong match reported as a fact, and a dead end. Every
 * decision below is aimed at one of those — an outcome is never inferred from
 * a name, and no path ends without a next action the user can take.
 */

import type { RockhopperId, Team, UserSummary } from './types.js';

/**
 * Every answer `enroll_file` can give, as a value a model can branch on
 * instead of reading prose.
 *
 * The seven ENROLLMENT results — what happened to the file:
 * - `enrolled` — accepted; the file was not here before.
 * - `restored` — accepted; a file the user had removed is visible again.
 * - `already_enrolled` — nothing to do; it is here and visible.
 * - `access_unproven` — refused: this session has no Microsoft identity.
 * - `admin_approval_required` — refused: the user's ORGANISATION has not
 *   approved Rockhopper. Separate from `access_unproven` because the user
 *   cannot fix it and must not be told to reconnect (ENG-2614).
 * - `unresolvable` — refused: the link does not name a file we can find.
 * - `unsupported_provider` — refused: not a Microsoft link.
 *
 * Three CONTROL answers — the tool needs something before it can proceed:
 * - `share_with_required` — the model must ask the user who may see the file.
 * - `restore_confirmation_required` — the target is hidden (D8); restoring is
 *   a second, explicit call.
 * - `backend_unsupported` — this Rockhopper deployment has no enrollment API
 *   yet. Published separately from the backend, so this is reachable.
 *
 * Two CONVERSION answers (ENG-9660), for an Office file in Google Drive that
 * Rockhopper converts to Google format, see `enrollment-conversion.ts`:
 * - `conversion_pending` — being converted; nothing to do but check back.
 * - `conversion_refused` — Google cannot convert it; nothing was created.
 */
export type EnrollOutcome =
  | 'enrolled'
  | 'restored'
  | 'already_enrolled'
  | 'access_unproven'
  | 'admin_approval_required'
  | 'unresolvable'
  | 'unsupported_provider'
  | 'share_with_required'
  | 'restore_confirmation_required'
  | 'backend_unsupported'
  | 'conversion_pending'
  | 'conversion_refused';

/** Who may see the file. Asked EVERY time; never defaulted (D5/D6). */
export type ShareWith = 'me' | 'team';

// ENG-9660 — moved to `enrollment-outcomes.ts` so this file stays under 300
// lines; re-exported so every import of them from here still works.
export {
  classifyEnrollmentFailure,
  describeServerOutcome,
  type ClassifiedFailure,
} from './enrollment-outcomes.js';

// ENG-9660 — reads the conversion state too; lives beside its vocabulary.
export { outcomeForState } from './enrollment-conversion.js';

/**
 * The two reads `share_with: 'team'` needs. A narrow interface rather than the
 * whole `ApiClient`, so the resolution can be tested without one and so this
 * module never imports the client's concrete type.
 */
export interface TeamDirectory {
  getMe(): Promise<UserSummary>;
  getTeam(teamId: RockhopperId): Promise<Team>;
}

/**
 * ENG-4279 — the fan-out list AND what it could not reach.
 *
 * An object rather than the bare `string[]` this used to be: shared with 1 of 4
 * while reporting plain success is the damaging half of this defect, and a
 * shape carrying only the list cannot express it.
 */
export interface TeamShareTargets {
  /** Platform ids `POST /enrolled-files/batch` can actually resolve. */
  targets: string[];
  /**
   * Roster members, excluding the caller, carrying NEITHER `msId` nor
   * `googleId`. The backend resolves share targets with `findOneByMsId`, so
   * nothing would reach them — a count to REPORT, never a list to retry.
   */
  unreachable: number;
}

/** Raised when `share_with: 'team'` names a team we cannot resolve. */
export class TeamUnresolvedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamUnresolvedError';
  }
}

/**
 * The teammates a `share_with: 'team'` enroll fans the file out to.
 *
 * Mirrors the web enrollment wizard exactly — the caller's PRIMARY team
 * membership, its roster, minus the caller — because SP04 defines "team" as
 * "the wizard's default set" and two surfaces answering the same question
 * differently is worse than either answer. The backend has no team-vs-private
 * enum to lean on: `POST /enrolled-files/batch` takes an explicit list of
 * platform ids and nothing else, so the expansion happens here or nowhere.
 *
 * ENG-3410 (plan 30, SP07, R3) — this used to read FIRST, and first meant
 * "whatever position the array happened to put it in". A person on two teams got
 * their file shared with whichever roster the ORM returned first. R3 designates
 * one membership as primary and this is the value that replaces the index.
 *
 * THROWS rather than returning an empty list when there is no team or no
 * teammate. Enrolling privately after the user said "my team" is a silent
 * substitution of a different answer for the one they gave, and it is
 * invisible: the file simply never appears for anyone else.
 */
export async function resolveTeamShareTargets(
  api: TeamDirectory,
): Promise<TeamShareTargets> {
  const me = await api.getMe();
  // ENG-3410 — primary first, then the first usable membership.
  //
  // The FALLBACK IS NOT DEFENSIVE PADDING, it is the installed-client window.
  // `is_primary` starts being written when the backend deploys; a person whose
  // rows predate that backfill carries no primary at all, and a bare
  // `find(m => m.isPrimary)` would throw `TeamUnresolvedError` at them instead
  // of sharing with the team they plainly have.
  //
  // `m.team != null` is required on BOTH legs. A primary row whose team the
  // backend could not serve is not an answer: selecting it yields an undefined
  // team id and reports "you are not on a team" to somebody who is.
  const memberships = me.teamMembers ?? [];
  const membership =
    memberships.find((m) => m.isPrimary && m.team != null) ??
    memberships.find((m) => m.team != null);
  const teamId = membership?.team?.id ?? membership?.team?.internalId;
  if (teamId === undefined) {
    throw new TeamUnresolvedError(
      'You are not on a team yet, so there is nobody to share this file ' +
        'with. Call `enroll_file` again with share_with="me" to add it just ' +
        'for yourself, or set up a team in the Rockhopper web app first. ' +
        'Nothing was changed.',
    );
  }

  const team = await api.getTeam(teamId);
  // ENG-4219 — READ THE SAME PAIR ON BOTH SIDES.
  //
  // The self side already read `msId ?? googleId`; the target side read `msId`
  // alone, so a Google-linked teammate mapped to null and was filtered out
  // below. A team with no Microsoft members filtered to EMPTY and reported
  // "you are the only member of your team" to somebody with four colleagues —
  // false, and relayed to the user as fact by the assistant.
  //
  // The identifier stays the PLATFORM id rather than moving to the internal
  // `UserSummary.id` uuid, which reads like the better answer and is not one:
  // the backend resolves every element of `shareWithUserMsIds` with
  // `findOneByMsId` (`where: { msId }`), so an internal id matches no row and
  // each teammate is skipped with a log line the user never sees — a silent
  // no-op, strictly worse than today's wrong error. A teammate with NEITHER
  // provider linked is still dropped here for the same reason: that endpoint
  // has no way to reach them.
  //
  // ENG-4279 — that last sentence is true about the MECHANISM and was read as
  // a licence for the MESSAGE to state the opposite. Reach is still
  // impossible; what changed is that the drop is now COUNTED and SAID, below.
  //
  // `mine` is a SET of the caller's identities, not a single `??` pick. The
  // roster may serialize a two-provider caller by whichever id it holds, and
  // one value compared against the other namespace never matches — which put
  // the caller in their own share list.
  const mine = new Set(
    [me.msId, me.googleId].filter((id): id is string => !!id),
  );
  const roster = team.teamMembers ?? [];
  const targets = roster
    .map((member) => member.user?.msId ?? member.user?.googleId ?? null)
    .filter((id): id is string => !!id && !mine.has(id));

  // ENG-4279 — COUNT WHAT WE DROPPED, because `targets.length === 0` cannot
  // tell "the team has one member" from "the team has five and we can address
  // none of them", and it used to assert the first.
  //
  // The caller's OWN row is unaddressable too when they have no provider link,
  // so it is excluded by `internalId`. ⛔ NEVER by comparing the provider ids:
  // two absent ids are EQUAL in JavaScript, so `msId === msId` is true for any
  // two unlinked people and every teammate would be erased as "the caller".
  // Where either side carries no `internalId` — a fixture, or a backend older
  // than the field — the row is COUNTED, because over-reporting a colleague is
  // recoverable and silently dropping one is the defect being fixed.
  const unreachable = roster.filter((member) => {
    const user = member.user;
    if (user == null) return false;
    if (user.msId || user.googleId) return false;
    if (user.internalId !== undefined && me.internalId !== undefined) {
      return user.internalId !== me.internalId;
    }
    return true;
  }).length;

  const teamLabel = team.name ? `the ${team.name} team` : 'your team';

  if (targets.length === 0) {
    // A DIFFERENT REFUSAL, not a reworded one. The remedy is not "enrol
    // privately because you have no colleagues" — it is "your colleagues need
    // to link an account", which nobody could act on while the message said
    // the team was empty.
    if (unreachable > 0) {
      throw new TeamUnresolvedError(
        `None of the ${unreachable} other members of ${teamLabel} can be ` +
          'shared with — they have no Microsoft or Google account linked to ' +
          'Rockhopper, and sharing can only reach a linked account. Ask them ' +
          'to link one in Rockhopper Settings, or call `enroll_file` again ' +
          'with share_with="me" to add it just for yourself. Nothing was ' +
          'changed.',
      );
    }
    throw new TeamUnresolvedError(
      `You are the only member of ${teamLabel}, so sharing with the team ` +
        'would share it with nobody. Call `enroll_file` again with ' +
        'share_with="me" to add it just for yourself. Nothing was changed.',
    );
  }
  return { targets, unreachable };
}
