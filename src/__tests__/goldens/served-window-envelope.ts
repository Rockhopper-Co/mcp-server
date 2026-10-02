/**
 * ENG-6058 — the `GET /cell-change-events/document-changes` ENVELOPE as the
 * backend serves it, copied from the backend's own golden.
 *
 * Source: `Rockhopper-Co/backend` `test/e2e/goldens/served-window.golden.json`
 * at `dbd0ee2ff7cbe15bab261dd6466a5b6b40a7c8e2` (origin/dev, 2026-09-23; the
 * file's last change is `f91a52afe46fec9596d51a05192d07918cc55bc1`). The
 * golden is written by `test/e2e/served-window-golden.e2e-spec.ts` from a real
 * served window, and both of its arms serialise the same
 * `DocumentChangesResponseDto` this route returns.
 *
 * WHAT WAS CHANGED IN THE COPY, and only this: `rows` is emptied. This file
 * pins the ENVELOPE's keys, and the rows carry fixture ids this repository is
 * public enough not to need. Every envelope key and value is verbatim.
 *
 * Refresh it by re-copying the two `documentChanges` objects minus their rows
 * and updating the sha above. Never edit a value by hand to make a test pass —
 * the point of the copy is that nobody here wrote it.
 */
export const SERVED_WINDOW_ENVELOPES = {
  powerpoint: {
    declineReason: null,
    nextCursor: null,
    rows: [],
    truncated: false,
    windowStart: '1970-01-01T00:00:00.000Z',
  },
  word: {
    declineReason: null,
    nextCursor: null,
    rows: [],
    truncated: false,
    windowStart: '1970-01-01T00:00:00.000Z',
  },
} as const;
