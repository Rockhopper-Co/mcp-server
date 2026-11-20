/**
 * ENG-8441 — the wire shapes of the ERP record-link routes
 * (`/integrations/erp-links/files/:enrolledFileId`), and the two pure helpers
 * the tools build on: assembling a record key from flat tool arguments, and
 * rendering a file's links with their latest status.
 *
 * The four record kinds and their key fields mirror the backend's
 * `ERP_RECORD_KINDS` and record-key interfaces; the backend re-validates every
 * key, so this is a convenience for a clear refusal, never the authority.
 */

export const ERP_RECORD_KINDS = [
  'billing_batch',
  'lease',
  'expense_participation',
  'property',
] as const;
export type ErpRecordKind = (typeof ERP_RECORD_KINDS)[number];

export type ErpRecordKey = Record<string, string | number>;

/** One link, as `GET .../files/:id` returns it. */
export interface ErpLink {
  linkId: string;
  connectionId: string;
  recordKind: ErpRecordKind;
  recordKey: ErpRecordKey;
  displayLabel: string | null;
  createdAt: string;
  removedAt: string | null;
}

/** One link's latest status, as `GET .../files/:id/status` returns it. */
export interface ErpLinkStatus {
  linkId: string;
  status: string | null;
  meaning: string | null;
  observedAt: string | null;
  source: 'event' | 'ais_read' | null;
}

export interface ErpPage<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export interface CreateErpLinkBody {
  connectionId: string;
  recordKind: ErpRecordKind;
  recordKey: ErpRecordKey;
  displayLabel?: string;
}

/** The flat key arguments a tool accepts, one set per kind. */
export interface ErpKeyArgs {
  batchNumber?: number;
  batchType?: string;
  leaseNumber?: number;
  leaseVersion?: number;
  businessUnit?: string;
  epClass?: string;
}

const KEY_FIELDS: Readonly<Record<ErpRecordKind, (keyof ErpKeyArgs)[]>> = {
  billing_batch: ['batchNumber', 'batchType'],
  lease: ['leaseNumber', 'leaseVersion'],
  expense_participation: ['businessUnit', 'epClass'],
  property: ['businessUnit'],
};

/**
 * The record key for `kind`, or the names of the fields it lacks. Fields
 * that belong to another kind are left out rather than sent.
 */
export function buildRecordKey(
  kind: ErpRecordKind,
  args: ErpKeyArgs,
): { key: ErpRecordKey } | { missing: string[] } {
  const fields = KEY_FIELDS[kind];
  const missing = fields.filter((f) => args[f] === undefined);
  if (missing.length > 0) return { missing };
  const key: ErpRecordKey = {};
  for (const field of fields) {
    const value = args[field];
    if (value !== undefined) key[field] = value;
  }
  return { key };
}

export function describeKey(key: ErpRecordKey): string {
  return Object.entries(key)
    .map(([field, value]) => `${field} ${String(value)}`)
    .join(', ');
}

function describeStatus(status: ErpLinkStatus | undefined): string {
  if (!status?.status) return 'no status seen yet';
  const meaning = status.meaning ? ` (${status.meaning})` : '';
  const via = status.source === 'ais_read' ? 'read' : 'event';
  return `${status.status}${meaning}, seen ${status.observedAt} by ${via}`;
}

/** One line per link, its latest status beside it, joined by link id. */
export function renderErpLinks(
  links: ErpPage<ErpLink>,
  statuses: ErpPage<ErpLinkStatus>,
): string {
  if (links.data.length === 0) {
    return 'This file is not linked to any JD Edwards record.';
  }
  const byId = new Map(statuses.data.map((s) => [s.linkId, s]));
  const lines = links.data.map((link) => {
    const label = link.displayLabel ? `"${link.displayLabel}" ` : '';
    return (
      `- ${label}${link.recordKind}: ${describeKey(link.recordKey)} ` +
      `(linkId: ${link.linkId}, connectionId: ${link.connectionId}) - ` +
      describeStatus(byId.get(link.linkId))
    );
  });
  const more =
    links.total > links.data.length
      ? `\n\nShowing ${links.data.length} of ${links.total} links.`
      : '';
  const head = `${links.total} linked JD Edwards record(s):`;
  return `${head}\n\n${lines.join('\n')}${more}`;
}
