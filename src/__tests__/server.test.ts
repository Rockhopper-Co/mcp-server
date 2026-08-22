import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServer } from '../server.js';
import { ApiClient } from '../api-client.js';

/**
 * The version this file asserts is read from package.json HERE, and the value
 * it is compared against is produced by the real `logger.ts` at import time —
 * two independent readers, so the assertion is not the implementation restated.
 */
const packageVersion = (
  JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
).version;

/**
 * `McpServer` keeps its declared identity on the underlying `Server` it wraps
 * and exposes no getter for it, so the assertion below reaches through. The
 * alternative — a full `initialize` handshake — is what the e2e suites do; the
 * point of doing it here is that this is the ONLY place the REAL logger's
 * `serviceVersion` is checked against package.json. `server.wiring.test.ts`
 * mocks both the SDK constructor and nothing else, so it proves `createServer`
 * forwards a version, never that the version is the package's.
 */
interface ServerWithInfo {
  server: { _serverInfo: { name: string; version: string } };
}

function createMockApiClient(): ApiClient {
  const mock = {
    listEnrolledFiles: vi.fn().mockResolvedValue([
      {
        internalId: 1,
        platformId: 'file-abc',
        fileType: 'microsoft',
        driveMsId: 'drive1',
        name: 'Budget Q1.xlsx',
        hasUncommittedChanges: false,
      },
    ]),
    getEnrolledFile: vi.fn().mockResolvedValue({
      internalId: 1,
      platformId: 'file-abc',
      fileType: 'microsoft',
      driveMsId: 'drive1',
      name: 'Budget Q1.xlsx',
      hasUncommittedChanges: false,
    }),
    getFileVersions: vi.fn().mockResolvedValue([
      {
        internalId: 10,
        majorVersion: 1,
        minorVersion: 0,
        patchVersion: 0,
        description: 'Initial version',
        createdAt: '2025-01-01T00:00:00Z',
        wasDiscarded: false,
        wasReverted: false,
        byUserPlatformId: 'user1',
        byUserPlatformType: 'microsoft',
      },
    ]),
    getFileVersion: vi.fn().mockResolvedValue({
      internalId: 10,
      majorVersion: 1,
      minorVersion: 0,
      patchVersion: 0,
    }),
    getFileComments: vi.fn().mockResolvedValue([]),
    getReviewsForVersion: vi.fn().mockResolvedValue([]),
    getReviewsForLatestVersion: vi.fn().mockResolvedValue([]),
    getTeam: vi.fn().mockResolvedValue({ internalId: 1, name: 'Finance' }),
    getUnattributedChanges: vi.fn().mockResolvedValue([]),
    getCellHistory: vi.fn().mockResolvedValue([]),
    getMe: vi.fn().mockResolvedValue({ internalId: 1, email: 'test@test.com' }),
    // ENG-2816 — `search_drive_files` derives its confirmation-signing key at
    // registration, so every stub that reaches `createServer` needs one.
    deriveStateKey: (domain: string) =>
      createHmac('sha256', 'test-pat-for-state-signing').update(domain).digest(),
  } as unknown as ApiClient;

  return mock;
}

describe('createServer', () => {
  let apiClient: ApiClient;

  beforeEach(() => {
    apiClient = createMockApiClient();
  });

  it('creates a connectable McpServer, not just a truthy object', () => {
    const server = createServer(apiClient);
    expect(typeof server.connect).toBe('function');
    expect(typeof server.registerTool).toBe('function');
  });

  // ENG-1955 — the declared version is the only handle a client has on which
  // build it is talking to; it comes back in `initialize`. It was a literal
  // once, so 0.2.0 through 0.8.0 all announced 0.1.0.
  it('declares the package name and the package.json version', () => {
    const info = (createServer(apiClient) as unknown as ServerWithInfo).server
      ._serverInfo;
    expect(info.name).toBe('rockhopper');
    expect(info.version).toBe(packageVersion);
    // The literal it was before ENG-1955: 0.2.0 through 0.8.0 all announced it.
    expect(info.version).not.toBe('0.1.0');
  });
});
