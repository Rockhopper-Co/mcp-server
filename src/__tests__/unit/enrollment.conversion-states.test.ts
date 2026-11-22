import { describe, expect, it } from 'vitest';
import { outcomeForState } from '../../enrollment.js';

/**
 * ENG-9660 (plan 121 SP31) — `outcomeForState` reads the conversion state of an
 * Office file in Google Drive, each state by name.
 *
 * Planted changes that red these, one per test:
 * - drop the `pending` arm (fall through to today's rule): the pending test
 *   answers `null` and a write runs for a file the backend answers pending.
 * - drop the `refused` arm: the refused test answers `null`.
 * - drop the `state === 'not_enrolled'` gate on either arm: the "tracked file
 *   stays tracked" test answers the conversion instead of `already_enrolled`.
 * - make `waiting_for_member` answer without a write: its test reds, and the
 *   backend is never asked to try the conversion again (plan 121 D8).
 */
describe('outcomeForState with no conversion (positive control: today unchanged)', () => {
  it('answers enrolled, hidden and not_enrolled exactly as before', () => {
    expect(outcomeForState('enrolled')).toBe('already_enrolled');
    expect(outcomeForState('hidden')).toBe('restore_confirmation_required');
    expect(outcomeForState('not_enrolled')).toBeNull();
    expect(outcomeForState('enrolled', null)).toBe('already_enrolled');
    expect(outcomeForState('hidden', null)).toBe(
      'restore_confirmation_required',
    );
  });
});

describe('outcomeForState, each conversion state by name', () => {
  it('pending, nothing tracked yet: answers conversion_pending, no write', () => {
    expect(outcomeForState('not_enrolled', { state: 'pending' })).toBe(
      'conversion_pending',
    );
  });

  it('refused, nothing tracked: answers conversion_refused, no write', () => {
    expect(
      outcomeForState('not_enrolled', {
        state: 'refused',
        reason: 'over_size_limit',
      }),
    ).toBe('conversion_refused');
  });

  it('waiting_for_member: the write runs, because enrolling again resumes it', () => {
    expect(
      outcomeForState('not_enrolled', {
        state: 'waiting_for_member',
        reason: 'no_write_grant',
      }),
    ).toBeNull();
  });

  it('converted: the converted record decides, by today\'s rule', () => {
    expect(outcomeForState('enrolled', { state: 'converted' })).toBe(
      'already_enrolled',
    );
    expect(outcomeForState('hidden', { state: 'converted' })).toBe(
      'restore_confirmation_required',
    );
    // Not in the caller's organization yet: the door resolves the original to
    // the converted record (D8), so the write runs.
    expect(outcomeForState('not_enrolled', { state: 'converted' })).toBeNull();
  });

  it('kept_as_office: the kept Office record decides, by today\'s rule', () => {
    expect(outcomeForState('enrolled', { state: 'kept_as_office' })).toBe(
      'already_enrolled',
    );
    expect(
      outcomeForState('not_enrolled', { state: 'kept_as_office' }),
    ).toBeNull();
  });

  it('a tracked file stays tracked while its conversion is pending or refused', () => {
    expect(outcomeForState('enrolled', { state: 'pending' })).toBe(
      'already_enrolled',
    );
    expect(outcomeForState('hidden', { state: 'refused' })).toBe(
      'restore_confirmation_required',
    );
  });
});
