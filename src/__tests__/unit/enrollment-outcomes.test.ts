import { describe, expect, it } from 'vitest';
import { describeServerOutcome } from '../../enrollment-outcomes.js';
import type { ServerEnrollmentOutcome } from '../../types.js';

/**
 * ENG-9660 (plan 121 SP31) — `ServerEnrollmentOutcome` is a hand-kept mirror,
 * so a backend newer than this package CAN send a word it has never heard of
 * (plan 121 D8's door answers were one candidate). The `never` arm keeps the
 * compile-time check; at run time it used to `return exhaustive`, the bare
 * string, so `const { outcome, text } =` at the call site read two
 * `undefined`s and the model was handed an answer with no text.
 *
 * Planted change that reds this: restore `return exhaustive` in the default
 * arm (the text is `undefined`).
 */
describe('describeServerOutcome with a word this release has never heard of', () => {
  it('still answers, and says the word verbatim', () => {
    const answer = describeServerOutcome(
      'conversion_pending' as unknown as ServerEnrollmentOutcome,
      'Board Memo.docx',
      ' — visible to you only',
    );

    expect(answer.outcome).toBe('enrolled');
    expect(typeof answer.text).toBe('string');
    expect(answer.text).toContain('"conversion_pending"');
    expect(answer.text).toContain('"Board Memo.docx"');
    expect(answer.text).toContain('`search_files`');
  });

  it('positive control: a known word answers exactly as before', () => {
    const answer = describeServerOutcome('already_enrolled', 'Plan.xlsx', '');

    expect(answer.outcome).toBe('already_enrolled');
    expect(answer.text).toContain('"Plan.xlsx" was already in Rockhopper');
    expect(answer.text).not.toContain('answered "');
  });
});
