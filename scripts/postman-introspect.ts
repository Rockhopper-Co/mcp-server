import { z } from 'zod';
import { registerPrompts } from '../src/prompts/index.js';
import { registerResources } from '../src/resources/index.js';
import { registerTools } from '../src/tools/index.js';

export type SchemaMap = Record<string, z.ZodTypeAny>;

export interface CapturedResource {
  name: string;
  uriOrTemplate: string;
}

class CapturingServer {
  readonly toolNames: string[] = [];

  readonly resources: CapturedResource[] = [];

  readonly promptNames: string[] = [];

  registerTool(name: string, _config: { inputSchema?: SchemaMap }, _handler: unknown): void {
    this.toolNames.push(name);
  }

  registerResource(
    name: string,
    uriOrTemplate: unknown,
    _config: { description?: string },
    _handler: unknown,
  ): void {
    const pattern =
      typeof uriOrTemplate === 'string'
        ? uriOrTemplate
        : ((uriOrTemplate as { uriTemplate?: { toString?: () => string } })
            ?.uriTemplate?.toString?.() ?? String(uriOrTemplate));
    this.resources.push({ name, uriOrTemplate: pattern });
  }

  registerPrompt(
    name: string,
    _config: { argsSchema?: SchemaMap },
    _handler: unknown,
  ): void {
    this.promptNames.push(name);
  }
}

const server = new CapturingServer();
const api = {} as never;

registerTools(server as never, api);
registerResources(server as never, api);
registerPrompts(server as never, api);

export const toolNames = [...server.toolNames].sort();
export const promptNames = [...server.promptNames].sort();

const sortedResources = [...server.resources].sort((a, b) =>
  a.name.localeCompare(b.name),
);

export const staticResources = sortedResources.filter((r) => !r.uriOrTemplate.includes('{'));
export const templateResources = sortedResources.filter((r) =>
  r.uriOrTemplate.includes('{'),
);

export function registrySummaryMarkdown(): string {
  return `**${toolNames.length} tools**: ${toolNames.map((t) => `\`${t}\``).join(', ')}.

**${staticResources.length} static resources** (returned by \`resources/list\`): ${staticResources.map((r) => `\`${r.name}\``).join(', ')}.

**${templateResources.length} URI templates** (returned by \`resources/templates/list\`): ${templateResources.map((r) => `\`${r.uriOrTemplate}\``).join(', ')}.

**${promptNames.length} prompts**: ${promptNames.map((p) => `\`${p}\``).join(', ')}.`;
}
