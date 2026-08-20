import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

/**
 * ENG-2813 — the regression fence for the gateway bump.
 *
 * `bump-gateway.yml` is the downstream half of the deploy that ENG-2796 found
 * missing: a publish reached npm and stopped there, the gateway stayed healthy
 * serving an older package, and every check was green. It cannot be rehearsed
 * before it sits on the default branch — `workflow_run` only fires from there —
 * so the shell inside it is the least-tested code in this repository and it is
 * the code that decides which mcp-server the gateway receives.
 *
 * Every test below extracts the REAL `run:` script out of the workflow BY STEP
 * NAME and executes it, exactly as `publish-workflow.test.ts` does for the
 * publish. Nothing here re-types the workflow's logic, so a spec that passes
 * while the workflow says something else is not possible.
 *
 * `npm` is shadowed by a shim on PATH, so the registry answer is an input to
 * the test rather than whatever npmjs.com holds today.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

interface Step {
  name?: string;
  run?: string;
  if?: string;
}
interface Workflow {
  name?: string;
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, { if?: string; steps: Step[] }>;
}

const bumpPath = join(repoRoot, '.github/workflows/bump-gateway.yml');
const bumpSource = readFileSync(bumpPath, 'utf8');
const bump = load(bumpSource) as Workflow;
const publish = load(
  readFileSync(join(repoRoot, '.github/workflows/publish.yml'), 'utf8'),
) as Workflow;

/**
 * Every `run:` block in the job, concatenated. The "must not appear"
 * assertions run against THIS rather than the raw file, because the file also
 * carries the prose explaining why each is forbidden — and a comment saying
 * "no NODE_AUTH_TOKEN here" must not read as a NODE_AUTH_TOKEN.
 */
const runScripts = bump.jobs.bump.steps.map((s) => s.run ?? '').join('\n');

/**
 * The file with every whole-line comment removed.
 *
 * The "must not appear" assertions run against THIS rather than the raw
 * source, for the same reason `publish-workflow.test.ts` runs them against the
 * concatenated scripts: this workflow carries the prose explaining why GitHub
 * Packages plumbing is forbidden here, and a comment saying "no `packages:
 * read` and no NODE_AUTH_TOKEN" must not read as a `packages: read` and a
 * NODE_AUTH_TOKEN. Whole-line only — nothing in this file puts a directive and
 * a comment on one line, and stripping trailing `#` would corrupt any shell
 * string containing one.
 */
const bumpDirectives = bumpSource
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

function stepScript(name: string): string {
  const step = bump.jobs.bump.steps.find((s) => s.name === name);
  if (!step?.run) {
    throw new Error(
      `bump-gateway.yml has no step "${name}" with a run: block. Steps: ${bump.jobs.bump.steps
        .map((s) => s.name)
        .join(' | ')}`,
    );
  }
  return step.run;
}

/**
 * A stand-in for the runner's checkout of the gateway.
 *
 * `npm view … dist-tags.staging` answers from FAKE_STAGING_SEQ, one
 * comma-separated entry per call, so the CDN lag the immediate path has to
 * survive is expressible: `old,old,new`. An entry that is empty — or a
 * sequence that runs out — exits non-zero with empty stdout, which is what
 * both a missing dist-tag and an unreachable registry look like.
 *
 * `npm install --package-lock-only` writes the pin the shim is told to write,
 * not the one it was asked for, so the manifest guard can be attacked with a
 * caret npm never promised to avoid.
 */
