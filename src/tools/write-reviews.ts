import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ApiClient } from '../api-client.js';

/**
 * ENG-2230 — a reviewer id in EITHER spelling: the version-7 uuid, or the
 * legacy numeric internal id.
 *
 * This schema runs on the CUSTOMER'S machine, inside the published tool
 * definition. That is the whole reason this ticket exists: the previous
 * `z.array(z.number().int().positive())` refused a uuid before any request
 * left the process, in all 10 versions published since 0.2.0, so no backend
 * change could rescue it. Both branches are load-bearing — dropping the
 * numeric one would break every customer still on an older version, which is
 * exactly the population the 400-day window exists to protect.
 *
 * The uuid branch deliberately mirrors the BACKEND predicate
 * (`src/common/identifiers/resource-identifier.ts:37`) character for
 * character rather than using zod's `z.uuid()`. Zod refuses a uuid whose
 * version or variant nibble is non-RFC; the backend accepts it on purpose,
 * because "a predicate that refuses on the VERSION nibble makes a row
 * unreachable by its own primary key the moment one value disagrees". A
 * client-side validator stricter than the server is this ticket's own defect
 * in a narrower form — a row the backend would resolve, refused on a machine
 * we cannot redeploy.
 *
 * Existence is settled by the backend lookup, which is authoritative. Shape
 * is settled here, which is not.
 *
 * Both cases are accepted because PostgreSQL normalises uuid case, so `018F…`
 * and `018f…` are the same row. The class is spelled `[0-9a-fA-F]` rather than
 * `[0-9a-f]` with the `/i` flag on purpose: this schema is converted to JSON
 * Schema and advertised in `tools/list`, and JSON Schema `pattern` carries no
 * case-insensitivity flag —
 * an `/i` regex emits a lowercase-only pattern, so a client that pre-validates
 * against the advertised schema would refuse an uppercase uuid that the zod
 * schema and the backend both accept. Writing the class out keeps the
 * advertised contract and the enforced one identical.
 */
const UUID_TEXT =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The refusal text an AI client reads before deciding what to retry with. Zod's
 * default for the string branch is "must match pattern /^[0-9a-f]{8}…/", which
 * names only the branch that failed and hides that a number is equally fine —
 * so it is set on both the branch and the union.
 */
const REVIEWER_ID_ERROR =
  'must be a user id — either a uuid (preferred) or a positive integer internal id';

const reviewerIdSchema = z.union(
  [
    z.number().int().positive(),
    z.string().regex(UUID_TEXT, REVIEWER_ID_ERROR),
  ],
  { error: REVIEWER_ID_ERROR },
);

export function registerWriteReviewTools(
  server: McpServer,
  api: ApiClient,
): void {
  server.registerTool(
    'create_review_request',
    {
      title: 'Create Review Request',
      description:
        'Request a review for a specific file version. Assigns reviewers who ' +
        'will be notified to approve or comment on the version. ' +
        'A reviewer ID is either the user\'s uuid (preferred) or the legacy ' +
        'numeric internal ID — both are accepted. Read either one from the ' +
        'rockhopper://teams/{teamId} resource, which lists each member\'s user ' +
        'record with both an "id" (uuid) and an "internalId" (number); use it to ' +
        'resolve platform IDs (msId / googleId) to a reviewer ID first. ' +
        'The numeric form is accepted until 2027-09-14 and removed after — send the uuid.',
      inputSchema: z.object({
        versionId: z
          .number()
          .describe('Internal ID of the file version to review'),
        subject: z
          .string()
          .min(1)
          .max(500)
          .describe('Subject/title of the review request'),
        description: z
          .string()
          .max(5000)
          .optional()
          .describe('Optional description of what to review'),
        reviewerIds: z
          .array(reviewerIdSchema)
          .min(1)
          .describe(
            'User IDs of the reviewers to assign. Each entry is either the ' +
              "user's uuid (preferred) or the legacy numeric internal ID; the " +
              'two spellings can be mixed in one array. The numeric form is ' +
              'accepted until 2027-09-14 and removed after.',
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ versionId, subject, description, reviewerIds }) => {
      try {
        const review = await api.createReviewRequest({
          versionId,
          subject,
          description,
          reviewerIds,
        });

        return {
          content: [
            {
              type: 'text',
              text:
                `Review request created (id: ${review.id}):\n` +
                `Subject: "${review.subject}"\n` +
                `Status: ${review.status}\n` +
                `Assigned to ${reviewerIds.length} reviewer(s)`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to create review: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'approve_review',
    {
      title: 'Approve Review',
      description:
        'Approve a review request. Only assigned reviewers can approve.',
      inputSchema: z.object({
        reviewId: z.number().describe('ID of the review request to approve'),
        notes: z
          .string()
          .max(5000)
          .optional()
          .describe('Optional approval notes'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ reviewId, notes }) => {
      try {
        const review = await api.approveReview(reviewId, { notes });

        return {
          content: [
            {
              type: 'text',
              text:
                `Review ${review.id} approved.` +
                (notes ? ` Notes: "${notes}"` : ''),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to approve: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'cancel_review',
    {
      title: 'Cancel Review',
      description:
        'Cancel a pending review request. Only the requester can cancel. ' +
        'The review must be in "pending" status — completed or already-cancelled reviews cannot be cancelled.',
      inputSchema: z.object({
        reviewId: z
          .number()
          .describe('ID of the review request to cancel'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async ({ reviewId }) => {
      try {
        const review = await api.getReview(reviewId);
        // Backend's ReviewRequestStatus enum is uppercase (PENDING/APPROVED/CANCELLED).
        // Defensive .toUpperCase() survives future backend casing changes.
        if (review.status?.toUpperCase() !== 'PENDING') {
          return {
            content: [
              {
                type: 'text',
                text: `Review ${reviewId} cannot be cancelled — status is "${review.status}".`,
              },
            ],
            isError: true,
          };
        }

        const cancelled = await api.cancelReview(reviewId);

        return {
          content: [
            {
              type: 'text',
              text:
                `Review ${cancelled.id} cancelled.\n` +
                `Subject: "${cancelled.subject}"`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to cancel review: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
