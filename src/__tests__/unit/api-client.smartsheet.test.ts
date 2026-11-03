import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../api-client.js';

/**
 * The Smartsheet link and discovery calls on the wire: the route, the verb
 * and the body each one sends. Every other spec in the package mocks the
 * client away, so these are the only checks that the client asks the backend
 * the right question.
 */
function wired(data: unknown = {}) {
  const fetchSpy = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  });
  vi.stubGlobal('fetch', fetchSpy);
  const client = new ApiClient({
    baseUrl: 'https://api.test',
    token: 'rh_pat_test',
  });
  const url = (n = 0) => String(fetchSpy.mock.calls[n][0]);
  const init = (n = 0) =>
    fetchSpy.mock.calls[n][1] as { method?: string; body?: string };
  return { client, url, init, fetchSpy };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Smartsheet link calls', () => {
  it('begins a connect with a POST that sends the region and nothing else', async () => {
    const handoff = {
      authorizeUrl: 'https://app.smartsheet.com/b/authorize?client_id=x',
      expiresAt: '2026-11-03T21:00:00.000Z',
    };
    const { client, url, init } = wired(handoff);
    const answer = await client.beginSmartsheetConnect();
    expect(answer).toEqual(handoff);
    expect(url()).toBe('https://api.test/auth/smartsheet/connect');
    expect(init().method).toBe('POST');
    expect(JSON.parse(init().body ?? '{}')).toEqual({ region: 'us' });
  });

  it('reads the link status with a GET on the link route', async () => {
    const status = { linked: true, links: [{ region: 'us' }] };
    const { client, url, init } = wired(status);
    const answer = await client.getSmartsheetLink();
    expect(answer).toEqual(status);
    expect(url()).toBe('https://api.test/auth/smartsheet/link');
    expect(init().method ?? 'GET').toBe('GET');
  });

  it('unlinks with a DELETE that names the region', async () => {
    const { client, url, init } = wired({ linked: false, removed: true });
    const answer = await client.unlinkSmartsheet();
    expect(answer).toEqual({ linked: false, removed: true });
    expect(url()).toBe('https://api.test/auth/smartsheet/link?region=us');
    expect(init().method).toBe('DELETE');
  });
});

describe('Smartsheet discovery calls', () => {
  it('browses the home level with no query string', async () => {
    const listing = {
      parent: { parentType: 'home', parentId: null },
      items: [],
    };
    const { client, url } = wired(listing);
    const answer = await client.browseSmartsheet();
    expect(answer).toEqual(listing);
    expect(url()).toBe('https://api.test/smartsheet-drive/browse');
  });

  it('opens a folder by sending both parent fields', async () => {
    const { client, url } = wired({ items: [] });
    await client.browseSmartsheet({ parentType: 'folder', parentId: '991' });
    expect(url()).toBe(
      'https://api.test/smartsheet-drive/browse?parentType=folder&parentId=991',
    );
  });

  it('sends only the parent field it was given', async () => {
    const { client, url } = wired({ items: [] });
    await client.browseSmartsheet({ parentType: 'workspace' });
    expect(url()).toBe(
      'https://api.test/smartsheet-drive/browse?parentType=workspace',
    );
  });

  it('searches with the query encoded', async () => {
    const listing = { query: 'q4 & plan', totalCount: 0, items: [] };
    const { client, url, init } = wired(listing);
    const answer = await client.searchSmartsheet('q4 & plan');
    expect(answer).toEqual(listing);
    expect(url()).toBe(
      'https://api.test/smartsheet-drive/search?q=q4+%26+plan',
    );
    expect(init().method ?? 'GET').toBe('GET');
  });

  it('enrolls a sheet by its id as platformId under the Smartsheet account type', async () => {
    const { client, url, init } = wired({ enrollmentId: 'e1' });
    await client.createEnrolledFile({
      provider: 'smartsheet',
      fileId: '4583173393803140',
      name: 'Q4 Forecast',
    });
    expect(url()).toBe('https://api.test/enrolled-files');
    expect(JSON.parse(init().body ?? '{}')).toEqual({
      platformId: '4583173393803140',
      name: 'Q4 Forecast',
      accountType: 'smartsheet',
    });
  });

  it('positive control: a Microsoft enroll still sends the id pair', async () => {
    const { client, init } = wired({ enrollmentId: 'e2' });
    await client.createEnrolledFile({
      provider: 'microsoft',
      fileId: 'm',
      driveMsId: 'd',
      name: 'B.xlsx',
    });
    expect(JSON.parse(init().body ?? '{}')).toEqual({
      msId: 'm',
      driveMsId: 'd',
      name: 'B.xlsx',
      accountType: 'microsoft',
    });
  });
});
