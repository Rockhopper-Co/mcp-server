import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

/**
 * ENG-2807 — the regression fence for the publish pipeline.
 *
 * A publish workflow cannot be rehearsed by merging it, so the shell inside it
 * is the least-tested code in the repository and it is the code that decides
 * what customers receive. The defect this file pins was exactly that: the step
 * that found its version already on the registry printed "Nothing to publish"
 * and exited GREEN. `2.1.1` reached npm, `latest` stayed on `2.1.0`, every
 * `npm install` kept receiving the older package, and nothing anywhere went red.
 *
 * Every test below extracts the REAL `run:` script out of
 * `.github/workflows/publish.yml` BY STEP NAME and executes it. Nothing here
 * re-types the workflow's logic, so a spec that passes while the workflow says
 * something else is not possible — verified by mutation: restoring the green
 * no-op, letting any branch reach `latest`, or publishing package.json's
 * version verbatim each turns this file red.
 *
 * `npm` is shadowed by a shim on PATH for the two registry guards, so these
 * assertions are deterministic and never touch the live registry.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

interface Step {
  name?: string;
  run?: string;
  if?: string;
}
interface Workflow {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, { steps: Step[] }>;
}

const publishSource = readFileSync(join(repoRoot, '.github/workflows/publish.yml'), 'utf8');
const publishWorkflow = load(publishSource) as Workflow;
const ciWorkflow = load(
  readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8'),
) as Workflow;

/**
 * Every `run:` block in the publish job, concatenated. The "must not appear"
 * assertions below run against THIS rather than the raw file, because the file
 * also carries the prose explaining why each of these is forbidden — and a
 * comment saying "there is deliberately no `npm dist-tag add` here" must not
 * read as an `npm dist-tag add`.
 */
const runScripts = publishWorkflow.jobs.publish.steps.map((s) => s.run ?? '').join('\n');

function stepScript(name: string): string {
  const step = publishWorkflow.jobs.publish.steps.find((s) => s.name === name);
  if (!step?.run) {
    throw new Error(
      `publish.yml has no step "${name}" with a run: block. Steps: ${publishWorkflow.jobs.publish.steps
        .map((s) => s.name)
        .join(' | ')}`,
    );
  }
  return step.run;
}

/**
 * A stand-in for the runner. `npm` is shadowed so the registry answer is an
 * input to the test rather than whatever npmjs.com happens to hold today;
 * `node` is not shadowed, because the steps genuinely shell out to it.
 *
 * FAKE_VIEW_VERSION empty means "the registry does not have it" AND the shim
 * exits non-zero, which is also what a network failure looks like — the same
 * shape the guard must fail open on.
 */
