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

import { RockhopperApiError } from './api-client.js';
import type { EnrollmentState, RockhopperId, Team, UserSummary } from './types.js';

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
  | 'backend_unsupported';

/** Who may see the file. Asked EVERY time; never defaulted (D5/D6). */
export type ShareWith = 'me' | 'team';

/**
 * The refusal codes the enrollment routes emit, mirrored rather than imported
 * — this package ships to customers over npm and cannot depend on the backend
 * tree. Sources: `enrollment-access.types.ts` (`EnrollmentAccessDenialCode`)
 * and `graph-url-resolution.types.ts` (`UrlResolutionError`).
 */
const URL_UNSUPPORTED_PROVIDER = 'URL_UNSUPPORTED_PROVIDER';
const URL_UNRESOLVABLE = 'URL_UNRESOLVABLE';
const URL_FOREIGN_TENANT = 'URL_FOREIGN_TENANT';
const ACCESS_UNPROVEN = 'ACCESS_UNPROVEN';
const MS_SIGN_IN_REQUIRED = 'MS_SIGN_IN_REQUIRED';
/** ENG-2614 — the tenant has not approved Rockhopper, and only an
 * administrator can. Its own code because it is the one refusal in this
 * list the user cannot act on themselves. */
const ADMIN_CONSENT_REQUIRED = 'ADMIN_CONSENT_REQUIRED';
const FILE_ACCESS_DENIED = 'FILE_ACCESS_DENIED';

/**
 * There is deliberately NO client-side host allow-list here.
 *
 * The obvious optimisation is to screen `docs.google.com` locally and save a
 * round trip. It was written and removed: the backend's real rule is narrower
 * than the plausible guess — `/(^|\.)sharepoint\.com$/` ONLY, so
 * `onedrive.live.com` and `*.sharepoint.us` are refused there — and only
 * Google earns `unsupported_provider`, while Dropbox and Box are
 * `unresolvable`. A second copy of that rule in a package customers upgrade on
 * their own schedule would answer differently from the server the moment
 * either side moved, and a pre-screen that refuses a link the backend would
 * have taken is invisible: the user simply cannot add their file. One rule,
 * one place; {@link classifyEnrollmentFailure} maps what it says.
 */

/** The outcome an already-known enrollment state implies, before any write. */
export function outcomeForState(
  state: EnrollmentState,
): 'already_enrolled' | 'restore_confirmation_required' | null {
  if (state === 'enrolled') return 'already_enrolled';
  if (state === 'hidden') return 'restore_confirmation_required';
  return null;
}

export interface ClassifiedFailure {
  outcome: EnrollOutcome | 'error';
  message: string;
}

/**
 * Turn a thrown API error into one of the named outcomes.
 *
 * Keyed on the backend's `code` first and the HTTP status only as a fallback,
 * because the codes each name a DIFFERENT remedy and the statuses do not: four
 * distinct refusals share 403, and answering all of them "you do not have
 * permission" sends three of the four users to fix the wrong thing.
 */
