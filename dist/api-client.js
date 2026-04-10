export class ApiClient {
    baseUrl;
    token;
    constructor(config) {
        this.baseUrl = config.baseUrl.replace(/\/+$/, '');
        this.token = config.token;
    }
    async request(path, init) {
        const url = `${this.baseUrl}${path}`;
        const response = await fetch(url, {
            ...init,
            headers: {
                Authorization: `Bearer ${this.token}`,
                'Content-Type': 'application/json',
                ...init?.headers,
            },
        });
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`Rockhopper API ${response.status}: ${response.statusText} — ${body}`);
        }
        return response.json();
    }
    // --- Users ---
    async getMe() {
        return this.request('/users/me');
    }
    // --- Teams ---
    async getTeam(teamId) {
        return this.request(`/teams/${teamId}`);
    }
    // --- Enrolled Files ---
    async listEnrolledFiles(params) {
        const query = new URLSearchParams();
        if (params?.search)
            query.set('search', params.search);
        const qs = query.toString();
        return this.request(`/enrolled-files${qs ? `?${qs}` : ''}`);
    }
    async getEnrolledFile(fileMsId) {
        return this.request(`/enrolled-files/${fileMsId}`);
    }
    // --- File Versions ---
    async getFileVersions(fileMsId) {
        return this.request(`/file-versions/file/${fileMsId}`);
    }
    async getFileVersion(versionInternalId) {
        return this.request(`/file-versions/file/version/${versionInternalId}`);
    }
    async getCellHistory(fileMsId, sheetName, cellAddress) {
        const query = new URLSearchParams({ cell: cellAddress, sheetName });
        return this.request(`/file-versions/file/${fileMsId}/cell-history?${query}`);
    }
    // --- File Chat (Comments) ---
    async getFileComments(fileMsId) {
        return this.request(`/file-chat/${fileMsId}`);
    }
    async getComment(chatId) {
        return this.request(`/file-chat/single/${chatId}`);
    }
    async createComment(body) {
        return this.request('/file-chat', {
            method: 'POST',
            body: JSON.stringify(body),
        });
    }
    async replyToComment(chatId, body) {
        return this.request(`/file-chat/${chatId}/replies`, {
            method: 'POST',
            body: JSON.stringify(body),
        });
    }
    async resolveComment(chatId) {
        return this.request(`/file-chat/${chatId}`, {
            method: 'PATCH',
            body: JSON.stringify({ resolved: true }),
        });
    }
    // --- Reviews ---
    async getReviewsForVersion(versionId) {
        return this.request(`/reviews/versions/${versionId}/requests`);
    }
    async getReviewsForLatestVersion(fileMsId) {
        return this.request(`/reviews/files/${fileMsId}/latest-version/requests`);
    }
    async getReview(reviewId) {
        return this.request(`/reviews/requests/${reviewId}`);
    }
    async getReviewActivities(reviewId) {
        return this.request(`/reviews/requests/${reviewId}/activities`);
    }
    async createReviewRequest(body) {
        return this.request('/reviews/requests', {
            method: 'POST',
            body: JSON.stringify(body),
        });
    }
    async approveReview(reviewId, body) {
        return this.request(`/reviews/requests/${reviewId}/approve`, {
            method: 'POST',
            body: JSON.stringify(body),
        });
    }
    // --- Unattributed Changes ---
    async getUnattributedChanges(fileMsId, params) {
        let path = `/unattributed-changes/${fileMsId}`;
        if (params?.sheetName) {
            path += `/${params.sheetName}`;
        }
        return this.request(path);
    }
    // --- File metadata update ---
    async updateEnrolledFile(fileMsId, body) {
        return this.request(`/enrolled-files/${fileMsId}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
        });
    }
}
//# sourceMappingURL=api-client.js.map