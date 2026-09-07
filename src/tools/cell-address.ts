// ENG-4340 — `get_cell_history` advertises "Sheet1!C3" as a valid cellAddress
// and then handed it to the API verbatim, where `cell` is matched as a literal
// string. It matched nothing and the miss rendered as "No history found",
// which is a false negative on a cell that has history. Parse the form the
// tool advertises instead of narrowing the description.

/** A cell reference: 1-3 column letters, then a row, each optionally `$`-anchored. */
const CELL_REF = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})$/;

export type ParsedCellAddress =
  | { ok: true; sheet: string | null; cell: string }
  | { ok: false; reason: string };

/**
 * Split a possibly sheet-qualified address into its sheet and cell parts.
 *
 * Handled: the bare form (`BS11`), the unquoted qualified form
 * (`Project Accruals!BS11`), and the quoted form Excel requires for names
 * carrying spaces or apostrophes (`'My Sheet'!A1`, `'Bob''s Sheet'!A1`).
 * The cell is normalized to the canonical form the API stores — `$` anchors
 * dropped, letters upper-cased — so `$bs$11` stops being a literal-match miss
 * for the same reason the qualified form was one.
 *
 * The split is on the LAST `!` deliberately: Excel forbids `: \ / ? * [ ]` in
 * a sheet name but ALLOWS `!`, while a cell reference can never contain one.
 * Splitting on the last `!` is therefore unambiguous where splitting on the
 * first is not.
 *
 * Deliberately NOT handled, because each is a different question than "which
 * cell did the caller mean" and none is a form this tool advertises:
 *   - cross-workbook references (`[Book1.xlsx]Sheet1!A1`) — the bracketed
 *     workbook stays part of the sheet part, so it is refused loudly by the
 *     sheet-mismatch rule rather than silently mis-parsed;
 *   - ranges (`A1:B2`), whole rows/columns (`1:1`, `A:A`) and named ranges —
 *     this tool answers for ONE cell, so these are refused as malformed;
 *   - R1C1 style (`R1C3`) — refused as malformed; the API speaks A1;
 *   - the true Excel ceiling (XFD / 1048576). The shape check bounds the
 *     column at 3 letters and the row at 7 digits, so `ZZZ9999999` parses and
 *     then simply has no history. That is an honest empty, not a false one.
 */
export function parseCellAddress(input: string): ParsedCellAddress {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: 'the address is empty' };

  const split = trimmed.lastIndexOf('!');
  const rawSheet = split === -1 ? null : trimmed.slice(0, split);
  const rawCell = split === -1 ? trimmed : trimmed.slice(split + 1);

  let sheet: string | null = null;
  if (rawSheet !== null) {
    sheet =
      rawSheet.startsWith("'") && rawSheet.endsWith("'") && rawSheet.length > 1
        ? rawSheet.slice(1, -1).replace(/''/g, "'")
        : rawSheet;
    if (!sheet.trim()) {
      return { ok: false, reason: 'it has a "!" but no sheet name before it' };
    }
  }

  const match = CELL_REF.exec(rawCell);
  if (!match) {
    return {
      ok: false,
      reason: `"${rawCell}" is not a single cell reference like "A1" or "BS11"`,
    };
  }

  return { ok: true, sheet, cell: `${match[1].toUpperCase()}${match[2]}` };
}

/** Excel resolves sheet references case-insensitively; so do we. */
export function sheetNamesAgree(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