function makeGatewayTree(pinnedVersion: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'eng2813-'));
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name: '@rockhopper-co/mcp-gateway',
        dependencies: { '@rockhopper-co/mcp-server': pinnedVersion },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(dir, 'package-lock.json'), '{}\n');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const shim = join(bin, 'npm');
  writeFileSync(
    shim,
    [
      '#!/usr/bin/env bash',
      'case "$1" in',
      '  view)',
      '    idx_file="$PWD/.view_calls"',
      '    i=$(cat "$idx_file" 2>/dev/null || echo 0)',
      '    echo $((i + 1)) > "$idx_file"',
      '    val=$(printf "%s" "${FAKE_STAGING_SEQ:-}" | cut -d, -f$((i + 1)))',
      '    [ -n "$val" ] || exit 1',
      '    printf "%s" "$val"',
      '    ;;',
      '  install)',
      '    for a in "$@"; do last="$a"; done',
      '    pin="${FAKE_INSTALL_PIN:-${last##*@}}"',
      '    node -e \'const fs=require("fs");const j=JSON.parse(fs.readFileSync("package.json","utf8"));j.dependencies["@rockhopper-co/mcp-server"]=process.argv[1];fs.writeFileSync("package.json",JSON.stringify(j,null,2)+"\\n");fs.writeFileSync("package-lock.json",JSON.stringify({pin:process.argv[1]})+"\\n");\' "$pin"',
      '    ;;',
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

const CREDENTIAL = 'Refuse to run without the package-sync credential';
const RESOLVE = 'Resolve the published staging version';
const MOVE_PIN = 'Move the pin and the lockfile together';
const PENDING = 'Is a bump actually pending';

const OLD = '2.1.1-staging.2786a25';
const NEW = '2.1.30-staging.368e439';
// The retry is exercised without ten real sleeps; see the step's own comment.
const fastPoll = { POLL_ATTEMPTS: '3', POLL_SLEEP: '0' };

describe('bump-gateway.yml — a publish reaches the gateway immediately', () => {
  it('fires on the publish workflow finishing, naming it exactly as publish.yml names itself', () => {
    const workflowRun = (bump.on as { workflow_run: { workflows: string[]; types: string[] } })
      .workflow_run;
    // THE COUPLING. `workflow_run` matches on the publisher's `name:` string,
    // so renaming publish.yml silently stops this from ever firing again — the
    // same silent stall as ENG-2796. This is the only place that link is
    // checkable without merging both files to the default branch.
    expect(workflowRun.workflows).toEqual([publish.name]);
    expect(publish.name).toBe('Publish to npm');
    expect(workflowRun.types).toEqual(['completed']);
  });

  it('keeps the daily cron as the backstop', () => {
    // Requirement 3 of the ticket, and not redundant: the cron is what catches
    // the day the trigger stops firing. Deleting it swaps a guaranteed daily
    // catch-up for a silent stall.
    const schedule = (bump.on as { schedule: { cron: string }[] }).schedule;
    expect(schedule).toEqual([{ cron: '45 13 * * *' }]);
    expect(bump.on).toHaveProperty('workflow_dispatch');
  });

  it('adds no CI to a dev branch', () => {
    // CI runs on prod elevations only, deliberately (David, 2026-07-31 — the
    // Actions allowance was exhausted, not merely strained).
    expect(Object.keys(bump.on ?? {}).sort()).toEqual([
      'schedule',
      'workflow_dispatch',
      'workflow_run',
    ]);
  });

  it('runs only after a SUCCESSFUL staging publish, and always on the cron', () => {
    const guard = bump.jobs.bump.if ?? '';
    expect(guard).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(guard).toContain("github.event.workflow_run.head_branch == 'staging'");
    // …and the pairing that stops the guard being a blanket refusal: the cron
    // and a dispatch carry no workflow_run payload and must still run.
    expect(guard).toContain("github.event_name != 'workflow_run'");
  });

  it('coalesces ten promotions into one run instead of queueing ten', () => {
    expect(bump.concurrency).toEqual({ group: 'bump-gateway', 'cancel-in-progress': true });
  });
});

describe('bump-gateway.yml — the package is PUBLIC npm, and stays that way', () => {
  it('carries no GitHub Packages plumbing anywhere', () => {
    // Copying the frontend original's `packages: read` + NODE_AUTH_TOKEN here
    // would map the @rockhopper-co scope to npm.pkg.github.com and 404 every
    // install: this package is public and neither repo commits an .npmrc.
    expect(bumpDirectives).not.toMatch(/npm\.pkg\.github\.com/);
    expect(bumpDirectives).not.toMatch(/NODE_AUTH_TOKEN/);
    expect(bumpDirectives).not.toMatch(/packages:\s*(read|write)/);
    expect(runScripts).not.toMatch(/\.npmrc/);
    expect(bump.permissions).toEqual({ contents: 'read' });
  });

  it('opens its pull request into the gateway, never merges it, and never publishes', () => {
    expect(runScripts).toContain('--repo Rockhopper-Co/mcp-gateway --base dev');
    expect(runScripts).not.toMatch(/gh pr merge/);
    expect(runScripts).not.toMatch(/npm publish/);
    expect(runScripts).not.toMatch(/dist-tag\s+add/);
  });
});

describe('the credential preflight fails loudly and names what is missing', () => {
  it('names both secrets when neither is set', () => {
    const r = runStep(CREDENTIAL, makeGatewayTree(OLD), { APP_ID: '', PRIVATE_KEY: '' });
    expect(r.code).toBe(1);
    expect(r.log).toContain('::error::');
    expect(r.log).toContain('PACKAGE_SYNC_APP_ID');
    expect(r.log).toContain('PACKAGE_SYNC_PRIVATE_KEY');
  });

  it('names only the one that is missing', () => {
    const r = runStep(CREDENTIAL, makeGatewayTree(OLD), { APP_ID: '123', PRIVATE_KEY: '' });
    expect(r.code).toBe(1);
    expect(r.log).toContain('PACKAGE_SYNC_PRIVATE_KEY');
    expect(r.log).not.toContain(' PACKAGE_SYNC_APP_ID');
  });

  it('passes when both are present — the refusal is not unconditional', () => {
    const r = runStep(CREDENTIAL, makeGatewayTree(OLD), { APP_ID: '123', PRIVATE_KEY: 'pem' });
    expect(r.code).toBe(0);
  });

  it('never echoes a secret value', () => {
    const r = runStep(CREDENTIAL, makeGatewayTree(OLD), {
      APP_ID: 'app-id-9999',
      PRIVATE_KEY: 'BEGIN-PRIVATE-KEY-material',
    });
    expect(r.log).not.toContain('app-id-9999');
    expect(r.log).not.toContain('BEGIN-PRIVATE-KEY-material');
  });
});

describe('resolving the staging dist-tag', () => {
  it('takes the published version on the cron path with a single read', () => {
    const tree = makeGatewayTree(OLD);
    const r = runStep(RESOLVE, tree, { EXPECT_CHANGE: 'false', FAKE_STAGING_SEQ: NEW });
    expect(r.code).toBe(0);
    expect(r.outputs.version).toBe(NEW);
    expect(readFileSync(join(tree, '.view_calls'), 'utf8').trim()).toBe('1');
  });

  it('refuses an absent staging dist-tag rather than silently resolving latest', () => {
    // `npm install pkg@` with an empty version resolves `latest`, which would
    // walk a STABLE version into the gateway's dev under the banner of a
    // staging bump.
    const r = runStep(RESOLVE, makeGatewayTree(OLD), {
      EXPECT_CHANGE: 'false',
      FAKE_STAGING_SEQ: '',
    });
    expect(r.code).toBe(1);
    expect(r.log).toContain('::error::');
    expect(r.outputs.version).toBeUndefined();
  });

  it('refuses an unreachable registry too — silence is not a measurement', () => {
    const r = runStep(RESOLVE, makeGatewayTree(OLD), { ...fastPoll, EXPECT_CHANGE: 'true' });
    expect(r.code).toBe(1);
    expect(r.log).toContain('::error::');
  });

  it('waits out registry propagation on the immediate path', () => {
    // The race the daily cron never had: `workflow_run` fires the instant the
    // publish job ends, and npm's read path can still be answering the old
    // dist-tag. Without the wait this resolves the version already pinned,
    // finds nothing pending and exits green — a silent stall.
    const tree = makeGatewayTree(OLD);
    const r = runStep(RESOLVE, tree, {
      ...fastPoll,
      EXPECT_CHANGE: 'true',
      FAKE_STAGING_SEQ: `${OLD},${OLD},${NEW}`,
    });
    expect(r.code).toBe(0);
    expect(r.outputs.version).toBe(NEW);
    expect(readFileSync(join(tree, '.view_calls'), 'utf8').trim()).toBe('3');
    expect(r.log).not.toContain('::warning::');
  });

  it('warns, rather than lying, when a publish completed and the tag never moved', () => {
    const r = runStep(RESOLVE, makeGatewayTree(OLD), {
      ...fastPoll,
      EXPECT_CHANGE: 'true',
      FAKE_STAGING_SEQ: `${OLD},${OLD},${OLD}`,
    });
    expect(r.code).toBe(0);
    expect(r.outputs.version).toBe(OLD);
    expect(r.log).toContain('::warning::');
  });

  it('does NOT warn on the cron when nothing has changed — that is the steady state', () => {
    // The pairing for the warning above. A warning on every quiet cron run is
    // noise, and noise is how a real one gets ignored.
    const r = runStep(RESOLVE, makeGatewayTree(OLD), {
      EXPECT_CHANGE: 'false',
      FAKE_STAGING_SEQ: OLD,
    });
    expect(r.code).toBe(0);
    expect(r.outputs.version).toBe(OLD);
    expect(r.log).not.toContain('::warning::');
  });
});

describe('the exact pin is load-bearing', () => {
  it('writes the published version into the manifest and the lockfile together', () => {
    const tree = makeGatewayTree(OLD);
    const r = runStep(MOVE_PIN, tree, { V: NEW });
    expect(r.code).toBe(0);
    const pkg = JSON.parse(readFileSync(join(tree, 'package.json'), 'utf8'));
    expect(pkg.dependencies['@rockhopper-co/mcp-server']).toBe(NEW);
    expect(JSON.parse(readFileSync(join(tree, 'package-lock.json'), 'utf8')).pin).toBe(NEW);
  });

  it('refuses a caret, which matches only prereleases of one patch and is not the slack it looks like', () => {
    const r = runStep(MOVE_PIN, makeGatewayTree(OLD), { V: NEW, FAKE_INSTALL_PIN: `^${NEW}` });
    expect(r.code).toBe(1);
    expect(r.log).toContain('::error::');
    expect(r.log).toContain('range shape');
  });

  it('refuses a pin that is not the version it resolved', () => {
    const r = runStep(MOVE_PIN, makeGatewayTree(OLD), { V: NEW, FAKE_INSTALL_PIN: OLD });
    expect(r.code).toBe(1);
    expect(r.log).toContain('::error::');
  });
});

describe('nothing is pushed when nothing changed', () => {
  function gitTree(pinned: string): string {
    const tree = makeGatewayTree(pinned);
    for (const args of [
      ['init', '-q'],
      ['config', 'user.email', 't@example.com'],
      ['config', 'user.name', 'test'],
      ['add', 'package.json', 'package-lock.json'],
      ['commit', '-q', '-m', 'base'],
    ]) {
      spawnSync('git', args, { cwd: tree });
    }
    return tree;
  }

  it('reports changed=false on an untouched tree', () => {
    const r = runStep(PENDING, gitTree(OLD), {});
    expect(r.code).toBe(0);
    expect(r.outputs.changed).toBe('false');
  });

  it('reports changed=true once the pin has moved — the check is not always false', () => {
    const tree = gitTree(OLD);
    runStep(MOVE_PIN, tree, { V: NEW });
    const r = runStep(PENDING, tree, {});
    expect(r.outputs.changed).toBe('true');
  });

  it('gates every mutating step on that flag', () => {
    const gated = bump.jobs.bump.steps.filter((s) =>
      /Install proof|Run proof|Push the single bump branch|Open the pull request/.test(s.name ?? ''),
    );
    expect(gated).toHaveLength(4);
    for (const step of gated) {
      expect(step.if, step.name).toBe("steps.pending.outputs.changed == 'true'");
    }
  });

  it('proves the install and the run BEFORE the branch is pushed', () => {
    // A bump that does not install, or does not run, is worse than no bump:
    // it looks like progress. Order is the whole guarantee.
    const names = bump.jobs.bump.steps.map((s) => s.name ?? '');
    const at = (fragment: string) => names.findIndex((n) => n.includes(fragment));
    expect(at('Install proof')).toBeLessThan(at('Push the single bump branch'));
    expect(at('Run proof')).toBeLessThan(at('Push the single bump branch'));
    expect(at('Push the single bump branch')).toBeLessThan(at('Open the pull request'));
  });
});

/**
 * ENG-2844 — the daily cron is the backstop for the day `workflow_run` stops
 * firing, and until now its success said nothing.
 *
 * When the publish-driven run already opened the pull request, the cron
 * re-derives the same pin, commits a byte-identical tree and force-pushes it
 * over the open branch. A run that CAUGHT a stall and a run that caught
 * nothing produced the same green log and the same push, so the day the
 * trigger broke looked exactly like every other day — and the reset commit
 * date is what made SP06 read a 14h15m latency as 9h46m.
 *
 * These tests execute the REAL push step against a temporary repository with a
 * bare remote, the same way every other test here executes the real script.
 */
describe('the backstop reports whether it caught anything (ENG-2844)', () => {
  const PUSH = 'Push the single bump branch';

  function bareRemote(): string {
    const remote = mkdtempSync(join(tmpdir(), 'eng2844-remote-'));
    spawnSync('git', ['init', '-q', '--bare', '-b', 'dev', remote]);
    return remote;
  }

  /**
   * A fresh runner checkout of the gateway's `dev`, wired to `remote`.
   *
   * Each workflow run gets a brand-new clone, so the two runs below are two
   * INDEPENDENT trees pointing at one remote — which is the only shape in
   * which the redundant-push bug is reproducible.
   */
  function checkout(remote: string, pinned: string): string {
    const tree = makeGatewayTree(pinned);
    for (const args of [
      ['init', '-q', '-b', 'dev'],
      ['config', 'user.email', 't@example.com'],
      ['config', 'user.name', 'test'],
      ['remote', 'add', 'origin', remote],
      ['add', 'package.json', 'package-lock.json'],
      ['commit', '-q', '-m', 'base'],
    ]) {
      spawnSync('git', args, { cwd: tree });
    }
    return tree;
  }

  /** The bump branch's sha on the remote, or '' when it does not exist. */
  function remoteTip(remote: string): string {
    const r = spawnSync('git', ['--git-dir', remote, 'rev-parse', 'chore/mcp-server-sync'], {
      encoding: 'utf8',
    });
    return r.status === 0 ? r.stdout.trim() : '';
  }

  const pushEnv = (v: string) => ({ V: v, SLUG: 'package-sync' });

  it('pushes when the remote has no bump branch yet — the skip is not unconditional', () => {
    const remote = bareRemote();
    const tree = checkout(remote, OLD);
    runStep(MOVE_PIN, tree, { V: NEW });

    const r = runStep(PUSH, tree, pushEnv(NEW));
    expect(r.code).toBe(0);
    expect(r.log).toContain('CAUGHT A PENDING BUMP');
    expect(remoteTip(remote)).not.toBe('');
  });

  it('does NOT re-push when the open branch already carries this exact tree', () => {
    const remote = bareRemote();

    // Run 1 — the publish-driven trigger. Opens the branch.
    const first = checkout(remote, OLD);
    runStep(MOVE_PIN, first, { V: NEW });
    expect(runStep(PUSH, first, pushEnv(NEW)).code).toBe(0);
    const afterTrigger = remoteTip(remote);
    expect(afterTrigger).not.toBe('');

    // Run 2 — the cron, hours later, on a fresh checkout. Same published
    // version, same `dev`, so the same tree.
    const second = checkout(remote, OLD);
    runStep(MOVE_PIN, second, { V: NEW });
    const r = runStep(PUSH, second, pushEnv(NEW));

    expect(r.code).toBe(0);
    // THE ASSERTION IS ON STATE FIRST, not on the message: the branch the pull
    // request points at is untouched, so its commit date still records when
    // the bump was proposed. Ordered ahead of the log check so that reverting
    // the workflow reds THIS line, not a string comparison.
    expect(remoteTip(remote)).toBe(afterTrigger);
    expect(r.log).toContain('CAUGHT NOTHING');
  });

  it('still pushes when the published version has moved on', () => {
    const remote = bareRemote();
    const first = checkout(remote, OLD);
    runStep(MOVE_PIN, first, { V: NEW });
    runStep(PUSH, first, pushEnv(NEW));
    const afterTrigger = remoteTip(remote);

    const NEWER = '2.1.31-staging.9f3ac21';
    const second = checkout(remote, OLD);
    runStep(MOVE_PIN, second, { V: NEWER });
    const r = runStep(PUSH, second, pushEnv(NEWER));

    expect(r.code).toBe(0);
    expect(r.log).toContain('CAUGHT A PENDING BUMP');
    expect(remoteTip(remote)).not.toBe(afterTrigger);
  });

  it('leaves the pull-request step to run either way', () => {
    // The skip is an `exit 0` inside the push step, not a job-level gate, so
    // an open pull request is still refreshed and a missing one is still
    // created on a run that pushed nothing.
    const names = bump.jobs.bump.steps.map((s) => s.name ?? '');
    expect(names).toContain('Open the pull request, or update the one already open');
    const prStep = bump.jobs.bump.steps.find((s) =>
      (s.name ?? '').startsWith('Open the pull request'),
    );
    expect(prStep?.if).toBe("steps.pending.outputs.changed == 'true'");
  });
});