export function classifyEnrollmentFailure(error: unknown): ClassifiedFailure {
  if (!(error instanceof RockhopperApiError)) {
    return {
      outcome: 'error',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  // A route this deployment does not serve. The npm package and the backend
  // ship on separate clocks, and a customer running `npx` picks up `latest`
  // the moment it publishes — so calling an unelevated backend is a REAL
  // case, not a theoretical one, and it must not read as "your file is gone".
  if (error.status === 404) {
    return {
      outcome: 'backend_unsupported',
      message:
        'This Rockhopper deployment does not support adding files from an ' +
        'assistant yet. Add the file from the Rockhopper web app instead. ' +
        'Nothing was changed.',
    };
  }

  switch (error.code) {
    // FIRST, because it is the one refusal here that names an action the
    // user cannot take. Telling them to run `connect_microsoft` sends them
    // to a Microsoft screen that refuses them and returns them here — a
    // loop, and one that reads as our bug rather than a missing approval.
    case ADMIN_CONSENT_REQUIRED:
      return {
        outcome: 'admin_approval_required',
        message:
          'Rockhopper cannot add this file because the user\'s organisation ' +
          'has not approved Rockhopper yet. Microsoft only lets a Microsoft ' +
          '365 administrator approve this — the user cannot grant it ' +
          'themselves, and connecting or signing in again will not change ' +
          'the answer. Ask them to send their IT administrator to ' +
          'https://docs.rockhopper.co/it-setup/approve-file-access, which ' +
          'has the approval link and what it grants. Nothing was changed, ' +
          'and retrying will not help.',
      };
    case ACCESS_UNPROVEN:
      return {
        outcome: 'access_unproven',
        message:
          'Rockhopper cannot confirm you can open this file, because this ' +
          'session has no Microsoft account linked to it. Run ' +
          '`connect_microsoft` to link one, then try again. Nothing was ' +
          'changed.',
      };
    case MS_SIGN_IN_REQUIRED:
      return {
        outcome: 'access_unproven',
        message:
          'Your Microsoft sign-in could not be used to confirm you can open ' +
          'this file. Run `connect_microsoft` to link your account again, ' +
          'then try again. Nothing was changed.',
      };
    case FILE_ACCESS_DENIED:
      return {
        outcome: 'access_unproven',
        message:
          'Microsoft says you cannot open that file, so Rockhopper will not ' +
          'add it. Ask whoever owns the file to share it with you first. ' +
          'Retrying will not help.',
      };
    case URL_UNSUPPORTED_PROVIDER:
      return {
        outcome: 'unsupported_provider',
        message:
          'That link is not a Microsoft SharePoint or OneDrive file. ' +
          '`enroll_file` adds Microsoft Excel workbooks only. Do not ask for ' +
          'another link — this provider is not supported.',
      };
    case URL_UNRESOLVABLE:
      return {
        outcome: 'unresolvable',
        message:
          'That link does not point at a file Rockhopper can find. Ask the ' +
          'user to open the workbook in Excel or SharePoint and paste the ' +
          'address from the browser bar.',
      };
    case URL_FOREIGN_TENANT:
      return {
        outcome: 'unresolvable',
        message:
          'That file belongs to a different Microsoft organisation, so ' +
          'Rockhopper cannot add it. Retrying will not help.',
      };
    default:
      break;
  }

  // No code, so fall back to the status. A 400 from the resolver is always
  // "we could not make sense of this link"; anything else is a real failure
  // and is reported as one rather than dressed up as a named outcome.
  if (error.status === 400) {
    return {
      outcome: 'unresolvable',
      message:
        'Rockhopper could not read that link as a file. Ask the user to open ' +
        'the workbook and paste the address from their browser bar.',
    };
  }
  return { outcome: 'error', message: error.message };
}

/**
 * The two reads `share_with: 'team'` needs. A narrow interface rather than the
 * whole `ApiClient`, so the resolution can be tested without one and so this
 * module never imports the client's concrete type.
 */
export interface TeamDirectory {
  getMe(): Promise<UserSummary>;
  getTeam(teamId: RockhopperId): Promise<Team>;
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
 * Mirrors the web enrollment wizard exactly — the caller's FIRST team
 * membership, its roster, minus the caller — because SP04 defines "team" as
 * "the wizard's default set" and two surfaces answering the same question
 * differently is worse than either answer. The backend has no team-vs-private
 * enum to lean on: `POST /enrolled-files/batch` takes an explicit list of
 * platform ids and nothing else, so the expansion happens here or nowhere.
 *
 * THROWS rather than returning an empty list when there is no team or no
 * teammate. Enrolling privately after the user said "my team" is a silent
 * substitution of a different answer for the one they gave, and it is
 * invisible: the file simply never appears for anyone else.
 */
export async function resolveTeamShareTargets(
  api: TeamDirectory,
): Promise<string[]> {
  const me = await api.getMe();
  const membership = me.teamMembers?.find((m) => m.team != null);
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
  const mine = me.msId ?? me.googleId ?? null;
  const targets = (team.teamMembers ?? [])
    .map((member) => member.user?.msId ?? null)
    .filter((id): id is string => !!id && id !== mine);

  if (targets.length === 0) {
    throw new TeamUnresolvedError(
      `You are the only member of ${
        team.name ? `the ${team.name} team` : 'your team'
      }, so sharing with the team would share it with nobody. Call ` +
        '`enroll_file` again with share_with="me" to add it just for ' +
        'yourself. Nothing was changed.',
    );
  }
  return targets;
}
