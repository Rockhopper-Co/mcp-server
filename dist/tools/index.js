import { registerListFilesTool } from './list-files.js';
import { registerGetVersionsTool } from './get-versions.js';
import { registerGetCommentsTool } from './get-comments.js';
import { registerGetReviewsTool } from './get-reviews.js';
import { registerGetCellHistoryTool } from './get-cell-history.js';
import { registerSearchTool } from './search.js';
import { registerWriteCommentTools } from './write-comments.js';
import { registerWriteReviewTools } from './write-reviews.js';
import { registerWriteFileTool } from './write-files.js';
export function registerTools(server, api) {
    // Read-only tools (available to all scopes)
    registerListFilesTool(server, api);
    registerGetVersionsTool(server, api);
    registerGetCommentsTool(server, api);
    registerGetReviewsTool(server, api);
    registerGetCellHistoryTool(server, api);
    registerSearchTool(server, api);
    // Write tools (require read-write scope on PAT)
    registerWriteCommentTools(server, api);
    registerWriteReviewTools(server, api);
    registerWriteFileTool(server, api);
}
//# sourceMappingURL=index.js.map