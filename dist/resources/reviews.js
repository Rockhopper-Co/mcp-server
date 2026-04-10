import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
export function registerReviewResources(server, api) {
    server.registerResource('version-reviews', new ResourceTemplate('rockhopper://versions/{versionId}/reviews', {
        list: undefined,
    }), {
        title: 'Reviews for Version',
        description: 'All review requests associated with a specific file version',
        mimeType: 'application/json',
    }, async (uri, { versionId }) => {
        const reviews = await api.getReviewsForVersion(Number(versionId));
        return {
            contents: [
                {
                    uri: uri.href,
                    mimeType: 'application/json',
                    text: JSON.stringify(reviews, null, 2),
                },
            ],
        };
    });
    server.registerResource('review-detail', new ResourceTemplate('rockhopper://reviews/{reviewId}', {
        list: undefined,
    }), {
        title: 'Review Details',
        description: 'Details for a specific review request',
        mimeType: 'application/json',
    }, async (uri, { reviewId }) => {
        const review = await api.getReview(Number(reviewId));
        return {
            contents: [
                {
                    uri: uri.href,
                    mimeType: 'application/json',
                    text: JSON.stringify(review, null, 2),
                },
            ],
        };
    });
}
//# sourceMappingURL=reviews.js.map