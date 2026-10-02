import type { FileChat } from './types.js';

/**
 * ENG-6435 — the ` [location]` slot every comment renderer prints after the
 * author: the spreadsheet `cellReference` when there is one, otherwise the
 * paragraph, slide or shape the comment is pinned to. One function so
 * `get_file_comments` and the `unresolved-comments` prompt cannot disagree.
 */
export function commentLocation(c: FileChat): string {
  if (c.cellReference) return ` [${c.cellReference}]`;
  const anchor = c.anchor;
  if (!anchor) return '';
  const kind = anchor.anchorKind === 'block' ? 'paragraph' : anchor.anchorKind;
  return anchor.providerAnchorId
    ? ` [${kind} ${anchor.providerAnchorId}]`
    : ` [${kind}]`;
}

/**
 * ENG-6435 — the task pane's PowerPoint lane names slides and shapes in its own
 * `oslide:` / `oshape:` key space (backend
 * `presentation-anchor-id.ts!SHAPE_ID_TAG`), disjoint from the file's
 * `slide:` / `shape:` ids that comments anchor to. The backend checks only the
 * anchor KIND, so such an id would be accepted and pinned to an anchor the web
 * app never shows on the slide. Refused here instead of written misplaced.
 */
export function isTaskPanePresentationId(providerAnchorId: string): boolean {
  return /^oslide:/.test(providerAnchorId);
}
