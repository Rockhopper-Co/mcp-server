import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ApiClient } from '../api-client.js';
import {
  buildRecordKey,
  describeKey,
  ERP_RECORD_KINDS,
  renderErpLinks,
} from '../erp-links.js';
import type { ToolAnnotations } from './tool-annotations.js';

/**
 * ENG-8441 — a file's links to JD Edwards records: list them with their
 * latest status, link one, unlink one. Modelled on `rename_file`
 * (`write-files.ts`): one `fileMsId` argument, the backend's own refusal
 * passed through as the error text.
 *
 * The routes are keyed by the enrolled file's INTERNAL id, so each tool pays
 * one `getEnrolledFile` hop first, as `get_unattributed_changes` does.
 */

type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

const ok = (text: string): ToolResult => ({
  content: [{ type: 'text', text }],
});

const failed = (what: string, error: unknown): ToolResult => {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text', text: `Failed to ${what}: ${reason}` }],
    isError: true,
  };
};

async function internalIdOf(api: ApiClient, fileMsId: string) {
  return (await api.getEnrolledFile(fileMsId)).internalId;
}

/** A fresh schema per use, so no two tool schemas share one instance. */
const fileIdSchema = () =>
  z.string().describe('Platform ID of the enrolled file');

/** Read floor: listing writes nothing and reaches only Rockhopper. */
export function registerListErpLinksTool(
  server: McpServer,
  api: ApiClient,
): void {
  server.registerTool(
    'list_erp_links',
    {
      title: 'List Linked JD Edwards Records',
      description:
        'List the JD Edwards records (billing batches, leases, expense ' +
        'participation calculations, properties) a file is linked to, each ' +
        'with its latest known status and when it was seen. Returns the ' +
        'linkId to pass to unlink_erp_record and the connectionId to reuse ' +
        'with link_erp_record.',
      inputSchema: z.object({ fileMsId: fileIdSchema() }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      } satisfies ToolAnnotations,
    },
    async ({ fileMsId }) => {
      try {
        const id = await internalIdOf(api, fileMsId);
        const [links, statuses] = await Promise.all([
          api.listErpLinks(id),
          api.listErpLinkStatuses(id),
        ]);
        return ok(renderErpLinks(links, statuses));
      } catch (error) {
        return failed('list linked JD Edwards records', error);
      }
    },
  );
}

/** `files:write`, as the backend demands for both routes. */
export function registerErpLinkWriteTools(
  server: McpServer,
  api: ApiClient,
): void {
  server.registerTool(
    'link_erp_record',
    {
      title: 'Link JD Edwards Record',
      description:
        'Link a file to one JD Edwards record through one of the ' +
        "organization's JD Edwards connections. Send the key fields for the " +
        'kind: billing_batch needs batchNumber and batchType; lease needs ' +
        'leaseNumber and leaseVersion; expense_participation needs ' +
        'businessUnit and epClass; property needs businessUnit.',
      inputSchema: z.object({
        fileMsId: fileIdSchema(),
        connectionId: z
          .string()
          .describe(
            'The JD Edwards connection to link through, as list_erp_links ' +
              'shows it or as the organization administrator gives it.',
          ),
        recordKind: z
          .enum(ERP_RECORD_KINDS)
          .describe('Which kind of JD Edwards record to link.'),
        batchNumber: z.number().optional().describe('billing_batch only.'),
        batchType: z.string().optional().describe('billing_batch only.'),
        leaseNumber: z.number().optional().describe('lease only.'),
        leaseVersion: z.number().optional().describe('lease only.'),
        businessUnit: z
          .string()
          .optional()
          .describe('expense_participation and property.'),
        epClass: z
          .string()
          .optional()
          .describe('expense_participation only: the class.'),
        displayLabel: z
          .string()
          .optional()
          .describe('A short label people will see beside the link.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      } satisfies ToolAnnotations,
    },
    async ({ fileMsId, connectionId, recordKind, displayLabel, ...keys }) => {
      const built = buildRecordKey(recordKind, keys);
      if ('missing' in built) {
        return {
          content: [
            {
              type: 'text',
              text:
                `A ${recordKind} link needs ${built.missing.join(' and ')}. ` +
                'Nothing was linked.',
            },
          ],
          isError: true,
        };
      }
      try {
        const id = await internalIdOf(api, fileMsId);
        const link = await api.createErpLink(id, {
          connectionId,
          recordKind,
          recordKey: built.key,
          ...(displayLabel ? { displayLabel } : {}),
        });
        return ok(
          `Linked ${link.recordKind} ${describeKey(link.recordKey)} ` +
            `(linkId: ${link.linkId}).`,
        );
      } catch (error) {
        return failed('link the JD Edwards record', error);
      }
    },
  );

  server.registerTool(
    'unlink_erp_record',
    {
      title: 'Unlink JD Edwards Record',
      description:
        'Remove one JD Edwards record link from a file. The link is kept ' +
        'in the history with who removed it and when, and the record can ' +
        'be linked again with link_erp_record.',
      inputSchema: z.object({
        fileMsId: fileIdSchema(),
        linkId: z.string().describe('The linkId from list_erp_links.'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      } satisfies ToolAnnotations,
    },
    async ({ fileMsId, linkId }) => {
      try {
        const id = await internalIdOf(api, fileMsId);
        const link = await api.removeErpLink(id, linkId);
        return ok(
          `Unlinked ${link.recordKind} ${describeKey(link.recordKey)} ` +
            `(linkId: ${link.linkId}).`,
        );
      } catch (error) {
        return failed('unlink the JD Edwards record', error);
      }
    },
  );
}
