import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
export function registerFileResources(server, api) {
    server.registerResource('enrolled-files', 'rockhopper://files', {
        title: 'Enrolled Files',
        description: 'All Excel files enrolled in the current user\'s Rockhopper workspace',
        mimeType: 'application/json',
    }, async (uri) => {
        const files = await api.listEnrolledFiles();
        return {
            contents: [
                {
                    uri: uri.href,
                    mimeType: 'application/json',
                    text: JSON.stringify(files, null, 2),
                },
            ],
        };
    });
    server.registerResource('enrolled-file', new ResourceTemplate('rockhopper://files/{fileMsId}', {
        list: async () => {
            const files = await api.listEnrolledFiles();
            return {
                resources: files.map((f) => ({
                    uri: `rockhopper://files/${f.platformId}`,
                    name: f.name,
                    description: `${f.name} (${f.fileType})`,
                    mimeType: 'application/json',
                })),
            };
        },
    }), {
        title: 'Enrolled File Details',
        description: 'Details for a specific enrolled file by its platform ID',
        mimeType: 'application/json',
    }, async (uri, { fileMsId }) => {
        const file = await api.getEnrolledFile(fileMsId);
        return {
            contents: [
                {
                    uri: uri.href,
                    mimeType: 'application/json',
                    text: JSON.stringify(file, null, 2),
                },
            ],
        };
    });
}
//# sourceMappingURL=files.js.map