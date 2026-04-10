import { registerFileResources } from './files.js';
import { registerVersionResources } from './versions.js';
import { registerCommentResources } from './comments.js';
import { registerReviewResources } from './reviews.js';
import { registerTeamResources } from './teams.js';
import { registerChangeResources } from './changes.js';
export function registerResources(server, api) {
    registerFileResources(server, api);
    registerVersionResources(server, api);
    registerCommentResources(server, api);
    registerReviewResources(server, api);
    registerTeamResources(server, api);
    registerChangeResources(server, api);
}
//# sourceMappingURL=index.js.map