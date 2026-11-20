import type { McpServer } from '@modelcontextprotocol/server';
import type { ApiClient } from '../api-client.js';
import {
  resolveTeamShareTargets,
  TeamUnresolvedError,
  type ShareWith,
} from '../enrollment.js';
import type { QueuedEnrollment, QueuedEnrollmentFile } from '../types.js';
import { answerAfterWrite } from './enroll-file.after-write.js';
import {
  ENROLL_ANNOTATIONS,
  ENROLL_DESCRIPTION,
  ENROLL_INPUT_SCHEMA,
  SHARE_QUESTION,
  toolResult,
} from './enroll-file.contract.js';
import {
  answerBeforeWrite,
  classify,
  resolveTarget,
  type Target,
} from './enroll-file.target.js';

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

export function registerEnrollFileTool(server: McpServer, api: ApiClient): void {
  /**
   * ENG-2536 — the server's own verdict, or null when it did not give one.
   *
   * Null is not hypothetical: this package publishes to npm on its own clock
   * and a customer's `npx` picks up `latest` immediately, so a backend that
   * predates the field is a live case. The caller falls back to what the
   * pre-write lookup said, which is exactly the behaviour that shipped before.
   */
  function serverFileOf(
    queued: QueuedEnrollment,
    target: Target,
  ): QueuedEnrollmentFile | null {
    const files = queued.files ?? [];
    return (
      files.find(
        (f) => f.msId === target.fileId || f.platformId === target.fileId,
      ) ??
      (files.length === 1 ? files[0] : null)
    );
  }

  async function enroll(
    target: Target,
    shareWith: ShareWith,
  ): Promise<{
    enrollmentId: string;
    sharedWith: number;
    /**
     * ENG-4279 — teammates on the roster the share could not reach, because
     * they have no Microsoft or Google account linked. Reported to the user;
     * `0` for a `share_with: 'me'` enroll, which shares with nobody by design.
     */
    skipped: number;
    /** ENG-9660 — the door's per-file answer, its conversion included. */
    serverFile: QueuedEnrollmentFile | null;
  }> {
    const file = {
      provider: target.provider,
      fileId: target.fileId,
      driveMsId: target.driveMsId,
      name: target.name,
    };
    if (shareWith === 'me') {
      const queued = await api.createEnrolledFile(file);
      return {
        enrollmentId: queued.enrollmentId,
        sharedWith: 0,
        skipped: 0,
        serverFile: serverFileOf(queued, target),
      };
    }
    const { targets, unreachable } = await resolveTeamShareTargets(api);
    const queued = await api.enrollFileSharedWith(file, targets);
    return {
      enrollmentId: queued.enrollmentId,
      sharedWith: targets.length,
      skipped: unreachable,
      serverFile: serverFileOf(queued, target),
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
    async ({ url, driveMsId, msId, provider, share_with, confirm_restore }) => {
      const hasUrl = !!url?.trim();
      const isSheet = provider === 'smartsheet';
      if (isSheet && (hasUrl || !!driveMsId?.trim() || !msId?.trim())) {
        return toolResult({
          outcome: 'unresolvable',
          isError: true,
          text:
            'A Smartsheet sheet is added with `provider` "smartsheet" and the ' +
            'sheet id as `msId` — nothing else. Find the id with ' +
            '`search_drive_files` or `list_unenrolled_files`. Nothing was ' +
            'changed.',
        });
      }
      const hasIds = isSheet || (!!msId?.trim() && !!driveMsId?.trim());

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
        target = await resolveTarget(api, { url, driveMsId, msId, provider });
      } catch (error) {
        const { outcome, message } = classify(error, provider);
        return toolResult({
          outcome: outcome === 'error' ? 'unresolvable' : outcome,
          text:
            outcome === 'error'
              ? `Rockhopper could not look that file up: ${message}`
              : message,
          isError: true,
        });
      }

      // ENG-9660 — the answers that need no write, the conversion's included.
      const known = answerBeforeWrite(target, confirm_restore);
      if (known !== 'write' && known !== 'restore') return toolResult(known);
      const restoring = known === 'restore';

      try {
        const { enrollmentId, sharedWith, skipped, serverFile } =
          await enroll(target, share_with);
        // ENG-4279 — SAY WHO WAS LEFT OUT. Sharing with 1 of 4 and reporting
        // plain success is the damaging half of that defect: the user is told
        // the team has the file and three colleagues silently do not. The
        // remedy is named because the drop is fixable by the people it names.
        const who =
          share_with === 'team'
            ? ` and shared with ${sharedWith} teammate(s)` +
              (skipped > 0
                ? `. ${skipped} other team member(s) could NOT be included ` +
                  'because they have no Microsoft or Google account linked ' +
                  'to Rockhopper — ask them to link one in Rockhopper ' +
                  'Settings, then share the file with them again'
                : '')
            : ' — visible to you only';
        return toolResult(
          answerAfterWrite({
            target,
            serverFile,
            restoring,
            who,
            shared: {
              enrollmentId,
              shareWith: share_with,
              sharedWithCount: sharedWith,
              // ENG-4279 — structured alongside the prose, so a client that
              // renders `detail` rather than the text still sees the drop.
              skippedCount: skipped,
            },
          }),
        );
      } catch (error) {
        if (error instanceof TeamUnresolvedError) {
          return toolResult({
            outcome: 'share_with_required',
            text: error.message,
            isError: true,
          });
        }
        const { outcome, message } = classify(error, provider);
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
