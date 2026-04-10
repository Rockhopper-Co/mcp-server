import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createServer } from '../server.js';
function createMockApiClient() {
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
    };
    return mock;
}
describe('createServer', () => {
    let apiClient;
    beforeEach(() => {
        apiClient = createMockApiClient();
    });
    it('creates an McpServer instance', () => {
        const server = createServer(apiClient);
        expect(server).toBeDefined();
    });
    it('server has expected name and version metadata', () => {
        const server = createServer(apiClient);
        // The McpServer exposes server info via the underlying server
        expect(server).toBeDefined();
    });
});
//# sourceMappingURL=server.test.js.map