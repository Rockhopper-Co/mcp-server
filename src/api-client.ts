import { randomUUID } from 'node:crypto';
import type { ZodType } from 'zod';
import { getCorrelationId } from './correlation.js';
import { log } from './logger.js';
import type {
  CellHistoryEntry,
  EnrolledFile,
  FileChat,
  FileVersion,
  FoldStatus,
  PaginatedUnattributedResponse,
  ReviewActivity,
  ReviewRequest,
  RockhopperId,
  Team,
  UnattributedChange,
  UserSummary,
  MicrosoftConnectHandoff,
  MicrosoftLinkStatus,
} from './types.js';
import {
  CellHistoryEntryArraySchema,
  EnrolledFileSchema,
  FileChatSchema,
  FoldStatusSchema,
} from './zod-schemas.js';
import {
  ChangeHistoryNotReadyError,
  DEFAULT_RETRY_AFTER_SECONDS,
} from './not-ready.js';

/**
 * Plan 02 ruling 5 — the poll hint comes from the SERVER's `Retry-After`
 * (the produce ETA), never from a local guess. A missing/garbage header falls
 * back to the shared default rather than inventing a shorter interval: a hint
 * that is too short turns one waiting client into the herd the parser lease
 * exists to prevent (SP02 adversarial S6).
 */
function parseRetryAfterSeconds(response: {
  headers?: { get(name: string): string | null };
}): number {
  const raw = response.headers?.get('Retry-After');
  if (!raw) return DEFAULT_RETRY_AFTER_SECONDS;
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds > 0
    ? seconds
    : DEFAULT_RETRY_AFTER_SECONDS;
}

export interface ApiClientConfig {
  baseUrl: string;
  token: string;
  /**
   * Phase 1.1 / KI-226 — optional fixed correlation id stamped on every
   * outbound request's `X-Correlation-Id` header. The mcp-gateway sets this
   * to forward its own per-request id onto tool-call traffic (it constructs a
   * fresh `ApiClient` per request). Precedence for the header value:
   * an explicit per-call `init.headers['X-Correlation-Id']` >
   * this config value > the per-tool-call ALS id (`getCorrelationId()`) >
   * a freshly minted UUID v4.
   */
  correlationId?: string;
  /**
   * ENG-1756 (plan §9 decision 15) — provenance-context EMIT config. Every
   * WRITE call carries `X-Rockhopper-Surface` + `X-Rockhopper-Session-Id`
   * (and `X-Driving-Human` once known) so the backend's decision-15
   * admission never 403s a well-behaved agent client and the capture
   * sidecar (`cell_change_provenance_context`) gets its surface/session.
   * Defaults: surface `'mcp'`, a per-client-instance UUID session id, no
   * driving human until {@link ApiClient.setDrivingHuman} is called (the
   * backend then falls back to the PAT owner — the same human).
   */
  provenanceContext?: {
    /** `'mcp'` (local server, default) | `'gateway'` (remote gateway). */
    surface?: string;
    /** Session correlation id for the sidecar; default: per-instance UUID. */
    sessionId?: string;
    /** Platform id (msId/googleId) of the human driving this agent. */
    drivingHumanPlatformId?: string;
  };
}

/**
 * A non-OK HTTP answer, carrying its status so callers can tell a DEFINITIVE
 * rejection (404 the file is not there, 403 no access) from an ambiguous one
 * (5xx, transport). The strict no-partial gate needs that distinction: failing
 * closed on an ambiguous probe is right, but reporting "retry later" for a file
 * that does not exist would be a fabricated capacity signal. Message text is
 * unchanged from the previous plain `Error` — callers render it verbatim.
 */
export class RockhopperApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'RockhopperApiError';
    this.status = status;
  }
}

