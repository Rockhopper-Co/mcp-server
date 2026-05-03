import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../api-client.js';

function bumpVersion(
  major: number,
  minor: number,
  patch: number,
  type: 'major' | 'minor' | 'patch',
): { majorVersion: number; minorVersion: number; patchVersion: number } {
  switch (type) {
    case 'major':
      return { majorVersion: major + 1, minorVersion: 0, patchVersion: 0 };
    case 'minor':
      return { majorVersion: major, minorVersion: minor + 1, patchVersion: 0 };
    case 'patch':
      return { majorVersion: major, minorVersion: minor, patchVersion: patch + 1 };
  }
}

export function registerWriteVersionTools(
  server: McpServer,
  api: ApiClient,
): void {
  server.registerTool(
    'create_version',
    {
      title: 'Create Version',
      description:
        'Commit the current uncommitted changes on an enrolled file as a new version. ' +
        'The tool auto-computes the next semver number from the latest committed version. ' +
        'The file must have uncommitted changes (hasUncommittedChanges = true). ' +
        'Use get_file_versions first to confirm uncommitted changes exist.',
      inputSchema: {
        fileMsId: z.string().describe('Platform ID of the enrolled file'),
        versionType: z
          .enum(['major', 'minor', 'patch'])
          .describe('Semver increment type'),
        description: z
          .string()
          .min(1)
          .max(5000)
          .describe('Commit message describing what changed'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ fileMsId, versionType, description }) => {
      try {
        const file = await api.getEnrolledFile(fileMsId);
        if (!file.hasUncommittedChanges) {
          return {
            content: [
              {
                type: 'text',
                text: `File "${file.name}" has no uncommitted changes to commit.`,
              },
            ],
            isError: true,
          };
        }

        const versions = await api.getFileVersions(fileMsId);
        const latest = versions
          .filter((v) => !v.wasDiscarded)
          .sort(
            (a, b) =>
              a.majorVersion !== b.majorVersion
                ? b.majorVersion - a.majorVersion
                : a.minorVersion !== b.minorVersion
                  ? b.minorVersion - a.minorVersion
                  : b.patchVersion - a.patchVersion,
          )[0];

        const base = latest
          ? { major: latest.majorVersion, minor: latest.minorVersion, patch: latest.patchVersion }
          : { major: 0, minor: 0, patch: 0 };

        const next = bumpVersion(base.major, base.minor, base.patch, versionType);

        const version = await api.createVersion({
          enrolledFileMsId: fileMsId,
          version: { ...next, description },
        });

        const tag = `v${version.majorVersion}.${version.minorVersion}.${version.patchVersion}`;
        return {
          content: [
            {
              type: 'text',
              text:
                `Version ${tag} created for "${file.name}".\n` +
                `Description: "${description}"`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to create version: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'discard_changes',
    {
      title: 'Discard Changes',
      description:
        'Discard all uncommitted changes on an enrolled file, reverting it to the latest ' +
        'committed version. This is destructive — the uncommitted edits are lost (though ' +
        'preserved in version history for audit). The file must have uncommitted changes. ' +
        'Cannot discard while other users have the file open.',
      inputSchema: {
        fileMsId: z.string().describe('Platform ID of the enrolled file'),
        description: z
          .string()
          .min(1)
          .max(5000)
          .describe('Reason for discarding changes'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async ({ fileMsId, description }) => {
      try {
        const file = await api.getEnrolledFile(fileMsId);
        if (!file.hasUncommittedChanges) {
          return {
            content: [
              {
                type: 'text',
                text: `File "${file.name}" has no uncommitted changes to discard.`,
              },
            ],
            isError: true,
          };
        }

        await api.discardChanges(fileMsId, { description });

        return {
          content: [
            {
              type: 'text',
              text:
                `Changes discarded for "${file.name}".\n` +
                `Reason: "${description}"`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to discard changes: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
