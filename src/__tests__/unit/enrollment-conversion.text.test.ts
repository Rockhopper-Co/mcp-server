import { describe, expect, it } from 'vitest';
import {
  conversionDetail,
  conversionFieldsOf,
  serverConversionOf,
} from '../../enrollment-conversion.js';
import { conversionSentence } from '../../enrollment-conversion.text.js';

/**
 * ENG-9660 (plan 121 SP31) — every conversion state names its next step, or
 * says there is none, and a reason this release has never heard of is still
 * said rather than dropped.
 *
 * Planted changes that red these: a `WAITING_FOR` entry removed (the remedy
 * test loses `connect_google`); `said` ignoring the reason it was given
 * for an unknown one (the unknown-reason test loses the reason); `conversionFieldsOf`
 * reading `info.conversion` without the `?? null` (the old-backend test gets
 * `undefined`); the pending sentence ignoring `callerHasFile` (one of the two
 * pending tests names the wrong tool); the converted sentence ignoring
 * `namedId` (the own-id test gets a sentence).
 */
const HELD = { namedId: 'orig-1', callerHasFile: true };
const NOT_HELD = { namedId: 'orig-1', callerHasFile: false };

describe('conversionSentence', () => {
  it.each([
    ['no_write_grant', 'full Drive access'],
    ['no_member_can_add_to_folder', 'add files to that folder'],
    ['no_owner_domain_member', 'from that organisation'],
  ])('waiting for %s names who must run connect_google', (reason, remedy) => {
    const text = conversionSentence(
      { conversion: { state: 'waiting_for_member', reason }, convertedFile: null },
      NOT_HELD,
    );
    expect(text).toContain('`connect_google`');
    expect(text).toContain(remedy);
  });

  it('says a reason it has never heard of, verbatim', () => {
    expect(
      conversionSentence(
        { conversion: { state: 'refused', reason: 'label_not_carried' }, convertedFile: null },
        NOT_HELD,
      ),
    ).toContain('"label_not_carried"');
  });

  const CONVERTED = {
    platformId: 'gsheet-3',
    fileType: 'gsheet_native',
    name: 'Budget',
    editorUrl: null,
  };

  it('names the converted file and its id when it is served', () => {
    const text = conversionSentence(
      { conversion: { state: 'converted' }, convertedFile: CONVERTED },
      HELD,
    );
    expect(text).toContain('a Google Sheet, "Budget" (id gsheet-3)');
  });

  it("says nothing about an Office file for the converted file's own id", () => {
    expect(
      conversionSentence(
        { conversion: { state: 'converted' }, convertedFile: CONVERTED },
        { namedId: 'gsheet-3', callerHasFile: true },
      ),
    ).toBe('');
  });

  it('pending, for a user who holds the file: check with search_files', () => {
    const text = conversionSentence(
      { conversion: { state: 'pending' }, convertedFile: null },
      HELD,
    );
    expect(text).toContain('`search_files`');
    expect(text).not.toContain('`enroll_file`');
  });

  it('pending, for a user who does not: enroll again once it finishes', () => {
    const text = conversionSentence(
      { conversion: { state: 'pending' }, convertedFile: null },
      NOT_HELD,
    );
    expect(text).toContain('call `enroll_file` again');
    expect(text).not.toContain('`search_files`');
  });

  it('positive control: no conversion, no sentence and no detail', () => {
    expect(
      conversionSentence({ conversion: null, convertedFile: null }, HELD),
    ).toBe('');
    expect(conversionDetail({ conversion: null, convertedFile: null })).toEqual({});
  });
});

describe('conversionFieldsOf', () => {
  it('reads a backend from before the conversion as no conversion', () => {
    expect(
      conversionFieldsOf({
        isEnrolled: true,
        enrollmentState: 'enrolled',
        isInUserWorkspace: true,
      }),
    ).toEqual({ conversion: null, convertedFile: null });
    expect(conversionFieldsOf(undefined)).toEqual({
      conversion: null,
      convertedFile: null,
    });
  });
});

describe('serverConversionOf', () => {
  it("reads the door's conversion off a per-file outcome", () => {
    expect(
      serverConversionOf({
        platformId: 'orig-1',
        outcome: 'enrolled',
        conversion: { state: 'refused', reason: 'encrypted' },
      } as never),
    ).toEqual({ state: 'refused', reason: 'encrypted' });
  });

  it('tells "the door said nothing" (undefined) from "no conversion" (null)', () => {
    expect(
      serverConversionOf({ msId: 'm', platformId: 'p', outcome: 'enrolled' }),
    ).toBeUndefined();
    expect(serverConversionOf(null)).toBeUndefined();
    expect(
      serverConversionOf({
        msId: 'm',
        platformId: 'p',
        outcome: 'enrolled',
        conversion: null,
      } as never),
    ).toBeNull();
  });
});
