import type {
  CellHistoryEntry,
  EnrolledFile,
  FileChat,
  FileVersion,
  PaginatedUnattributedResponse,
  ReviewActivity,
  ReviewRequest,
  Team,
  UnattributedChange,
  UserSummary,
} from './types.js';

export interface ApiClientConfig {
  baseUrl: string;
  token: string;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.token = config.token;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
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
      throw new Error(
        `Rockhopper API ${response.status}: ${response.statusText} — ${body}`,
      );
    }

    return response.json() as Promise<T>;
  }

  // --- Users ---

  async getMe(): Promise<UserSummary> {
    return this.request<UserSummary>('/users/me');
  }

  // --- Teams ---

  async getTeam(teamId: number): Promise<Team> {
    return this.request<Team>(`/teams/${teamId}`);
  }

  // --- Enrolled Files ---

  async listEnrolledFiles(params?: {
    search?: string;
    matchIn?: 'name' | 'comments' | 'versions' | 'all';
  }): Promise<EnrolledFile[]> {
    const query = new URLSearchParams();
    if (params?.search) query.set('search', params.search);
    if (params?.matchIn) query.set('matchIn', params.matchIn);
    const qs = query.toString();
    return this.request<EnrolledFile[]>(
      `/enrolled-files${qs ? `?${qs}` : ''}`,
    );
  }

  async getEnrolledFile(fileMsId: string): Promise<EnrolledFile> {
    return this.request<EnrolledFile>(`/enrolled-files/${fileMsId}`);
  }

  // --- File Versions ---

  async getFileVersions(fileMsId: string): Promise<FileVersion[]> {
    return this.request<FileVersion[]>(`/file-versions/file/${fileMsId}`);
  }

  async getFileVersion(versionInternalId: number): Promise<FileVersion> {
    return this.request<FileVersion>(
      `/file-versions/file/version/${versionInternalId}`,
    );
  }

  async getCellHistory(
    fileMsId: string,
    sheetName: string,
    cellAddress: string,
  ): Promise<CellHistoryEntry[]> {
    const query = new URLSearchParams({ cell: cellAddress, sheetName });
    return this.request<CellHistoryEntry[]>(
      `/file-versions/file/${fileMsId}/cell-history?${query}`,
    );
  }

  // --- File Chat (Comments) ---

  async getFileComments(fileMsId: string): Promise<FileChat[]> {
    return this.request<FileChat[]>(`/file-chat/${fileMsId}`);
  }

  async getComment(chatId: number): Promise<FileChat> {
    return this.request<FileChat>(`/file-chat/single/${chatId}`);
  }

  async createComment(body: {
    fileMsId: string;
    message: string;
    cellReference?: string;
    versionInternalId: number;
  }): Promise<FileChat> {
    return this.request<FileChat>('/file-chat', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async replyToComment(
    chatId: number,
    body: { message: string; versionInternalId: number },
  ): Promise<FileChat> {
    return this.request<FileChat>(`/file-chat/${chatId}/replies`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async resolveComment(chatId: number): Promise<FileChat> {
    return this.request<FileChat>(`/file-chat/${chatId}`, {
      method: 'PATCH',
      body: JSON.stringify({ resolved: true }),
    });
  }

  // --- Reviews ---

  async getReviewsForVersion(
    versionId: number,
  ): Promise<ReviewRequest[]> {
    return this.request<ReviewRequest[]>(
      `/reviews/versions/${versionId}/requests`,
    );
  }

  async getReviewsForLatestVersion(
    fileMsId: string,
  ): Promise<ReviewRequest[]> {
    return this.request<ReviewRequest[]>(
      `/reviews/files/${fileMsId}/latest-version/requests`,
    );
  }

  async getReview(reviewId: number): Promise<ReviewRequest> {
    return this.request<ReviewRequest>(`/reviews/requests/${reviewId}`);
  }

  async getReviewActivities(
    reviewId: number,
  ): Promise<ReviewActivity[]> {
    return this.request<ReviewActivity[]>(
      `/reviews/requests/${reviewId}/activities`,
    );
  }

  async createReviewRequest(body: {
    versionId: number;
    subject: string;
    description?: string;
    reviewerIds: number[];
  }): Promise<ReviewRequest> {
    return this.request<ReviewRequest>('/reviews/requests', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async approveReview(
    reviewId: number,
    body: { notes?: string },
  ): Promise<ReviewRequest> {
    return this.request<ReviewRequest>(
      `/reviews/requests/${reviewId}/approve`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    );
  }

  // --- Unattributed Changes ---

  /**
   * Sheet-filtered unattributed changes. Returns ALL rows for the given
   * sheet on the file (no pagination — sheet filter inherently bounds
   * result size). Use this when the caller already knows which sheet to
   * inspect; use {@link getUnattributedChangesPaginated} for the file-wide
   * view.
   */
  async getUnattributedChangesBySheet(
    fileMsId: string,
    sheetName: string,
  ): Promise<UnattributedChange[]> {
    const path = `/unattributed-changes/${fileMsId}/${encodeURIComponent(
      sheetName,
    )}`;
    return this.request<UnattributedChange[]>(path);
  }

  /**
   * Cursor-paginated file-wide unattributed changes (KI-097).
   *
   * Hits the non-shadowable `GET /unattributed-changes/paginated/:fileMsId`
   * route added by backend PR #475 (KI-102). The legacy `:fileMsId/v2`
   * route is shadowed by `:fileMsId/:sheetName` route ordering and returns
   * an empty array; do not call it from here.
   *
   * Pass `cursor` returned by a previous call to fetch the next page.
   * Snapshot TTL is 30 minutes — older cursors cause the backend to return
   * HTTP 410 GONE with `{ resyncRequired: { code: 'SNAPSHOT_EXPIRED' } }`,
   * which surfaces here as a thrown RockhopperApiError.
   */
  async getUnattributedChangesPaginated(
    fileMsId: string,
    cursor?: string,
  ): Promise<PaginatedUnattributedResponse> {
    const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const path = `/unattributed-changes/paginated/${fileMsId}${qs}`;
    return this.request<PaginatedUnattributedResponse>(path);
  }

  // --- Version lifecycle ---

  async createVersion(body: {
    enrolledFileMsId: string;
    version: {
      majorVersion: number;
      minorVersion: number;
      patchVersion: number;
      description: string;
    };
  }): Promise<FileVersion> {
    return this.request<FileVersion>('/file-versions', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async discardChanges(
    fileMsId: string,
    body: { description: string },
  ): Promise<FileVersion> {
    return this.request<FileVersion>(
      `/file-versions/file/discard-live/${fileMsId}`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    );
  }

  // --- Review lifecycle ---

  async cancelReview(reviewId: number): Promise<ReviewRequest> {
    return this.request<ReviewRequest>(`/reviews/requests/${reviewId}`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'CANCELLED' }),
    });
  }

  // --- File metadata update ---

  async updateEnrolledFile(
    fileMsId: string,
    body: { name?: string },
  ): Promise<EnrolledFile> {
    return this.request<EnrolledFile>(`/enrolled-files/${fileMsId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }
}
