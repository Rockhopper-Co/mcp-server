import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

import { ApiClient } from '../../api-client.js';
import { createServer, type CreateServerOptions } from '../../server.js';

/**
 * ENG-6032 — the tool catalogue a client sees, per token scope, as a golden.
 *
 * Captured from the real server over the real protocol (`createServer` →
 * `tools/list` through an in-memory transport), the same path
 * `toolNamesForScope` in `mcp-in-memory.e2e.test.ts` takes. So the input JSON
 * schema is the one the SDK derives from the Zod shape and actually sends,
 * not our reading of the Zod shape.
 *
 * ENG-6069 — each entry also carries the tool's `title` and EVERY annotation
 * the server declares (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
 * `openWorldHint`, and any hint added later). A host decides whether to ask
 * the user before a call from these hints, so flipping one is a behaviour
 * change for every client and must show up as a golden diff. Annotation keys
 * are sorted, so reordering an object literal in source is not drift; an
 * absent title or annotation block records as `null`, never as a missing key.
 *
 * PUBLIC REPO: the golden holds only name, title, description, input schema
 * and annotations — exactly what `tools/list` already hands any client
 * holding a token, and what the published package's `dist` already contains.
 */

/**
 * One entry per token scope the server distinguishes. `read-only` and
 * `read-write` are the coarse `patScope` values; the four `*:write` entries
 * are the ENG-2212 families a token may hold one at a time (`patScopes`).
 * An unrecognised or absent scope resolves to the `read-only` surface — that
 * is asserted by the ENG-2208 e2e, not duplicated here.
 */
export const CATALOGUE_SCOPES: Readonly<Record<string, CreateServerOptions>> = {
  'read-only': { scope: 'read-only' },
  'read-write': { scope: 'read-write' },
  'comments-write': { capabilities: ['comments:write'] },
  'reviews-write': { capabilities: ['reviews:write'] },
  'versions-write': { capabilities: ['versions:write'] },
  'files-write': { capabilities: ['files:write'] },
};

export interface CatalogueEntry {
  name: string;
  title: string | null;
  description: string | null;
  inputSchema: unknown;
  annotations: Record<string, unknown> | null;
}

/** Key-sorted copy (code-unit order), so literal order in source is not drift. */
export function sortedAnnotations(
  annotations: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (annotations === undefined) return null;
  const keys = Object.keys(annotations).sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return Object.fromEntries(keys.map((key) => [key, annotations[key]]));
}

export const GOLDEN_DIR = resolve(__dirname, 'tool-catalogue');

export const goldenPath = (scope: string): string =>
  resolve(GOLDEN_DIR, `${scope}.json`);

/** The fixed serialiser: tools sorted by name, two-space JSON, trailing newline. */
export function serialiseCatalogue(entries: readonly CatalogueEntry[]): string {
  // Code-unit order, not `localeCompare`: host ICU collation must not decide
  // the bytes of a byte-compared golden.
  const sorted = [...entries].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/** `tools/list` for one scope, reduced to the five published fields. */
export async function captureCatalogue(
  options: CreateServerOptions,
): Promise<CatalogueEntry[]> {
  // No handler runs, so no request is made; `api.invalid` cannot resolve if
  // one ever were. Same placeholder the Postman generator uses.
  const api = new ApiClient({
    baseUrl: 'https://api.invalid',
    token: 'tool-catalogue-golden',
  });
  const server = createServer(api, options);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'tool-catalogue-golden', version: '1.0.0' },
    { capabilities: {} },
  );
  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const page = await client.listTools();
    if (page.nextCursor !== undefined) {
      // A second page would be silently dropped from the golden.
      throw new Error('tools/list paginated; the golden reads one page only');
    }
    return page.tools.map((tool) => ({
      name: tool.name,
      title: tool.title ?? null,
      description: tool.description ?? null,
      inputSchema: tool.inputSchema,
      annotations: sortedAnnotations(tool.annotations),
    }));
  } finally {
    await client.close();
  }
}

/** The checked-in golden, or a thrown error naming the file — never a seed. */
export function readGolden(scope: string): string {
  const path = goldenPath(scope);
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(
      `Missing tool-catalogue golden ${path}. Re-record locally with ` +
        '`npm run golden:tool-catalogue:update` and commit the file.',
      { cause: error },
    );
  }
}

/**
 * Re-record is local only. CI sets `CI=true`; a golden written there would
 * make the check compare the server with itself.
 */
export function updateRequested(env: NodeJS.ProcessEnv): boolean {
  if (env.UPDATE_GOLDEN !== '1') return false;
  if (env.CI) {
    throw new Error('UPDATE_GOLDEN=1 is refused under CI: re-record locally');
  }
  return true;
}

export function writeGolden(scope: string, body: string): void {
  mkdirSync(GOLDEN_DIR, { recursive: true });
  writeFileSync(goldenPath(scope), body);
}
