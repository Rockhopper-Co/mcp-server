import { describe, expect, it } from 'vitest';
import { remediationFor } from '../../../auth/remediation.js';

/**
 * ENG-4222 — a device-grant user whose token died mid-session was told to
 * "Create a new Personal Access Token in Rockhopper Settings". They never made
 * one: they signed in through a browser. The instruction sent them to mint a
 * credential they do not need instead of restarting to re-approve.
 *
 * These are PURE tests on purpose. The same assertions written against the CLI
 * entry need `vi.doMock` plus a repeated `await import('../../cli.js')`, and
 * that harness is order-sensitive — measured: with two neighbouring tests
 * timing out under machine load, which of these assertions failed changed
 * between runs. A string chosen from an enum should not be able to flake.
 */
describe('remediationFor', () => {
  // The load-bearing one. A device-grant user holds no Personal Access Token,
  // so naming one is the defect regardless of how the rest of the sentence
  // reads.
  it.each(['device-grant', 'stored-oauth'] as const)(
    'never points a %s user at a Personal Access Token',
    (source) => {
      const message = remediationFor(source);
      expect(message).not.toContain('Personal Access Token');
      expect(message).toMatch(/restart/i);
    },
  );

  // The PAT copy was CORRECT before this ticket and must survive. Without this,
  // making every message generic satisfies the assertions above — the exact
  // change the ticket predicts would slip past a negative-only guard.
  it('still tells a PAT user to mint a new token', () => {
    const message = remediationFor('pat');
    expect(message).toContain('Personal Access Token');
    expect(message).toContain('Rockhopper Settings');
  });

  // Two sources share the non-PAT arm; a regression that special-cased only
  // `device-grant` would leave a stored-oauth user with the wrong instruction.
  it('gives stored-oauth and device-grant the same instruction', () => {
    expect(remediationFor('stored-oauth')).toBe(remediationFor('device-grant'));
    expect(remediationFor('pat')).not.toBe(remediationFor('device-grant'));
  });
});
