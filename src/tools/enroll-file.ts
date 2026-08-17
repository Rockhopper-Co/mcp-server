import type { McpServer } from '@modelcontextprotocol/server';
import type { ApiClient } from '../api-client.js';
import {
  classifyEnrollmentFailure,
  describeServerOutcome,
  outcomeForState,
  resolveTeamShareTargets,
  TeamUnresolvedError,
  type ShareWith,
} from '../enrollment.js';
import type {
  EnrollmentState,
  QueuedEnrollment,
  ServerEnrollmentOutcome,
} from '../types.js';
import {
  ENROLL_ANNOTATIONS,
  ENROLL_DESCRIPTION,
  ENROLL_INPUT_SCHEMA,
  SHARE_QUESTION,
  toolResult,
} from './enroll-file.contract.js';

/**
 * ENG-2200 — the tool ENG-1647's customer reached for and did not find.
 *
 * Two properties are load-bearing and neither is obvious from the happy path:
 *
 * 1. **`share_with` is enforced in the HANDLER, not by the schema.** It is
 *    optional in zod on purpose. A required field would make an omission a
 *    protocol-level validation error, and the model would see a stack-shaped
 *    rejection instead of the question it is supposed to put to the user. D5/D6
 *    say ask EVERY time, so the tool answers the omission with the question.
 *    What it must never do is pick one — enrolling privately when the user
 *    meant "my team", or vice versa, is invisible until somebody cannot find
 *    the file.
 * 2. **A hidden file is never silently restored.** `hidden` means a human
 *    deliberately removed it (ENG-2541); the row, its versions and its whole
 *    history survived. Answering "already enrolled" to that person is the
 *    ENG-1647 dead end rebuilt on new code, so the first call reports
 *    `restore_confirmation_required` and only a second call carrying
 *    `confirm_restore: true` writes anything.
 */

/** One resolved Microsoft file plus what Rockhopper already knows about it. */
interface Target {
  msId: string;
  driveMsId: string;
  name: string;
  state: EnrollmentState;
}

