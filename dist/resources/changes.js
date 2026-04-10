import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
export function registerChangeResources(server, api) {
    server.registerResource('unattributed-changes', new ResourceTemplate('rockhopper://files/{fileMsId}/changes', {
        list: async () => {
            const files = await api.listEnrolledFiles();
            return {
                resources: files
                    .filter((f) => f.hasUncommittedChanges)
                    .map((f) => ({
                    uri: `rockhopper://files/${f.platformId}/changes`,
                    name: `Unattributed changes in ${f.name}`,
                    mimeType: 'application/json',
                })),
            };
        },
    }), {
        title: 'Unattributed Changes',
        description: 'Pending cell-level changes not yet attributed to a version for a file',
        mimeType: 'application/json',
    }, async (uri, { fileMsId }) => {
        const changes = await api.getUnattributedChanges(fileMsId);
        return {
            contents: [
                {
                    uri: uri.href,
                    mimeType: 'application/json',
                    text: JSON.stringify(changes, null, 2),
                },
            ],
        };
    });
}
//# sourceMappingURL=changes.js.map