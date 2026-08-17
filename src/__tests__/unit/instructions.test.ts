import { describe, expect, it } from 'vitest';
import { buildInstructions } from '../../instructions.js';
import { PAT_CAPABILITIES } from '../../capabilities.js';

/**
 * ENG-2212 built this prose so a narrowed token stops advertising tools it
 * cannot call. ENG-2597 found the narrowed branch had no test at all: every
 * existing caller passed either zero capabilities or all four, so the
 * `withheld` sentence — the entire reason the file was rewritten — was never
 * built. The `.map` that names the withheld families was one of four
 * uncovered functions in the package.
 */
describe('buildInstructions', () => {
  it('tells a read-only token that writes are unavailable', () => {
    const text = buildInstructions([]);
    expect(text).toContain('read-only');
    expect(text).not.toContain('may write');
  });

  it('names the withheld families for a single-family token', () => {
    const text = buildInstructions(['comments:write']);
    expect(text).toContain('This token may write comments');
    expect(text).toContain(
      'it was not granted reviews, versions and files',
    );
  });

  it('names both sides for a two-family token', () => {
    const text = buildInstructions(['comments:write', 'files:write']);
    expect(text).toContain('This token may write comments and files');
    expect(text).toContain('it was not granted reviews and versions');
  });

  it('omits the withheld sentence when every family is granted', () => {
    const text = buildInstructions(PAT_CAPABILITIES);
    expect(text).toContain('This token may write');
    expect(text).not.toContain('was not granted');
  });

  /**
   * The point of the sentence is that it must not advertise a tool the token
   * cannot call. Assert on the tool name rather than the family word, because
   * that is the failure the customer saw: a method-not-found mid-task.
   */
  it('does not advertise a withheld family tool', () => {
    const text = buildInstructions(['comments:write']);
    expect(text).toContain('add_comment');
    expect(text).not.toContain('discard_changes');
  });
});
