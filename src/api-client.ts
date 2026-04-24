import type {
  CellHistoryEntry,
  EnrolledFile,
  FileChat,
  FileVersion,
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
  }): Promise<EnrolledFile[]> {
    const query = new URLSearchParams();
    if (params?.search) query.set('search', params.search);
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

  async getUnattributedChanges(
    fileMsId: string,
    params?: { sheetName?: string; status?: string },
  ): Promise<UnattributedChange[]> {
    let path = `/unattributed-changes/${fileMsId}`;
    if (params?.sheetName) {
      path += `/${params.sheetName}`;
    }
    return this.request<UnattributedChange[]>(path);
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
