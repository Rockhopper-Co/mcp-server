import type { ServerResponse } from 'node:http';

/**
 * ENG-6435 — POST /file-chat with an `anchor`, and the GET that reads it back,
 * shaped like the backend: a spreadsheet refuses the anchor with the 400
 * `comment-anchor.ts!assertCommentAnchorAllowed` sends, and a document stores
 * it and returns it resolved (`get-file-chat.dto.ts!ResolvedCommentAnchorDto`).
 */

export const ANCHORED_DOC_FILE = 'doc-1';

interface AnchorBody {
  fileMsId?: string;
  message?: string;
  anchor?: {
    anchorKind: string;
    providerAnchorId: string;
    observedVersionInternalId?: number;
  };
}

const stored = new Map<string, Record<string, unknown>[]>();

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

/** Answers an anchored POST. Returns false when the body carries no anchor. */
export function handleAnchoredCommentPost(
  res: ServerResponse,
  body: AnchorBody,
): boolean {
  if (!body.anchor) return false;
  if (body.fileMsId !== ANCHORED_DOC_FILE) {
    send(res, 400, {
      statusCode: 400,
      message:
        'Spreadsheet comments are not anchored through document_anchor. ' +
        'Use cellReference, which remains the spreadsheet anchor.',
    });
    return true;
  }
  const comment = {
    internalId: 920 + (stored.get(body.fileMsId)?.length ?? 0),
    message: body.message ?? '',
    cellReference: null,
    createdAt: '2026-09-28T00:00:00Z',
    authorName: 'Assistant',
    resolved: false,
    anchor: {
      anchorStableId: 'anchor-uuid-1',
      locationKind: body.anchor.anchorKind,
      anchorKind: body.anchor.anchorKind,
      providerAnchorId: body.anchor.providerAnchorId,
      containerStableId: null,
      subLocator: null,
      observedVersionInternalId: body.anchor.observedVersionInternalId ?? null,
      presentInLatestCommitted: null,
      latestCommittedVersionId: null,
    },
  };
  stored.set(body.fileMsId, [...(stored.get(body.fileMsId) ?? []), comment]);
  send(res, 200, comment);
  return true;
}

/** Answers GET /file-chat/doc-1 with what the anchored POSTs stored. */
export function handleAnchoredCommentGet(
  res: ServerResponse,
  path: string,
): boolean {
  if (path !== `/file-chat/${ANCHORED_DOC_FILE}`) return false;
  send(res, 200, stored.get(ANCHORED_DOC_FILE) ?? []);
  return true;
}
