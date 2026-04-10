import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiClient } from '../api-client.js';
function mockFetch(data, status = 200) {
    return vi.fn().mockResolvedValue({
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? 'OK' : 'Error',
        json: () => Promise.resolve(data),
        text: () => Promise.resolve(JSON.stringify(data)),
    });
}
describe('ApiClient', () => {
    let client;
    beforeEach(() => {
        client = new ApiClient({
            baseUrl: 'https://api.rockhopper.co',
            token: 'rh_pat_test123',
        });
    });
    it('sends Authorization header on all requests', async () => {
        const fetchSpy = mockFetch([]);
        vi.stubGlobal('fetch', fetchSpy);
        await client.listEnrolledFiles();
        expect(fetchSpy).toHaveBeenCalledWith('https://api.rockhopper.co/enrolled-files', expect.objectContaining({
            headers: expect.objectContaining({
                Authorization: 'Bearer rh_pat_test123',
            }),
        }));
        vi.unstubAllGlobals();
    });
    it('strips trailing slash from baseUrl', async () => {
        client = new ApiClient({
            baseUrl: 'https://api.rockhopper.co/',
            token: 'test',
        });
        const fetchSpy = mockFetch([]);
        vi.stubGlobal('fetch', fetchSpy);
        await client.listEnrolledFiles();
        expect(fetchSpy).toHaveBeenCalledWith('https://api.rockhopper.co/enrolled-files', expect.anything());
        vi.unstubAllGlobals();
    });
    it('throws on non-OK response', async () => {
        const fetchSpy = mockFetch({ message: 'Not found' }, 404);
        vi.stubGlobal('fetch', fetchSpy);
        await expect(client.getEnrolledFile('abc')).rejects.toThrow('Rockhopper API 404');
        vi.unstubAllGlobals();
    });
    it('appends search param to listEnrolledFiles', async () => {
        const fetchSpy = mockFetch([]);
        vi.stubGlobal('fetch', fetchSpy);
        await client.listEnrolledFiles({ search: 'budget' });
        expect(fetchSpy).toHaveBeenCalledWith('https://api.rockhopper.co/enrolled-files?search=budget', expect.anything());
        vi.unstubAllGlobals();
    });
    it('builds correct URL for getCellHistory', async () => {
        const fetchSpy = mockFetch([]);
        vi.stubGlobal('fetch', fetchSpy);
        await client.getCellHistory('file123', 'Sheet1', 'A1');
        const calledUrl = fetchSpy.mock.calls[0][0];
        expect(calledUrl).toContain('/file-versions/file/file123/cell-history');
        expect(calledUrl).toContain('cell=A1');
        expect(calledUrl).toContain('sheetName=Sheet1');
        vi.unstubAllGlobals();
    });
    it('sends POST with body for createComment', async () => {
        const fetchSpy = mockFetch({ internalId: 1, message: 'test' });
        vi.stubGlobal('fetch', fetchSpy);
        await client.createComment({
            fileMsId: 'file123',
            message: 'Test comment',
        });
        expect(fetchSpy).toHaveBeenCalledWith('https://api.rockhopper.co/file-chat', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({
                fileMsId: 'file123',
                message: 'Test comment',
            }),
        }));
        vi.unstubAllGlobals();
    });
});
//# sourceMappingURL=api-client.test.js.map