function makeTree(pkgVersion: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'eng2807-'));
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: '@rockhopper-co/mcp-server', version: pkgVersion })}\n`,
  );
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const shim = join(bin, 'npm');
  writeFileSync(
    shim,
    [
      '#!/usr/bin/env bash',
      '# $1=view $2=<spec> $3=<field>',
      'case "$3" in',
      '  version) [ -n "${FAKE_VIEW_VERSION:-}" ] || exit 1; printf "%s" "$FAKE_VIEW_VERSION" ;;',
      '  dist-tags.latest) [ -n "${FAKE_LATEST:-}" ] || exit 1; printf "%s" "$FAKE_LATEST" ;;',
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(shim, 0o755);
  return dir;
}

interface StepResult {
  code: number;
  outputs: Record<string, string>;
  log: string;
}

function runStep(name: string, tree: string, env: Record<string, string>): StepResult {
  const outFile = join(tree, 'gh_output');
  writeFileSync(outFile, '');
  const result = spawnSync('bash', ['-c', stepScript(name)], {
    cwd: tree,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(tree, 'bin')}:${process.env.PATH ?? ''}`,
      GITHUB_OUTPUT: outFile,
      ...env,
    },
  });
  const outputs: Record<string, string> = {};
  for (const line of readFileSync(outFile, 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return { code: result.status ?? -1, outputs, log: `${result.stdout}${result.stderr}` };
}

const RESOLVE = 'Resolve version and dist-tag';
const REFUSE_EXISTING = 'Refuse a version the registry already holds';
const REFUSE_BACKWARDS = 'Refuse to move `latest` backwards';
const baseEnv = { GITHUB_SHA: 'abcdef1234567890', GITHUB_RUN_NUMBER: '29' };

describe('publish.yml — the trigger is a merge, never a tag', () => {
  it('fires on merges to main and staging only', () => {
    const push = (publishWorkflow.on as { push: { branches: string[]; tags?: string[] } }).push;
    expect(push.branches).toEqual(['main', 'staging']);
    // A `tags:` filter is the retired hand-cut release path. Nothing may cut or
    // consume a release tag: that is the mechanism that stranded 2.1.1.
    expect(push.tags).toBeUndefined();
    // …and nothing inside the job branches on a tag ref either.
    expect(runScripts).not.toMatch(/refs\/tags/);
  });

  it('never moves a dist-tag, and never asks the registry for write scope it cannot have', () => {
    // Trusted Publishing answers E401 to a dist-tag write and a granular token
    // answers EOTP (ENG-2755). Promotion is unreachable; every channel is a
    // plain publish of a distinct version.
    expect(runScripts).not.toMatch(/dist-tag\s+add/);
    expect(publishWorkflow.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    // A committed .npmrc or a GitHub Packages scope mapping would 404 every
    // customer install of this PUBLIC package.
    expect(publishSource).not.toMatch(/npm\.pkg\.github\.com/);
    expect(publishSource).not.toMatch(/NODE_AUTH_TOKEN/);
    expect(publishSource).not.toMatch(/packages:\s*(read|write)/);
  });

  it('has no step that succeeds when there is nothing to publish', () => {
    const names = publishWorkflow.jobs.publish.steps.map((s) => s.name);
    expect(names).not.toContain('Nothing to publish');
    expect(names).toContain(REFUSE_EXISTING);
  });
});

describe('publish.yml — version derivation', () => {
  it('publishes <major>.<minor>.<run number> to latest on main, ignoring the committed patch', () => {
    const r = runStep(RESOLVE, makeTree('2.1.1'), { ...baseEnv, GITHUB_REF: 'refs/heads/main' });
    expect(r.code).toBe(0);
    expect(r.outputs.version).toBe('2.1.29');
    expect(r.outputs.dist_tag).toBe('latest');
  });

  it('publishes a prerelease off the SAME counter to the staging tag on staging', () => {
    const r = runStep(RESOLVE, makeTree('2.1.1'), { ...baseEnv, GITHUB_REF: 'refs/heads/staging' });
    expect(r.outputs.version).toBe('2.1.29-staging.abcdef1');
    expect(r.outputs.dist_tag).toBe('staging');
  });

  it('refuses to let any ref other than main reach latest', () => {
    for (const ref of ['refs/heads/feat/anything', 'refs/heads/dev', 'refs/heads/mainline']) {
      const r = runStep(RESOLVE, makeTree('2.1.1'), { ...baseEnv, GITHUB_REF: ref });
      expect(r.outputs.dist_tag, ref).toBe('staging');
    }
  });

  it('gives four consecutive run numbers four distinct versions', () => {
    const tree = makeTree('2.1.1');
    const versions = ['29', '30', '31', '32'].map(
      (n) =>
        runStep(RESOLVE, tree, { ...baseEnv, GITHUB_REF: 'refs/heads/main', GITHUB_RUN_NUMBER: n })
          .outputs.version,
    );
    expect(new Set(versions).size).toBe(4);
    expect(versions).toEqual(['2.1.29', '2.1.30', '2.1.31', '2.1.32']);
  });

  it('raises the version on a minor bump at the same run number', () => {
    const r = runStep(RESOLVE, makeTree('2.2.0'), { ...baseEnv, GITHUB_REF: 'refs/heads/main' });
    expect(r.outputs.version).toBe('2.2.29');
  });

  it('prefixes an all-digit leading-zero short sha, which is not valid semver', () => {
    const r = runStep(RESOLVE, makeTree('2.1.1'), {
      ...baseEnv,
      GITHUB_REF: 'refs/heads/staging',
      GITHUB_SHA: '0123456789abcdef',
    });
    expect(r.outputs.version).toBe('2.1.29-staging.g0123456');
  });

  it('refuses a package.json version it cannot derive a publish version from', () => {
    const r = runStep(RESOLVE, makeTree('not-a-version'), {
      ...baseEnv,
      GITHUB_REF: 'refs/heads/main',
    });
    expect(r.code).toBe(1);
    expect(r.log).toContain('::error::');
  });
});

describe('publish.yml — a version already on the registry goes RED', () => {
  const env = { NAME: '@rockhopper-co/mcp-server', VERSION: '2.1.29' };

  it('fails loudly rather than no-opping green', () => {
    const r = runStep(REFUSE_EXISTING, makeTree('2.1.1'), { ...env, FAKE_VIEW_VERSION: '2.1.29' });
    expect(r.code).toBe(1);
    expect(r.log).toContain('::error::');
    expect(r.log).toContain('already on the registry');
  });

  it('passes when the registry does not hold the version — and when it cannot answer at all', () => {
    // These are the SAME signal and deliberately share one test: `npm view`
    // exits non-zero with an empty stdout both for a 404 and for a network
    // failure, so the guard cannot tell them apart and must not try.
    // Continuing is the right answer either way — `npm publish` answers
    // EPUBLISHCONFLICT to a republish, so no path can silently overwrite. This
    // guard names the problem before four minutes of build time are spent; it
    // is not the only thing standing in the way.
    const r = runStep(REFUSE_EXISTING, makeTree('2.1.1'), { ...env, FAKE_VIEW_VERSION: '' });
    expect(r.code).toBe(0);
  });
});

describe('publish.yml — latest never walks backwards', () => {
  const name = '@rockhopper-co/mcp-server';

  it.each([
    ['2.1.29', '2.1.0', 0],
    ['10.0.1', '2.1.0', 0],
    ['2.0.29', '2.1.0', 1],
    ['2.1.0', '2.1.0', 1],
    ['2.1.28', '2.1.29', 1],
  ])('publishing %s while latest is %s exits %i', (version, latest, code) => {
    const r = runStep(REFUSE_BACKWARDS, makeTree('2.1.1'), {
      NAME: name,
      VERSION: version,
      FAKE_LATEST: latest,
    });
    expect(r.code).toBe(code);
  });

  it('allows the first publish when there is no latest yet', () => {
    const r = runStep(REFUSE_BACKWARDS, makeTree('2.1.1'), {
      NAME: name,
      VERSION: '1.0.0',
      FAKE_LATEST: '',
    });
    expect(r.code).toBe(0);
  });
});

describe('the hand-cut release tag is gone from every surface', () => {
  it('ci.yml no longer runs on a push to main and no longer cuts a tag', () => {
    expect(Object.keys(ciWorkflow.on ?? {})).not.toContain('push');
    expect(Object.keys(ciWorkflow.jobs)).not.toContain('auto-tag');
  });

  it('package.json carries no release script that pushes a tag', () => {
    const scripts = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).scripts as Record<
      string,
      string
    >;
    expect(Object.keys(scripts).filter((s) => s.startsWith('release:'))).toEqual([]);
    expect(Object.values(scripts).some((s) => s.includes('git push --tags'))).toBe(false);
  });
});
