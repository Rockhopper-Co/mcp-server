/**
 * ENG-4349 — render Rockhopper mention tokens before a comment body leaves
 * this server.
 *
 * A stored comment body carries mentions as raw JSON:
 *
 *   `@{{"id":"abc","displayName":"David K","email":"dk@co.com"}}`  (collaborator)
 *   `#{{"id":"v-3","displayName":"v1.2.0"}}`                        (version)
 *
 * The encoding is DEFINED IN ANOTHER REPO — `backend/src/helpers/strings.ts:37`
 * — and this is a deliberate second copy of that knowledge. It lives here
 * rather than in the backend because the web app and the Excel add-in parse
 * the raw token client-side to build mention chips
 * (`frontend/packages/shared-ui/src/components/comments/Comment.tsx:539` splits
 * on the literal `@{{` delimiter, and `commentInputUtils.ts:36` re-parses it to
 * rebuild TipTap nodes when a comment is edited). Rendering server-side would
 * break both. The cost is drift: if the backend changes the encoding, change
 * this too. Its twin there is `humanReadableChatMessage`.
 *
 * `={{Sheet1!A1}}` cell references are left alone — they carry no identity and
 * the backend twin does not touch them either.
 */

const MENTION_TOKEN = /([@#])\{(\{.*?\})\}/g;
const DISPLAY_NAME = /"displayName"\s*:\s*"([^"]*)"/;

/**
 * Replace every mention token with its display name, so the reader still knows
 * WHO was asked without receiving their internal id or email address.
 *
 * Fails closed per token: an unparseable payload becomes `@mention` rather than
 * passing through. The backend twin wraps its whole replace in one try/catch,
 * so a single malformed token there returns the entire message raw — with
 * every well-formed mention's email in it.
 */
export function renderMentions(message: string): string {
  return message.replace(
    MENTION_TOKEN,
    (_match, prefix: string, payload: string) => {
      const displayName = DISPLAY_NAME.exec(payload)?.[1];
      return displayName ? `${prefix}${displayName}` : `${prefix}mention`;
    },
  );
}

/** Apply {@link renderMentions} to a comment tree, replies included. */
export function renderCommentTreeMentions<
  T extends { message: string; replies?: T[] },
>(comments: T[]): T[] {
  return comments.map((c) => ({
    ...c,
    message: renderMentions(c.message),
    ...(c.replies ? { replies: renderCommentTreeMentions(c.replies) } : {}),
  }));
}
