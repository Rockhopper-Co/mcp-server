import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/server';

const ORCHESTRATION_GUIDE_URI = 'rockhopper://orchestration-guide';

// KI-079 (ENG-1382): static narrative resource that documents tool sequencing,
// identity disambiguation (`fileMsId` vs `versionId` vs `versionInternalId`),
// and lifecycle rules. Loaded once at module init from the sibling .md file;
// the build copies the .md into `dist/resources/` so it ships with the package.
const moduleDir = dirname(fileURLToPath(import.meta.url));
const guideContent = readFileSync(
  join(moduleDir, 'orchestration-guide.md'),
  'utf8',
);

export function registerOrchestrationGuideResource(server: McpServer): void {
  server.registerResource(
    'orchestration-guide',
    ORCHESTRATION_GUIDE_URI,
    {
      title: 'Orchestration Guide',
      description:
        'Narrative reference for sequencing Rockhopper MCP tools correctly — identity types, workflows, review lifecycle, versioning rules, cross-cloud differences.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text: guideContent,
        },
      ],
    }),
  );
}
