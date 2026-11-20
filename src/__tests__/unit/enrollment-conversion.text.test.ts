import { describe, expect, it } from 'vitest';
import {
  conversionDetail,
  conversionFieldsOf,
  conversionSentence,
} from '../../enrollment-conversion.js';

/**
 * ENG-9660 (plan 121 SP31) — every conversion state names its next step, or
 * says there is none, and a reason this release has never heard of is still
 * said rather than dropped.
 *
 * Planted changes that red these: a `WAITING_FOR` entry removed (the remedy
 * test loses `connect_google`); `said` ignoring the reason it was given
 * for an unknown one (the unknown-reason test loses the reason); `conversionFieldsOf`
 * reading `info.conversion` without the `?? null` (the old-backend test gets
 * `undefined`).
 */
describe('conversionSentence', () => {
  it.each([
    ['no_write_grant', 'full Drive access'],
    ['no_member_can_add_to_folder', 'add files to that folder'],
    ['no_owner_domain_member', 'from that organisation'],
  ])('waiting for %s names who must run connect_google', (reason, remedy) => {
    const text = conversionSentence({
      conversion: { state: 'waiting_for_member', reason },
      convertedFile: null,
    });
    expect(text).toContain('`connect_google`');
    expect(text).toContain(remedy);
  });

  it('says a reason it has never heard of, verbatim', () => {
    expect(
      conversionSentence({
        conversion: { state: 'refused', reason: 'label_not_carried' },
        convertedFile: null,
      }),
    ).toContain('"label_not_carried"');
  });

  it('names the converted file and its id when it is served', () => {
    const text = conversionSentence({
      conversion: { state: 'converted' },
      convertedFile: {
        platformId: 'gsheet-3',
        fileType: 'gsheet_native',
        name: 'Budget',
        editorUrl: null,
      },
    });
    expect(text).toContain('a Google Sheet, "Budget" (id gsheet-3)');
  });

  it('positive control: no conversion, no sentence and no detail', () => {
    expect(conversionSentence({ conversion: null, convertedFile: null })).toBe('');
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
