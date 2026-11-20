import { describeServerOutcome } from '../enrollment.js';
import {
  conversionDetail,
  outcomeAfterWrite,
  serverConversionOf,
} from '../enrollment-conversion.js';
import {
  conversionSentence,
  ID_CHANGES_NOTE,
} from '../enrollment-conversion.text.js';
import type { QueuedEnrollmentFile } from '../types.js';
import type { EnrollAnswer } from './enroll-file.contract.js';
import {
  answerId,
  answerName,
  heldAnswer,
  idChangesOnConversion,
  type Target,
} from './enroll-file.target.js';

/**
 * ENG-9660 — what `enroll_file` answers once its write ran. Split out of
 * `enroll-file.ts` so neither file crosses 300 lines.
 *
 * ENG-2536: the SERVER's verdict wins over the one inferred from the lookup
 * taken before the write. The two can disagree, and when they do the server is
 * right: the lookup happened earlier, so a file somebody else added in between
 * reads `not_enrolled` here and would otherwise be reported as a fresh add.
 * The fallback is what shipped before, for a backend older than the field.
 *
 * ENG-9660: the door's conversion answer wins the same way (plan 121 D8), so a
 * conversion another member claimed after our lookup is said as one: two
 * members enroll the same Drive `.docx` milliseconds apart, B's lookup sees no
 * link row, B writes, and the door answers A's pending claim.
 */
export function answerAfterWrite(input: {
  target: Target;
  serverFile: QueuedEnrollmentFile | null;
  restoring: boolean;
  /** How the answer says who can see it (ENG-4279). */
  who: string;
  /** The write's own fields: enrollment id, sharing counts. */
  shared: Record<string, unknown>;
}): EnrollAnswer {
  const { target, serverFile, restoring, who, shared } = input;
  const door = serverConversionOf(serverFile);
  const fields =
    door === undefined
      ? target
      : { conversion: door, convertedFile: target.convertedFile };
  const id = answerId(target, { msId: serverFile?.msId, conversion: door });
  const name = answerName(target);
  const context = { namedId: target.fileId, callerHasFile: true };

  const held = outcomeAfterWrite(serverFile?.outcome, door);
  if (held) {
    return heldAnswer(held, fields, {
      ...context,
      // Refused: the door created nothing, so nobody holds it.
      callerHasFile: held === 'conversion_pending',
      lead:
        held === 'conversion_pending'
          ? `"${name || 'That file'}" was sent to Rockhopper${who}.`
          : `"${name || 'That file'}" was not added.`,
      detail: { fileMsId: id, name: name || null, ...shared },
    });
  }

  const { outcome, text } = describeServerOutcome(
    serverFile?.outcome ?? (restoring ? 'restored' : 'enrolled'),
    name,
    who,
  );
  const changes = idChangesOnConversion(target, fields.conversion, id);
  return {
    outcome,
    text: [text, conversionSentence(fields, context), changes ? ID_CHANGES_NOTE : '']
      .filter(Boolean)
      .join(' '),
    detail: {
      // ENG-9660 — one id per file: the one `list_files` shows (`answerId`).
      fileMsId: id,
      name: name || null,
      ...conversionDetail(fields),
      ...(changes ? { idChangesOnConversion: true } : {}),
      ...shared,
    },
  };
}