/** HTTP methods the decision-15 admission treats as agent writes. */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class ApiClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly correlationId?: string;
  private readonly surface: string;
  private readonly sessionId: string;
  private drivingHumanPlatformId: string | null;
  private authExpiredHandler?: () => void;
  private authExpiredNotified = false;

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.token = config.token;
    this.correlationId = config.correlationId;
    this.surface = config.provenanceContext?.surface ?? 'mcp';
    this.sessionId = config.provenanceContext?.sessionId ?? randomUUID();
    this.drivingHumanPlatformId =
      config.provenanceContext?.drivingHumanPlatformId ?? null;
  }

  /**
   * ENG-1756: declare (or clear) the human driving this agent. The CLI sets
   * it from the `/users/me` preflight (`msId`/`googleId` — the PAT owner);
   * subsequent writes then carry `X-Driving-Human`. While unset, the backend
   * resolves the driving human as the PAT owner server-side, so writes keep
   * working — this header is the explicit, forward-compatible form.
   */
  setDrivingHuman(platformId: string | null): void {
    this.drivingHumanPlatformId = platformId;
  }

  /**
   * ENG-2208 — run `handler` the FIRST time this client sees a 401, and never
   * again for the life of the client.
   *
   * A token that expires mid-session is silent today: the 401 becomes an error
   * string inside a tool result, which the model reads and the human does not.
   * The CLI registers a handler that writes one stderr line, and registers it
   * only AFTER the `/users/me` preflight has succeeded — so a token that was
   * already dead at launch takes the startup path (which exits with its own
   * message) and can never double-report here.
   *
   * 401 only. A 403 is an authorisation answer about one resource, not a dead
   * token, and telling a customer to re-mint their token over a permission
   * denial sends them to fix the wrong thing.
   */
  setAuthExpiredHandler(handler: () => void): void {
    this.authExpiredHandler = handler;
  }

  /**
   * KI-096: optional `responseSchema` validates the response shape with
   * zod. When supplied, drift between backend's actual response and the
   * mcp-server's declared type fails LOUDLY with a `ZodError` (wrapped
   * here in an Error with the path that drifted) instead of silently
   * rendering `undefined` in tool formatters. Opt-in per call site so
   * existing methods stay untouched until a sweep migrates them.
   */
  private async request<T>(
    path: string,
    init?: RequestInit,
    responseSchema?: ZodType<T>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    // KI-225: log only the URL pathname (drop the query string) — query may
    // carry search terms / cell refs; it never carries the token (header
    // only), but it's not a safe field to persist.
    const pathname = path.split('?')[0];
    const method = (init?.method ?? 'GET').toUpperCase();
    const start = Date.now();

    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          // KI-226: trace this request in backend logs. Placed BEFORE the
          // `...init?.headers` spread so a per-call header still wins but the
          // id can't be dropped. Precedence: per-call > config > ALS > mint.
          // Non-sensitive UUID — never co-logged with the bearer token above.
          'X-Correlation-Id':
            this.correlationId ?? getCorrelationId() ?? randomUUID(),
          // ENG-1756 (decision 15): agent writes carry the provenance
          // context so the backend's anonymous-agent-write admission never
          // fires for this well-behaved client and the capture sidecar gets
          // its surface/session. Reads carry none (no admission on reads).
          // Placed before the spread so a per-call header still wins.
          ...(WRITE_METHODS.has(method)
            ? {
                'X-Rockhopper-Surface': this.surface,
                'X-Rockhopper-Session-Id': this.sessionId,
                ...(this.drivingHumanPlatformId
                  ? { 'X-Driving-Human': this.drivingHumanPlatformId }
                  : {}),
              }
            : {}),
          ...init?.headers,
        },
      });
    } catch (err) {
      // KI-225: the can't-reach-the-API case — a thrown fetch is a network
      // failure, the class of error that NEVER reaches the backend log.
      log.error(
        { event: 'api_unreachable', method, path: pathname, durationMs: Date.now() - start, err },
        'api_unreachable',
      );
      throw err;
    }

    const durationMs = Date.now() - start;

    if (!response.ok) {
      // KI-225: classify auth rejections (401/403) so they're greppable
      // separately from generic HTTP errors.
      // Plan 02 ruling 5: 429/503 on a read lane is the backend's "outputs
      // still producing" answer (SP02 maps the typed not-ready to 429 +
      // Retry-After). It must NOT reach a formatter as a generic error string —
      // an assistant reading `Rockhopper API 429: …` has no reliable way to
      // tell a capacity signal from a real failure, and either way it is not
      // data. Classified here, at the one place every call passes through.
      const notReady = response.status === 429 || response.status === 503;
      const classification =
        response.status === 401 || response.status === 403
          ? 'auth_failed'
          : notReady
            ? 'not_ready'
            : 'http_error';
      log.warn(
        {
          event: 'api_request_failed',
          method,
          path: pathname,
          status: response.status,
          durationMs,
          classification,
        },
        'api_request_failed',
      );
      // ENG-2208: one-shot mid-session expiry notice (see
      // {@link setAuthExpiredHandler}). Guarded on the handler existing so the
      // "first 401" is the first one anybody is listening for.
      if (
        response.status === 401 &&
        this.authExpiredHandler &&
        !this.authExpiredNotified
      ) {
        this.authExpiredNotified = true;
        this.authExpiredHandler();
      }
      const body = await response.text().catch(() => '');
      if (notReady) {
        throw new ChangeHistoryNotReadyError({
          reason: 'still_producing',
          retryAfterSeconds: parseRetryAfterSeconds(response),
          detail: `${response.status} ${response.statusText} at ${pathname}`,
        });
      }
      throw new RockhopperApiError(
        response.status,
        `Rockhopper API ${response.status}: ${response.statusText} — ${body}`,
      );
    }

    log.info(
      { event: 'api_request', method, path: pathname, status: response.status, durationMs },
      'api_request',
    );

    const json = await response.json();
    if (responseSchema) {
      const parsed = responseSchema.safeParse(json);
      if (!parsed.success) {
        // Surface a useful diagnostic — the formatter would otherwise show
        // `undefined`, hiding the contract break. Include the path of the
        // first issue so the cause is obvious from the error message.
        const first = parsed.error.issues[0];
        // KI-225: schema drift is a client-side detection the backend can't
        // see. Log the issue path + message ONLY — never the raw payload
        // (`json`), which may contain file/cell data.
        log.warn(
          {
            event: 'schema_validation_failed',
            endpoint: pathname,
            issue: first?.path.join('.') || '<root>',
            err: first?.message,
          },
          'schema_validation_failed',
        );
        throw new Error(
          `Rockhopper API response failed schema check at ${path}: ` +
            `${first?.path.join('.') || '<root>'} — ${first?.message} ` +
            `(${parsed.error.issues.length} issue(s) total)`,
        );
      }
      return parsed.data;
    }
    return json as T;
  }

  // --- Users ---

  async getMe(): Promise<UserSummary> {
    return this.request<UserSummary>('/users/me');
  }

  // --- Microsoft Graph link (ENG-2198) ---

  /**
   * Ask the BACKEND to build the Microsoft consent URL.
   *
   * Note what this method cannot do: pass a URL, a redirect, a client id or a
   * scope list. The authorize URL is constructed server-side and the callback
   * re-pins the client id and redirect when it redeems the code. That is
   * deliberate — a URL this client could influence is a consent-phishing
   * lever, because the model driving an MCP session could be talked into
   * emitting a link that points the user's consent at an attacker's
   * application, behind a genuine Microsoft consent screen.
   */
  async beginMicrosoftConnect(): Promise<MicrosoftConnectHandoff> {
    return this.request<MicrosoftConnectHandoff>('/auth/microsoft/connect', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  async getMicrosoftLink(): Promise<MicrosoftLinkStatus> {
    return this.request<MicrosoftLinkStatus>('/auth/microsoft/link');
  }

  async unlinkMicrosoft(): Promise<{ linked: boolean; removed: boolean }> {
    return this.request<{ linked: boolean; removed: boolean }>(
      '/auth/microsoft/link',
      { method: 'DELETE' },
    );
  }

  // --- Teams ---

  /**
   * ENG-2230 — `teamId` is either spelling: the version-7 uuid or the legacy
   * numeric internal id. Both are interpolated into the path unchanged and
   * both name the same row (backend #1717). Widened from `number`, so no
   * existing caller changes.
   */
  async getTeam(teamId: RockhopperId): Promise<Team> {
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

  /**
   * Plan 02 ruling 5 — the completeness probe for every change-history
   * surface. `foldPending: true` means a commit-diff fold is queued, retrying
   * or running, i.e. the change-log window is mid-rewrite: incomplete.
   * Consumed by `assertChangeHistoryComplete`, never rendered to the user.
   */
  async getFoldStatus(fileMsId: string): Promise<FoldStatus> {
    return this.request<FoldStatus>(
      `/file-versions/file/${fileMsId}/fold-status`,
      undefined,
      FoldStatusSchema as unknown as ZodType<FoldStatus>,
    );
  }

  /**
   * KI-096: passes `?format=mcp` to opt into the backend's normalized
   * projection `{versionId, value, changedBy, changedAt}` (added by
   * backend PR #478). Default `format` (omitted) returns the raw CTE
   * row shape the frontend cell-history popover consumes — we never
   * call that path. Zod-parses the response so future drift between
   * backend and mcp-server contracts fails loudly.
   *
   * ENG-1638 (P3-2) remainder: the backend now routes this read through the
   * SAME ledger read-decision choke point as the webapp/add-in popovers
   * (cross-surface parity). An eligible file serves the WIDENED entries
   * (+ formula, provenance, actorKind, drivingHuman, formatted — including
   * live events with versionId 'uncommitted'); a not-eligible file, a Google
   * file, or an older backend serves the four-field legacy projection. The
   * schema accepts both.
   */
  async getCellHistory(
    fileMsId: string,
    sheetName: string,
    cellAddress: string,
  ): Promise<CellHistoryEntry[]> {
    const query = new URLSearchParams({
      cell: cellAddress,
      sheetName,
      format: 'mcp',
    });
    return this.request<CellHistoryEntry[]>(
      `/file-versions/file/${fileMsId}/cell-history?${query}`,
      undefined,
      CellHistoryEntryArraySchema as unknown as ZodType<CellHistoryEntry[]>,
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

  /**
   * KI-096: zod-parses the response. Backend PR #478 fixed
   * `PATCH /file-chat/:chatId` to return the updated entity (was
   * UpdateResult) AND to persist `resolved` (was silently dropped).
   * The schema check pins both fixes — if either regresses, the parse
   * fails with a clear message instead of the formatter rendering
   * `Comment undefined marked as resolved.`
   */
  async resolveComment(chatId: number): Promise<FileChat> {
    return this.request<FileChat>(
      `/file-chat/${chatId}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ resolved: true }),
      },
      FileChatSchema as unknown as ZodType<FileChat>,
    );
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

  /**
   * ENG-2230 — `reviewerIds` accepts either spelling of a user id (uuid or
   * legacy numeric internal id), mixed freely. Values are serialised
   * verbatim; the backend resolves both (`@AcceptsResourceId({ reviewerIds:
   * 'user' })` on `POST|PUT /reviews/requests`). `versionId` is a FILE
   * VERSION id and is NOT re-keyed — it stays numeric.
   */
  async createReviewRequest(body: {
    versionId: number;
    subject: string;
    description?: string;
    reviewerIds: RockhopperId[];
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

  /**
   * KI-096: zod-parses the response. Backend PR #478 fixed
   * `PATCH /enrolled-files/:fileMsId` to return the updated entity
   * (was UpdateResult typed as Promise<any>). The schema check pins
   * the entity contract — if it regresses, the parse fails with a
   * clear message instead of `rename_file` rendering
   * `File renamed to 'undefined' (id: undefined).`
   */
  async updateEnrolledFile(
    fileMsId: string,
    body: { name?: string },
  ): Promise<EnrolledFile> {
    return this.request<EnrolledFile>(
      `/enrolled-files/${fileMsId}`,
      {
        method: 'PATCH',
        body: JSON.stringify(body),
      },
      EnrolledFileSchema as unknown as ZodType<EnrolledFile>,
    );
  }
}