export function registerEnrollFileTool(server: McpServer, api: ApiClient): void {
  /**
   * Turn whichever input arrived into `(identity, current state)`.
   *
   * Both branches learn the state BEFORE writing anything, because the whole
   * point of the tool is that `enrolled`, `hidden` and `not_enrolled` lead to
   * three different conversations.
   */
  async function resolveTarget(args: {
    url?: string;
    driveMsId?: string;
    msId?: string;
  }): Promise<Target> {
    if (args.url) {
      const resolved = await api.resolveEnrollmentUrl(args.url);
      return {
        msId: resolved.msId,
        driveMsId: resolved.driveMsId,
        name: resolved.name,
        state: resolved.enrollmentState,
      };
    }

    const msId = args.msId as string;
    const driveMsId = args.driveMsId as string;
    const [info] = await api.getEnrollmentInfo([msId]);
    return {
      msId,
      driveMsId,
      // The bulk read withholds `name` for a hidden or stub row, and an id
      // enroll has no other source for it. The backend fills the real name
      // from Graph during the enroll, so an empty string here is a placeholder
      // that never reaches a user, not a guess at what the file is called.
      name: info?.name ?? '',
      state: info?.enrollmentState ?? 'not_enrolled',
    };
  }

  /**
   * ENG-2536 — the server's own verdict, or null when it did not give one.
   *
   * Null is not hypothetical: this package publishes to npm on its own clock
   * and a customer's `npx` picks up `latest` immediately, so a backend that
   * predates the field is a live case. The caller falls back to what the
   * pre-write lookup said, which is exactly the behaviour that shipped before.
   */
  function serverOutcomeOf(
    queued: QueuedEnrollment,
    target: Target,
  ): ServerEnrollmentOutcome | null {
    const files = queued.files ?? [];
    const mine =
      files.find((f) => f.msId === target.msId || f.platformId === target.msId) ??
      (files.length === 1 ? files[0] : undefined);
    return mine?.outcome ?? null;
  }

  async function enroll(
    target: Target,
    shareWith: ShareWith,
  ): Promise<{
    enrollmentId: string;
    sharedWith: number;
    serverOutcome: ServerEnrollmentOutcome | null;
  }> {
    const file = {
      msId: target.msId,
      driveMsId: target.driveMsId,
      name: target.name,
    };
    if (shareWith === 'me') {
      const queued = await api.createEnrolledFile(file);
      return {
        enrollmentId: queued.enrollmentId,
        sharedWith: 0,
        serverOutcome: serverOutcomeOf(queued, target),
      };
    }
    const targets = await resolveTeamShareTargets(api);
    const queued = await api.enrollFileSharedWith(file, targets);
    return {
      enrollmentId: queued.enrollmentId,
      sharedWith: targets.length,
      serverOutcome: serverOutcomeOf(queued, target),
    };
  }

  server.registerTool(
    'enroll_file',
    {
      title: 'Add a File to Rockhopper',
      description: ENROLL_DESCRIPTION,
      inputSchema: ENROLL_INPUT_SCHEMA,
      annotations: ENROLL_ANNOTATIONS,
    },
    async ({ url, driveMsId, msId, share_with, confirm_restore }) => {
      const hasUrl = !!url?.trim();
      const hasIds = !!msId?.trim() && !!driveMsId?.trim();

      if (hasUrl && hasIds) {
        return toolResult({
          outcome: 'unresolvable',
          isError: true,
          text:
            'Send either `url` or the `driveMsId` + `msId` pair, not both — ' +
            'they can name different files and Rockhopper will not guess ' +
            'which one you meant. Nothing was changed.',
        });
      }
      if (!hasUrl && !hasIds) {
        return toolResult({
          outcome: 'unresolvable',
          isError: true,
          text:
            'No file was named. Ask the user to open the workbook and paste ' +
            'the address from their browser bar, then call `enroll_file` with ' +
            'that `url`. Nothing was changed.',
        });
      }
      // Checked BEFORE the resolve so an omitted `share_with` costs no network
      // call and, more importantly, cannot be answered by a half-done enroll.
      if (share_with === undefined) {
        return toolResult({
          outcome: 'share_with_required',
          text: SHARE_QUESTION,
        });
      }

      let target: Target;
      try {
        target = await resolveTarget({ url, driveMsId, msId });
      } catch (error) {
        const { outcome, message } = classifyEnrollmentFailure(error);
        return toolResult({
          outcome: outcome === 'error' ? 'unresolvable' : outcome,
          text:
            outcome === 'error'
              ? `Rockhopper could not look that file up: ${message}`
              : message,
          isError: true,
        });
      }

      const known = outcomeForState(target.state);
      if (known === 'already_enrolled') {
        return toolResult({
          outcome: 'already_enrolled',
          text:
            `"${target.name}" is already in Rockhopper — nothing to do. Its ` +
            'versions and history are available through `get_file_versions` ' +
            'and `get_cell_history`.',
          detail: { fileMsId: target.msId, name: target.name },
        });
      }
      if (known === 'restore_confirmation_required' && !confirm_restore) {
        return toolResult({
          outcome: 'restore_confirmation_required',
          text:
            `"${target.name || 'That workbook'}" was previously removed from ` +
            'Rockhopper\'s file lists. Its versions, comments and history were ' +
            'kept. Ask the user whether they want it restored, and if they do, ' +
            'call `enroll_file` again with the same arguments plus ' +
            'confirm_restore: true. Nothing has been changed.',
          detail: { fileMsId: target.msId, name: target.name || null },
        });
      }
      const restoring = known === 'restore_confirmation_required';

      try {
        const { enrollmentId, sharedWith, serverOutcome } = await enroll(
          target,
          share_with,
        );
        const who =
          share_with === 'team'
            ? ` and shared with ${sharedWith} teammate(s)`
            : ' — visible to you only';
        // ENG-2536: the SERVER's verdict wins over the one inferred from the
        // lookup taken before the write. The two can disagree, and when they
        // do the server is right: the lookup happened earlier, so a file
        // somebody else added in between reads `not_enrolled` here and would
        // otherwise be reported as a fresh add. The fallback is what shipped
        // before, for a backend older than the field.
        const { outcome, text } = describeServerOutcome(
          serverOutcome ?? (restoring ? 'restored' : 'enrolled'),
          target.name,
          who,
        );
        return toolResult({
          outcome,
          text,
          detail: {
            fileMsId: target.msId,
            name: target.name || null,
            enrollmentId,
            shareWith: share_with,
            sharedWithCount: sharedWith,
          },
        });
      } catch (error) {
        if (error instanceof TeamUnresolvedError) {
          return toolResult({
            outcome: 'share_with_required',
            text: error.message,
            isError: true,
          });
        }
        const { outcome, message } = classifyEnrollmentFailure(error);
        return toolResult({
          outcome: outcome === 'error' ? 'unresolvable' : outcome,
          text:
            outcome === 'error'
              ? `Rockhopper could not add that file: ${message}`
              : message,
          isError: true,
        });
      }
    },
  );
}
