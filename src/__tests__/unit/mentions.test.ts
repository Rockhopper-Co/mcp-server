import { describe, expect, it } from 'vitest';
import { renderMentions } from '../../mentions.js';

// ENG-4349 — stored comment bodies carry mention tokens whose payload is raw
// JSON holding an internal user id AND an email address. The encoding is
// defined in `backend/src/helpers/strings.ts:37`; this renderer is the
// mcp-server-side twin of `humanReadableChatMessage` there.
const COLLABORATOR =
  '@{{"id":"u-7","displayName":"Sebastian Perez Lawrence", "email":"sebastian@rockhopper.co"}}';
const VERSION = '#{{"id":"v-3","displayName":"v1.2.0"}}';

const EMAIL_SHAPED = /[\w.+-]+@[\w-]+\.[\w.]+/;

describe('renderMentions (ENG-4349)', () => {
  it('keeps who was asked and drops the id and email', () => {
    const out = renderMentions(`${COLLABORATOR} can you review these changes?`);

    expect(out).toBe('@Sebastian Perez Lawrence can you review these changes?');
    // The absence is the point — a "returned a string" assertion passes
    // against the bug.
    expect(out).not.toMatch(/@\{\{/);
    expect(out).not.toMatch(EMAIL_SHAPED);
    expect(out).not.toContain('u-7');
    expect(out).not.toContain('displayName');
  });

  it('renders a version mention with # and no internal id', () => {
    const out = renderMentions(`Compare against ${VERSION} please`);

    expect(out).toBe('Compare against #v1.2.0 please');
    expect(out).not.toMatch(/#\{\{/);
    expect(out).not.toContain('v-3');
  });

  it('renders every mention in a message, not just the first', () => {
    const out = renderMentions(`${COLLABORATOR} and ${COLLABORATOR} both`);

    expect(out).toBe(
      '@Sebastian Perez Lawrence and @Sebastian Perez Lawrence both',
    );
    expect(out).not.toMatch(EMAIL_SHAPED);
  });

  it('redacts a malformed token instead of failing open to the raw payload', () => {
    // The backend twin wraps the WHOLE replace in one try/catch, so a single
    // malformed token returns the entire message raw — every well-formed
    // mention's email with it. This renderer must fail closed per token.
    const malformed = '@{{"id":"u-9","email":"leak@rockhopper.co"';
    const out = renderMentions(`${malformed}}} and ${COLLABORATOR}`);

    expect(out).not.toMatch(EMAIL_SHAPED);
    expect(out).toContain('Sebastian Perez Lawrence');
  });

  it('leaves a message with no mentions untouched', () => {
    expect(renderMentions('Check A1 against the model')).toBe(
      'Check A1 against the model',
    );
  });

  it('tolerates an empty string', () => {
    expect(renderMentions('')).toBe('');
  });
});
