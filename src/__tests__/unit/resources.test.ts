import { describe, expect, it } from 'vitest';
import { registerResources } from '../../resources/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

describe('resource registrations', () => {
  it('should register all expected resources', () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();

    registerResources(server as any, api as any);

    expect(server.registerResource).toHaveBeenCalledTimes(9);
    const resourceIds = server.registerResource.mock.calls.map((c) => c[0]);
    expect(resourceIds).toContain('enrolled-files');
    expect(resourceIds).toContain('enrolled-file');
    expect(resourceIds).toContain('file-versions');
    expect(resourceIds).toContain('file-version');
    expect(resourceIds).toContain('file-comments');
    expect(resourceIds).toContain('version-reviews');
    expect(resourceIds).toContain('review-detail');
    expect(resourceIds).toContain('team-detail');
    expect(resourceIds).toContain('unattributed-changes');
  });

  it('should render enrolled-files resource content via API', async () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    registerResources(server as any, api as any);

    const call = server.registerResource.mock.calls.find((c) => c[0] === 'enrolled-files');
    const handler = call?.[3];
    const result = await handler(new URL('rockhopper://files'));

    expect(api.listEnrolledFiles).toHaveBeenCalledTimes(1);
    expect(result.contents[0].uri).toBe('rockhopper://files');
    expect(result.contents[0].mimeType).toBe('application/json');
    expect(result.contents[0].text).toContain('Budget.xlsx');
  });

  it('should resolve unattributed changes resource content via API', async () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();
    registerResources(server as any, api as any);

    const call = server.registerResource.mock.calls.find((c) => c[0] === 'unattributed-changes');
    const handler = call?.[3];
    const result = await handler(new URL('rockhopper://files/file-1/changes'), {
      fileMsId: 'file-1',
    });

    expect(api.getUnattributedChanges).toHaveBeenCalledWith('file-1');
    expect(result.contents[0].uri).toContain('rockhopper://files/file-1/changes');
  });
});
