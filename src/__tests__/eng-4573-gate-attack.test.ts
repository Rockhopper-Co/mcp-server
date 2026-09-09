import { describe, expect, it } from 'vitest';

// ENG-4573 — deliberately failing spec, planted to prove the fifth CI gate
// (feature -> epic/** pull requests) actually reds. Removed in the next
// commit on this same branch once the red run is observed.
describe('ENG-4573 gate attack', () => {
  it('is a deliberate failure used only to attack the new CI gate', () => {
    expect(true).toBe(false);
  });
});
