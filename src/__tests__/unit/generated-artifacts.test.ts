import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiClient } from '../../api-client.js';
import { PAT_CAPABILITIES } from '../../capabilities.js';
import { registerPrompts } from '../../prompts/index.js';
import { registerResources } from '../../resources/index.js';
import { registerTools } from '../../tools/index.js';

/**
 * ENG-2833 — the registration-time contract `generate:postman:check` stands on,
 * which had no test of its own.
 *
 * The check is a build step, not a spec, so nothing in this suite ran the code
 * path it exercises. ENG-2816 then made the enrolment picker derive its
 * signing key AT REGISTRATION (`tools/drive-search.ts` → `createConfirmationCodec`
 * → `api.deriveStateKey`), the generator was still handing the registrars a
 * `{} as never` stub, and the script died with `api.deriveStateKey is not a
 * function` — on the production elevation, with a human waiting.
 *
 * The property is not "the script runs". It is that **every registrar can be
 * driven to completion with only an ApiClient and no network**, which is what
 * makes a generator, a catalogue dump or any future introspection safe to
 * write. So this drives the registrars the way the script does, and separately
 * pins that the script itself constructs a real client rather than a stub that
 * can drift back.
 */

const PROJECT_ROOT = resolve(__dirname, '../../..');
const GENERATOR = resolve(PROJECT_ROOT, 'scripts/generate-postman-collection.ts');

/** The capturing server the generator uses: names only, no handler ever runs. */
function capturingServer() {
  const toolNames: string[] = [];
  const resourceNames: string[] = [];
  const promptNames: string[] = [];
  return {
    toolNames,
    resourceNames,
    promptNames,
    registerTool(name: string) {
      toolNames.push(name);
    },
    registerResource(name: string) {
      resourceNames.push(name);
    },
    registerPrompt(name: string) {
      promptNames.push(name);
    },
  };
}

const realClient = () =>
  new ApiClient({
    baseUrl: 'https://api.invalid',
    token: 'postman-collection-generator',
  });

describe('registration is possible with an ApiClient and nothing else (ENG-2833)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers every family against a real client without throwing', () => {
    const server = capturingServer();
    const api = realClient();

    expect(() => {
      registerTools(server as never, api, { capabilities: PAT_CAPABILITIES });
      registerResources(server as never, api);
      registerPrompts(server as never, api);
    }).not.toThrow();

    // The full surface, not a subset: the omitted-capabilities call used to
    // hand back only the read tools and the committed collection went stale.
    expect(server.toolNames).toHaveLength(22);
    expect(server.toolNames).toContain('search_drive_files');
    expect(server.toolNames).toContain('enroll_file');
    expect(server.resourceNames.length).toBeGreaterThanOrEqual(10);
    expect(server.promptNames).toContain('file-overview');
  });

  /**
   * The exact 2026-08-20 failure, planted. A stub that satisfies the TYPE but
   * not the registration-time call is what the generator carried, and it is
   * what any future "just mock the client" edit would reintroduce.
   */
  it('a client stub missing deriveStateKey fails, which is why the real one is used', () => {
    expect(() =>
      registerTools(capturingServer() as never, {} as never, {
        capabilities: PAT_CAPABILITIES,
      }),
    ).toThrow(/deriveStateKey is not a function/);
  });

  it('registration issues no request — a build step must not need the network', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const server = capturingServer();
    const api = realClient();

    registerTools(server as never, api, { capabilities: PAT_CAPABILITIES });
    registerResources(server as never, api);
    registerPrompts(server as never, api);

    // The placeholder credential in the generator is only safe because of this.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('the generator holds the line the incident drew', () => {
  const source = readFileSync(GENERATOR, 'utf8');

  it('constructs a real ApiClient rather than casting a stub', () => {
    // Paired positive/negative: the scan must find the construction it is
    // asserting on, or it goes vacuously green on a renamed file.
    expect(source).toMatch(/new ApiClient\(/);
    expect(source).not.toMatch(/const api = \{\} as never/);
  });

  it('asks for every write family explicitly, so the collection cannot go stale', () => {
    expect(source).toMatch(/registerTools\([\s\S]{0,120}PAT_CAPABILITIES/);
  });
});
