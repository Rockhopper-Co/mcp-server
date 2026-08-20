import { vi } from 'vitest';

export function createMockApiClient() {
  return {
    getMe: vi.fn().mockResolvedValue({
      internalId: 1,
      email: 'user@test.com',
      msId: 'ms-user-1',
      // `/users/me` serves these because both relations are `eager: true` on
      // the backend entities — nothing has to ask for them.
      teamMembers: [{ team: { id: 'team-uuid-1', internalId: 2, name: 'Finance' } }],
    }),
    getTeam: vi.fn().mockResolvedValue({
      internalId: 2,
      name: 'Finance',
      teamMembers: [
        { user: { msId: 'ms-user-1', email: 'user@test.com' } },
        { user: { msId: 'ms-user-2', email: 'colleague@test.com' } },
      ],
    }),
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
    // ENG-2204 — drive discovery. Two hits whose names both match, because a
    // single hit lets a wrong flow look right: the failure being fixed picked
    // one match and reported it as fact.
    // ENG-2785 — the stored inventory behind `list_unenrolled_files`. Default
    // is one un-enrolled row with a SUCCEEDED refresh behind it, because the
    // interesting cases are the empty ones and each test states its own.
    listDriveInventory: vi.fn().mockResolvedValue({
      items: [
        {
          msId: 'ms-item-11',
          driveMsId: 'drive-9',
          name: 'Unenrolled_Model.xlsx',
          webUrl: 'https://contoso.sharepoint.com/c.xlsx',
          parentPath: '/Finance/Models',
          lastModifiedAt: '2026-08-18T10:00:00Z',
          size: 80_000,
          enrollmentState: 'not_enrolled',
          entitlementObservedAt: '2026-08-19T20:00:00.000Z',
        },
      ],
      freshness: {
        asOf: '2026-08-19T21:00:00.000Z',
        stale: false,
        refreshing: false,
        lastFailureAt: null,
        lastFailureReason: null,
        consecutiveFailures: 0,
      },
      // ENG-2814 — the default is a FINISHED list. Present rather than omitted
      // so the mock matches the wire shape: an absent `nextCursor` is falsy and
      // reads as "no more pages", which is the right answer for the wrong
      // reason, and it would keep reading right after the field was renamed.
      nextCursor: null,
      snapshotId: '1755641000000',
      snapshotCreatedAt: '2026-08-19T21:23:20.000Z',
    }),
    searchDriveFiles: vi.fn().mockResolvedValue({
      scope: 'search',
      items: [
        {
          msId: 'ms-item-9',
          driveMsId: 'drive-9',
          name: 'Becklar_RMR_Model.xlsx',
          webUrl: 'https://contoso.sharepoint.com/a.xlsx',
          lastModifiedAt: '2026-08-01T10:00:00Z',
          size: 120_000,
          parentPath: '/Finance/Models',
          enrollmentState: 'not_enrolled',
        },
        {
          msId: 'ms-item-10',
          driveMsId: 'drive-9',
          name: 'Becklar_RMR_Model_OLD.xlsx',
          webUrl: 'https://contoso.sharepoint.com/b.xlsx',
          lastModifiedAt: '2025-02-01T10:00:00Z',
          size: 90_000,
          parentPath: '/Finance/Archive',
          enrollmentState: 'enrolled',
        },
      ],
    }),
    // ENG-2200 — enrollment. Defaults describe the ordinary case: a Microsoft
    // link that resolves to a file Rockhopper has never seen, and a caller on
    // a two-person team. Each spec overrides the one field it is about.
    resolveEnrollmentUrl: vi.fn().mockResolvedValue({
      msId: 'ms-item-9',
      driveMsId: 'drive-9',
      name: 'Becklar_RMR_Model.xlsx',
      listItemUniqueId: 'liuid-9',
      webUrl: 'https://contoso.sharepoint.com/:x:/r/sites/finance/Doc.aspx',
      enrollmentState: 'not_enrolled',
    }),
    getEnrollmentInfo: vi.fn().mockResolvedValue([
      {
        isEnrolled: false,
        enrollmentState: 'not_enrolled',
        isInUserWorkspace: false,
      },
    ]),
    createEnrolledFile: vi
      .fn()
      .mockResolvedValue({ enrollmentId: 'enr-1', status: 'queued' }),
    enrollFileSharedWith: vi
      .fn()
      .mockResolvedValue({ enrollmentId: 'enr-2', status: 'queued' }),
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
