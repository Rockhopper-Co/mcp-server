import { vi } from 'vitest';

export function createMockApiClient() {
  return {
    getMe: vi.fn().mockResolvedValue({ internalId: 1, email: 'user@test.com' }),
    getTeam: vi.fn().mockResolvedValue({ internalId: 2, name: 'Finance' }),
    // ENG-2198 — the delegated Microsoft Graph link.
    beginMicrosoftConnect: vi.fn().mockResolvedValue({
      authorizeUrl:
        'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?client_id=real-client',
      expiresAt: '2026-08-14T21:00:00.000Z',
    }),
    getMicrosoftLink: vi.fn().mockResolvedValue({
      linked: false,
      msAccountLabel: null,
      msTenantId: null,
      grantedScopes: [],
      linkedAt: null,
      lastUsedAt: null,
    }),
    unlinkMicrosoft: vi.fn().mockResolvedValue({ linked: false, removed: true }),
    listEnrolledFiles: vi.fn().mockResolvedValue([
      {
        internalId: 11,
        platformId: 'file-1',
        fileType: 'microsoft_xlsx',
        driveMsId: 'drive-1',
        name: 'Budget.xlsx',
        hasUncommittedChanges: true,
      },
      {
        internalId: 12,
        platformId: 'file-2',
        fileType: 'microsoft_xlsx',
        driveMsId: 'drive-2',
        name: 'Forecast.xlsx',
        hasUncommittedChanges: false,
      },
    ]),
    getEnrolledFile: vi.fn().mockResolvedValue({
      internalId: 11,
      platformId: 'file-1',
      fileType: 'microsoft_xlsx',
      driveMsId: 'drive-1',
      name: 'Budget.xlsx',
      hasUncommittedChanges: true,
    }),
    getFileVersions: vi.fn().mockResolvedValue([
      {
        internalId: 101,
        majorVersion: 1,
        minorVersion: 0,
        patchVersion: 0,
        description: 'Initial',
        createdAt: '2026-01-01T00:00:00Z',
        wasDiscarded: false,
        wasReverted: false,
        byUserPlatformId: 'ms-user-1',
        byUserPlatformType: 'microsoft',
      },
    ]),
    getFileVersion: vi.fn().mockResolvedValue({
      internalId: 101,
      majorVersion: 1,
      minorVersion: 0,
      patchVersion: 0,
      description: 'Initial',
      createdAt: '2026-01-01T00:00:00Z',
      wasDiscarded: false,
      wasReverted: false,
      byUserPlatformId: 'ms-user-1',
      byUserPlatformType: 'microsoft',
    }),
    // Plan 02 ruling 5 — the completeness probe every change-history surface
    // consults. Default: complete, so existing specs keep asserting the serve
    // path; the strict-no-partial specs override it to a pending fold.
    getFoldStatus: vi.fn().mockResolvedValue({
      fileMsId: 'file-1',
      foldPending: false,
      foldTargetVersionId: null,
      checkedAt: '2026-08-04T00:00:00.000Z',
    }),
    getCellHistory: vi.fn().mockResolvedValue([
      {
        versionId: 101,
        value: 42,
        changedBy: 'ms-user-1',
        changedAt: '2026-01-01T00:00:00Z',
      },
    ]),
    getFileComments: vi.fn().mockResolvedValue([
      {
        internalId: 201,
        message: 'Looks good',
        source: 'rockhopper',
        cellReference: 'Sheet1!A1',
        resolved: false,
        authorName: 'Alice',
        authorEmail: 'alice@test.com',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        editedOn: null,
        replies: [],
      },
    ]),
    getComment: vi.fn(),
    createComment: vi.fn().mockResolvedValue({
      internalId: 301,
      message: 'New comment',
      cellReference: 'Sheet1!A1',
    }),
    replyToComment: vi.fn().mockResolvedValue({
      internalId: 302,
      message: 'Reply',
    }),
    resolveComment: vi.fn().mockResolvedValue({ internalId: 201 }),
    getReviewsForVersion: vi.fn().mockResolvedValue([
      {
        id: 401,
        subject: 'Review Q1',
        description: 'Please review',
        status: 'PENDING',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        requester: { firstName: 'Alice', lastName: 'Smith' },
      },
    ]),
    getReviewsForLatestVersion: vi.fn().mockResolvedValue([]),
    getReview: vi.fn().mockResolvedValue({ id: 401, subject: 'Review Q1', status: 'PENDING' }),
    getReviewActivities: vi.fn(),
    createReviewRequest: vi.fn().mockResolvedValue({
      id: 402,
      subject: 'New review',
      status: 'PENDING',
    }),
    approveReview: vi.fn().mockResolvedValue({ id: 402 }),
    getUnattributedChangesBySheet: vi.fn().mockResolvedValue([
      {
        id: 501,
        changeType: 'update',
        sheetName: 'Sheet1',
        cellAddress: 'A1',
        oldValue: 1,
        newValue: 2,
        byUserPlatformId: 'ms-user-1',
        byUserPlatformType: 'microsoft',
        processingStatus: 'pending',
        attributionDate: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]),
    getUnattributedChangesPaginated: vi.fn().mockResolvedValue({
      changes: [
        {
          id: 501,
          changeType: 'update',
          sheetName: 'Sheet1',
          cellAddress: 'A1',
          oldValue: 1,
          newValue: 2,
          byUserPlatformId: 'ms-user-1',
          byUserPlatformType: 'microsoft',
          processingStatus: 'pending',
          attributionDate: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      nextCursor: null,
      totalCount: 1,
      snapshotId: '1700000000000',
      snapshotCreatedAt: '2023-11-14T22:13:20.000Z',
    }),
    updateEnrolledFile: vi.fn().mockResolvedValue({
      platformId: 'file-1',
      name: 'Renamed.xlsx',
    }),
    createVersion: vi.fn().mockResolvedValue({
      internalId: 102,
      majorVersion: 1,
      minorVersion: 1,
      patchVersion: 0,
      description: 'New version',
      createdAt: '2026-01-02T00:00:00Z',
      wasDiscarded: false,
      wasReverted: false,
    }),
    discardChanges: vi.fn().mockResolvedValue({
      internalId: 103,
      majorVersion: 0,
      minorVersion: 0,
      patchVersion: 0,
      description: 'Discarded',
      wasDiscarded: true,
    }),
    cancelReview: vi.fn().mockResolvedValue({
      id: 401,
      subject: 'Review Q1',
      status: 'CANCELLED',
    }),
  };
}

export function createMockMcpServer() {
  return {
    registerTool: vi.fn(),
    registerResource: vi.fn(),
    registerPrompt: vi.fn(),
  };
}
