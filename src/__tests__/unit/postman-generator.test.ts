import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PAT_CAPABILITIES, WRITE_TOOLS_BY_CAPABILITY } from '../../capabilities.js';

/**
 * ENG-2833 — the collection generator is code, and it broke a release.
 *
 * `scripts/generate-postman-collection.ts` REGISTERS every tool, resource and
 * prompt against an `ApiClient` to read their names. It held `{} as never`,
 * which was enough until ENG-2816 made the enrolment picker derive its
 * HMAC signing key at REGISTRATION time — the stub answered
 * `api.deriveStateKey is not a function`, and `generated-artifacts` went red
 * on the production elevation, with a human waiting to ship.
 *
 * Nothing tested it. `generate:postman:check` is the only thing that runs it,
 * and that gate lives on the elevation, which is the worst place to discover
 * a registration-time dependency.
 *
 * These cases run the REAL scripts, into a throwaway working directory —
 * both write to `resolve(process.cwd(), 'postman', …)`, so nothing here can
 * touch the committed files. Two properties: the generator survives
 * registration, and its output still equals what is committed.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const tsxCli = join(repoRoot, 'node_modules/tsx/dist/cli.mjs');

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  dir: string;
}

function runGenerator(script: string): Run {
  const dir = mkdtempSync(join(tmpdir(), 'eng2833-'));
  mkdirSync(join(dir, 'postman'));
  const result = spawnSync(
    process.execPath,
    [tsxCli, join(repoRoot, 'scripts', script)],
    { cwd: dir, encoding: 'utf8' },
  );
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    dir,
  };
}

const generated = (run: Run, file: string): string =>
  readFileSync(join(run.dir, 'postman', file), 'utf8');

const committed = (file: string): string =>
  readFileSync(join(repoRoot, 'postman', file), 'utf8');

const COLLECTION = 'mcp-server.postman_collection.json';

describe('the Postman collection generator survives registration', () => {
  const run = runGenerator('generate-postman-collection.ts');

  it('exits zero — a registration-time dependency the stub cannot answer is what broke it', () => {
    expect(run.stderr, run.stderr).not.toMatch(/is not a function/);
    expect(run.code, `${run.stdout}${run.stderr}`).toBe(0);
  });

  it('registers every write family, not just the read floor', () => {
    // ENG-2598: the omitted-options case used to be fail-OPEN and handed back
    // all the tools by accident; ENG-2208 made it an allow-list, and the same
    // call silently produced only the read tools. The script now asks for
    // every family explicitly, and this is what proves it still does.
    const text = generated(run, COLLECTION);
    for (const capability of PAT_CAPABILITIES) {
      for (const tool of WRITE_TOOLS_BY_CAPABILITY[capability]) {
        expect(text, `${tool} (${capability}) missing from the collection`).toContain(
          `\`${tool}\``,
        );
      }
    }
    expect(text).toContain('`list_files`');
  });

  it('splits the resources the way `resources/list` and `templates/list` do', () => {
    // KI-078 / ENG-1381 — a flat ten-name list in the description and a
    // different shape via Load Capabilities is the defect the split fixed.
    expect(run.stdout).toContain('resources=2 static + 8 templates');
    expect(run.stdout).toContain('prompts=4');
  });

  it('reproduces the committed collection byte for byte', () => {
    // The same property `generate:postman:check` asserts, checkable without a
    // dirty working tree — and without waiting for an elevation.
    expect(generated(run, COLLECTION)).toBe(committed(COLLECTION));
  });
});

describe('the Postman environment generator', () => {
  const run = runGenerator('generate-postman-environments.ts');

  it('exits zero and reproduces every committed environment', () => {
    expect(run.code, `${run.stdout}${run.stderr}`).toBe(0);
    for (const file of [
      'local.postman_environment.json',
      'dev.postman_environment.json',
      'staging.postman_environment.json',
      'production.postman_environment.json',
      'public.postman_environment.json',
    ]) {
      expect(generated(run, file), file).toBe(committed(file));
    }
  });

  /**
   * These files are published to the Postman API Network, so a real token
   * committed here is a token published to the internet. The generator emits
   * a placeholder in the public template and an empty string everywhere else;
   * neither may ever become a credential.
   */
  it('carries a placeholder where a credential goes, in every environment', () => {
    for (const file of [
      'local.postman_environment.json',
      'dev.postman_environment.json',
      'staging.postman_environment.json',
      'production.postman_environment.json',
      'public.postman_environment.json',
    ]) {
      const values = (
        JSON.parse(generated(run, file)) as {
          values: Array<{ key: string; value: string }>;
        }
      ).values;
      const credentials = values.filter((v) => /^ROCKHOPPER_PAT$/.test(v.key));
      expect(credentials.length, `${file} names no credential field`).toBeGreaterThan(0);
      for (const v of credentials) {
        expect(['', 'YOUR_PAT_HERE'], `${file} ${v.key}`).toContain(v.value);
      }
      // The shape a real Personal Access Token has, wherever it appears.
      expect(generated(run, file), file).not.toMatch(/rh_pat_/);
    }
  });
});
