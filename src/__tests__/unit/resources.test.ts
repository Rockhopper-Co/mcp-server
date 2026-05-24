import { describe, expect, it } from 'vitest';
import { registerResources } from '../../resources/index.js';
import { createMockApiClient, createMockMcpServer } from './test-helpers.js';

describe('resource registrations', () => {
  it('should register all expected resources', () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();

    registerResources(server as any, api as any);

    // 9 file/team/review resources + orchestration-guide (KI-079) = 10.
    expect(server.registerResource).toHaveBeenCalledTimes(10);
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
    expect(resourceIds).toContain('orchestration-guide');
  });

  it('should not register per-file list callbacks on templates (KI-078)', () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();

    registerResources(server as any, api as any);

    // The 4 per-file templates must register without a `list:` callback so
    // they appear in resources/templates/list rather than enumerating per-file
    // in resources/list.
    const perFileTemplateIds = [
      'enrolled-file',
      'file-versions',
      'file-comments',
      'unattributed-changes',
    ];
    for (const id of perFileTemplateIds) {
      const call = server.registerResource.mock.calls.find((c) => c[0] === id);
      const template = call?.[1] as { listCallback?: unknown };
      expect(template.listCallback).toBeUndefined();
    }
  });

  it('should serve orchestration-guide as markdown content', async () => {
    const server = createMockMcpServer();
    const api = createMockApiClient();

    registerResources(server as any, api as any);

    const call = server.registerResource.mock.calls.find(
      (c) => c[0] === 'orchestration-guide',
    );
    expect(call).toBeDefined();
    const config = call?.[2] as { mimeType?: string };
    expect(config.mimeType).toBe('text/markdown');

    const handler = call?.[3];
    const result = await handler(
      new URL('rockhopper://orchestration-guide'),
    );
    expect(result.contents[0].uri).toBe('rockhopper://orchestration-guide');
    expect(result.contents[0].mimeType).toBe('text/markdown');
    expect(result.contents[0].text).toMatch(/fileMsId/);
    expect(result.contents[0].text).toMatch(/versionId/);
    expect(result.contents[0].text).toMatch(/orchestration/i);
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

    expect(api.getUnattributedChangesPaginated).toHaveBeenCalledWith('file-1');
    expect(result.contents[0].uri).toContain('rockhopper://files/file-1/changes');
  });
});
