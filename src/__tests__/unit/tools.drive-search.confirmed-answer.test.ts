import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../api-client.js';
import type { Candidate } from '../../drive-search.js';
import { confirmedAnswer } from '../../tools/drive-search.contract.js';
import type { FileProvider } from '../../types.js';

/**
 * What a confirmed search pick hands back, decided on the provider sealed
 * into the candidate: a Smartsheet sheet id, a Google link, or a Microsoft id
 * pair. Each refusal sits beside the confirmed answer for the same provider.
 */
type Answer = ReturnType<typeof confirmedAnswer>;
const payloadOf = (a: Answer) =>
  JSON.parse(a.content[0].text.split('\n').at(-1) ?? '{}') as Record<
    string,
    unknown
  >;

const errorOf = (a: Answer) => (a as { isError?: boolean }).isError;

const base: Candidate = {
  msId: 'file-1',
  driveMsId: null,
  name: 'Budget',
  parentPath: null,
  lastModifiedAt: null,
  enrollmentState: 'not_enrolled',
};

describe('confirmedAnswer for a Google pick', () => {
  it('positive control: a pick with a link hands back that link for enroll_file', () => {
    const answer = confirmedAnswer({
      ...base,
      provider: 'google',
      webUrl: 'https://docs.google.com/spreadsheets/d/abc/edit',
    });
    expect(errorOf(answer)).toBeUndefined();
    expect(payloadOf(answer)).toEqual({
      outcome: 'confirmed',
      name: 'Budget',
      url: 'https://docs.google.com/spreadsheets/d/abc/edit',
      enrollmentState: 'not_enrolled',
    });
    expect(answer.content[0].text).toContain('call `enroll_file` with the `url`');
  });

  it('a pick with no link asks for the address rather than composing one', () => {
    const answer = confirmedAnswer({ ...base, provider: 'google', webUrl: null });
    expect(errorOf(answer)).toBe(true);
    expect(payloadOf(answer)).toEqual({ outcome: 'unknown_candidate' });
    expect(answer.content[0].text).toContain(
      '"Budget" cannot be added from this search result.',
    );
    expect(answer.content[0].text).toContain('paste the address');
    expect(answer.content[0].text).not.toContain('docs.google.com');
  });
});

describe('confirmedAnswer for the other providers', () => {
  it('a Smartsheet pick hands back the sheet id and no link', () => {
    const answer = confirmedAnswer({
      ...base,
      msId: '4583173393803140',
      provider: 'smartsheet',
    });
    expect(payloadOf(answer)).toEqual({
      outcome: 'confirmed',
      name: 'Budget',
      provider: 'smartsheet',
      msId: '4583173393803140',
      enrollmentState: 'not_enrolled',
    });
  });

  it('a Microsoft pick with no drive id is refused, unlike one with it', () => {
    const refused = confirmedAnswer({ ...base, provider: 'microsoft' });
    expect(errorOf(refused)).toBe(true);
    expect(payloadOf(refused).outcome).toBe('unknown_candidate');
    const confirmed = confirmedAnswer({
      ...base,
      provider: 'microsoft',
      driveMsId: 'drive-1',
    });
    expect(payloadOf(confirmed)).toMatchObject({
      outcome: 'confirmed',
      driveMsId: 'drive-1',
      msId: 'file-1',
    });
  });
});

describe('enrolling a provider this package does not know', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function wired() {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      json: () => Promise.resolve({ enrollmentId: 'e1' }),
      text: () => Promise.resolve('{"enrollmentId":"e1"}'),
    });
    vi.stubGlobal('fetch', fetchSpy);
    const client = new ApiClient({ baseUrl: 'https://api.test', token: 't' });
    return { client, fetchSpy };
  }

  it('positive control: a Smartsheet enroll reaches the backend', async () => {
    const { client, fetchSpy } = wired();
    await client.createEnrolledFile({
      provider: 'smartsheet',
      fileId: '4583173393803140',
      name: 'Q4 Forecast',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('throws by name and sends nothing', async () => {
    const { client, fetchSpy } = wired();
    await expect(
      client.createEnrolledFile({
        provider: 'dropbox' as unknown as FileProvider,
        fileId: 'x',
        name: 'Plan.xlsx',
      }),
    ).rejects.toThrow('Unknown file provider: dropbox');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
