/**
 * ENG-2200 / ENG-2536 — what `enroll_file` tells the user about the server's
 * answer and about a refusal. Moved out of `enrollment.ts` (ENG-9660) so that
 * file comes under 300 lines; `enrollment.ts` re-exports both functions, so
 * no caller's import changed.
 */

import { RockhopperApiError } from './api-client.js';
import type { EnrollOutcome } from './enrollment.js';
import type { ServerEnrollmentOutcome } from './types.js';

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

/**
 * ENG-2536 — turn the outcome the SERVER reported into what the user is told.
 *
 * Two things make this worth a function rather than a ternary at the call site.
 *
 * First, it is exhaustive with a `never` arm. `ServerEnrollmentOutcome` is a
 * hand-kept mirror of a backend enum (this package ships over npm and cannot
 * import the backend tree), so the only moment anybody notices a fourth value
 * is when they edit that union — and this is what breaks and makes them handle
 * it. ENG-2580 is the same shape gone wrong: fifteen if-chains where a new
 * value fell into every `else` and nothing failed.
 *
 * Second, `already_enrolled` is the one answer that is not a promise about the
 * future. Everything else here says "we are reading the workbook, come back";
 * that one says nothing was written and nothing will be. Saying "Rockhopper
 * reads the workbook in the background" about a file it read months ago sends
 * the user to wait for an event that will never arrive — the ENG-1647 dead end
 * with a friendlier voice.
 */
export function describeServerOutcome(
  serverOutcome: ServerEnrollmentOutcome,
  fileName: string,
  who: string,
): { outcome: EnrollOutcome; text: string } {
  const subject = `"${fileName || 'The workbook'}"`;
  const background =
    'Rockhopper reads the workbook in the background, so its versions and ' +
    'change history appear shortly — check with `search_files` if the user ' +
    'wants confirmation.';

  switch (serverOutcome) {
    case 'enrolled':
      return {
        outcome: 'enrolled',
        text: `${subject} is being added to Rockhopper${who}. ${background}`,
      };
    case 'restored':
      return {
        outcome: 'restored',
        text: `${subject} is being restored${who}. ${background}`,
      };
    case 'already_enrolled':
      return {
        outcome: 'already_enrolled',
        text:
          `${subject} was already in Rockhopper, so nothing was added${who}. ` +
          'Its versions and history are available now through ' +
          '`get_file_versions` and `get_cell_history` — there is nothing to ' +
          'wait for.',
      };
    default: {
      // Compile time: a new member of the mirror fails here. Run time: a
      // backend newer than this package can still send a word it has never
      // heard of, and returning the bare string made the caller destructure
      // two `undefined`s (ENG-9660). The request WAS accepted, so say that,
      // say the word, and send the model to check rather than to claim.
      const unheard: never = serverOutcome;
      return {
        outcome: 'enrolled',
        text:
          `${subject} was sent to Rockhopper${who}, which answered ` +
          `"${String(unheard)}". Check with \`search_files\` whether it was ` +
          'added before telling the user it was.',
      };
    }
  }
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
