import type { ApiClient } from '../api-client.js';
import {
  enrolledSheetIds,
  isSmartsheetConnectRequired,
} from '../smartsheet-discovery.js';
import type {
  SmartsheetBrowseItem,
  SmartsheetBrowseParent,
} from '../smartsheet-types.js';
import { smartsheetIdentityLine } from './list-unenrolled-render.js';

/**
 * `list_unenrolled_files` with `provider` "smartsheet": the live browse.
 *
 * The stored list (no `provider`) already carries the Smartsheet sheets the
 * inventory has recorded. This reads the user's own workspaces, folders and
 * sheets live instead, one level at a time, and sets the sheets Rockhopper
 * already holds apart from the ones it does not. A listing that cannot be
 * read is a refusal that says so, never an empty one.
 */

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const text = (body: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text: body }],
  ...(isError ? { isError: true } : {}),
});

const NOT_CONNECTED =
  'This user has no usable Smartsheet connection, so their sheets cannot be ' +
  'listed. Ask them to run `connect_smartsheet`. This is NOT evidence that ' +
  'they have no sheets.';

/** Why the parent arguments cannot be used, or `null`. */
export function smartsheetParentProblem(
  parentType: string | undefined,
  parentId: string | undefined,
): string | null {
  if (parentType !== undefined && !parentId) {
    return 'Send `parentId` with `parentType`: the id of the workspace or folder to open.';
  }
  if (parentType === undefined && parentId) {
    return 'Send `parentType` ("workspace" or "folder") with `parentId`.';
  }
  return null;
}

function containerLine(item: SmartsheetBrowseItem): string {
  const kind = item.kind === 'workspace' ? 'workspace' : 'folder';
  return (
    `- [${kind}] **${item.name}**\n` +
    `  open it with parentType="${kind}", parentId="${item.id}"`
  );
}

function render(
  items: readonly SmartsheetBrowseItem[],
  enrolled: ReadonlyMap<string, string>,
  parent: SmartsheetBrowseParent,
): string {
  const where = parent.parentId
    ? `inside ${parent.parentType} ${parent.parentId}`
    : 'at the top level of the account';
  if (items.length === 0) {
    return (
      `Nothing is visible ${where}. That is an answer about this one ` +
      'location only: other workspaces and folders may hold sheets.'
    );
  }
  const sheets = items.filter((i) => i.kind === 'sheet');
  const containers = items.filter(
    (i) => i.kind === 'workspace' || i.kind === 'folder',
  );
  const untracked = items.filter(
    (i) => i.kind === 'report' || i.kind === 'dashboard',
  );
  const open = sheets.filter((s) => !enrolled.has(s.id));
  const lines = [
    `Read live from Smartsheet just now, ${where}. This is one level of the ` +
      'account, not the whole of it.',
    '',
    open.length
      ? `${open.length} sheet(s) not yet in Rockhopper:`
      : 'No sheets here are missing from Rockhopper.',
    ...open.map((s) => `- **${s.name}**\n${smartsheetIdentityLine(s.id)}`),
  ];
  const added = sheets.length - open.length;
  if (added > 0) {
    lines.push('', `${added} sheet(s) here are already in Rockhopper.`);
  }
  if (containers.length) {
    lines.push(
      '',
      'Open these to look further; sheets inside them are not listed above:',
      ...containers.map(containerLine),
    );
  }
  if (untracked.length) {
    lines.push(
      '',
      `${untracked.length} report(s) or dashboard(s) here are not tracked by ` +
        'Rockhopper and cannot be added.',
    );
  }
  return lines.join('\n');
}

export async function listUnenrolledSmartsheet(
  api: ApiClient,
  parent: SmartsheetBrowseParent,
): Promise<ToolResult> {
  try {
    const [listing, enrolled] = await Promise.all([
      api.browseSmartsheet(parent),
      enrolledSheetIds(api),
    ]);
    return text(render(listing.items, enrolled, parent));
  } catch (error) {
    if (isSmartsheetConnectRequired(error)) return text(NOT_CONNECTED, true);
    return text(
      'Could not list the Smartsheet sheets: ' +
        `${error instanceof Error ? error.message : String(error)}. ` +
        'Nothing about this user\'s sheets is known from this call — do not ' +
        'report that they have none.',
      true,
    );
  }
}
