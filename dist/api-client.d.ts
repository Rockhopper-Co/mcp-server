import type { CellHistoryEntry, EnrolledFile, FileChat, FileVersion, ReviewActivity, ReviewRequest, Team, UnattributedChange, UserSummary } from './types.js';
export interface ApiClientConfig {
    baseUrl: string;
    token: string;
}
export declare class ApiClient {
    private readonly baseUrl;
    private readonly token;
    constructor(config: ApiClientConfig);
    private request;
    getMe(): Promise<UserSummary>;
    getTeam(teamId: number): Promise<Team>;
    listEnrolledFiles(params?: {
        search?: string;
    }): Promise<EnrolledFile[]>;
    getEnrolledFile(fileMsId: string): Promise<EnrolledFile>;
    getFileVersions(fileMsId: string): Promise<FileVersion[]>;
    getFileVersion(versionInternalId: number): Promise<FileVersion>;
    getCellHistory(fileMsId: string, sheetName: string, cellAddress: string): Promise<CellHistoryEntry[]>;
    getFileComments(fileMsId: string): Promise<FileChat[]>;
    getComment(chatId: number): Promise<FileChat>;
    createComment(body: {
        fileMsId: string;
        message: string;
        cellReference?: string;
        versionInternalId?: number;
    }): Promise<FileChat>;
    replyToComment(chatId: number, body: {
        message: string;
    }): Promise<FileChat>;
    resolveComment(chatId: number): Promise<FileChat>;
    getReviewsForVersion(versionId: number): Promise<ReviewRequest[]>;
    getReviewsForLatestVersion(fileMsId: string): Promise<ReviewRequest[]>;
    getReview(reviewId: number): Promise<ReviewRequest>;
    getReviewActivities(reviewId: number): Promise<ReviewActivity[]>;
    createReviewRequest(body: {
        fileVersionInternalId: number;
        subject: string;
        description?: string;
        reviewerMsIds: string[];
    }): Promise<ReviewRequest>;
    approveReview(reviewId: number, body: {
        notes?: string;
    }): Promise<ReviewRequest>;
    getUnattributedChanges(fileMsId: string, params?: {
        sheetName?: string;
        status?: string;
    }): Promise<UnattributedChange[]>;
    updateEnrolledFile(fileMsId: string, body: {
        name?: string;
    }): Promise<EnrolledFile>;
}
//# sourceMappingURL=api-client.d.ts.map