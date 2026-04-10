import { z } from 'zod';
export function registerWriteCommentTools(server, api) {
    server.registerTool('add_comment', {
        title: 'Add Comment',
        description: 'Add a new comment to an enrolled file. Optionally attach it to a ' +
            'specific cell reference and/or file version.',
        inputSchema: {
            fileMsId: z.string().describe('Platform ID of the enrolled file'),
            message: z.string().min(1).max(5000).describe('Comment text'),
            cellReference: z
                .string()
                .optional()
                .describe('Cell reference (e.g. "Sheet1!A1")'),
            versionInternalId: z
                .number()
                .optional()
                .describe('Internal ID of the file version to attach the comment to'),
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
        },
    }, async ({ fileMsId, message, cellReference, versionInternalId }) => {
        try {
            const comment = await api.createComment({
                fileMsId,
                message,
                cellReference,
                versionInternalId,
            });
            return {
                content: [
                    {
                        type: 'text',
                        text: `Comment created (id: ${comment.internalId}):\n` +
                            `"${comment.message}"` +
                            (comment.cellReference
                                ? ` at ${comment.cellReference}`
                                : ''),
                    },
                ],
            };
        }
        catch (error) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to add comment: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
                isError: true,
            };
        }
    });
    server.registerTool('reply_to_comment', {
        title: 'Reply to Comment',
        description: 'Reply to an existing comment thread.',
        inputSchema: {
            chatId: z.number().describe('Internal ID of the parent comment'),
            message: z.string().min(1).max(5000).describe('Reply text'),
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
        },
    }, async ({ chatId, message }) => {
        try {
            const reply = await api.replyToComment(chatId, { message });
            return {
                content: [
                    {
                        type: 'text',
                        text: `Reply created (id: ${reply.internalId}): "${reply.message}"`,
                    },
                ],
            };
        }
        catch (error) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to reply: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
                isError: true,
            };
        }
    });
    server.registerTool('resolve_comment', {
        title: 'Resolve Comment',
        description: 'Mark a comment as resolved. Only the comment author can resolve it.',
        inputSchema: {
            chatId: z.number().describe('Internal ID of the comment to resolve'),
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
        },
    }, async ({ chatId }) => {
        try {
            const comment = await api.resolveComment(chatId);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Comment ${comment.internalId} marked as resolved.`,
                    },
                ],
            };
        }
        catch (error) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Failed to resolve: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
                isError: true,
            };
        }
    });
}
//# sourceMappingURL=write-comments.js.map