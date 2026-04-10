import { z } from 'zod';
export function registerWriteFileTool(server, api) {
    server.registerTool('update_file_description', {
        title: 'Update File Metadata',
        description: 'Update the display name of an enrolled file.',
        inputSchema: {
            fileMsId: z.string().describe('Platform ID of the enrolled file'),
            name: z.string().min(1).max(255).describe('New display name for the file'),
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
        },
    }, async ({ fileMsId, name }) => {
        try {
            const file = await api.updateEnrolledFile(fileMsId, { name });
            return {
                content: [
                    {
                        type: 'text',
                        text: `File renamed to "${file.name}" (id: ${file.platformId}).`,
                    },
                ],
            };
        }
        catch (error) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to update file: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
                isError: true,
            };
        }
    });
}
//# sourceMappingURL=write-files.js.map