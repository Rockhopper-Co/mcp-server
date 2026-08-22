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
  id?: string;
  run?: string;
  if?: string;
  env?: Record<string, string | number | boolean>;
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
      // ENG-2843 — the two proofs, as inputs to the test rather than as real
      // work. Each one can be made to FAIL on demand, which is the only way to
      // show that a failed proof reaches neither the push nor the merge.
      '  ci)',
      '    if [ "${FAKE_CI_FAIL:-}" = "1" ]; then echo "npm ci: lock file out of sync" >&2; exit 1; fi',
      '    echo "added 215 packages"',
      '    ;;',
      '  run)',
      '    case "$2" in',
      '      typecheck) if [ "${FAKE_TYPECHECK_FAIL:-}" = "1" ]; then exit 1; fi; echo "tsc: 0 errors" ;;',
      '      build)     if [ "${FAKE_BUILD_FAIL:-}" = "1" ]; then exit 1; fi; echo "built" ;;',
      '      *) exit 1 ;;',
      '    esac',
      '    ;;',
      '  test)',
      '    if [ "${FAKE_TEST_FAIL:-}" = "1" ]; then echo "4 failed | 557 passed (561)" >&2; exit 1; fi',
      '    echo "561 passed"',
      '    ;;',
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(shim, 0o755);

  /**
   * A stand-in for GitHub's pull-request API (ENG-2843).
   *
   * Every invocation is appended to `$GH_LOG`, so a test asserts on what the
   * workflow ACTUALLY asked GitHub to do — including the absence of a merge,
   * which is the whole point. `$PR_STATE` lives beside the bare remote rather
   * than in the checkout, because a pull request outlives the run that opened
   * it: that is the shape in which "a proof failed while a mergeable pull
   * request was already open" is reproducible.
   */
  const gh = join(bin, 'gh');
  writeFileSync(
    gh,
    [
      '#!/usr/bin/env bash',
      'args="$*"',
      ': "${GH_LOG:=/dev/null}"',
      'printf "%s\\n" "$args" >> "$GH_LOG"',
      'state="${PR_STATE:-/dev/null}"',
      'num="${FAKE_PR_NUMBER:-206}"',
      'created="${FAKE_PR_CREATED:-2026-08-20T04:17:46Z}"',
      'case "$1 $2" in',
      '  "api /installation/repositories") echo "Rockhopper-Co/mcp-gateway" ;;',
      '  "pr list")',
      '    if [ -s "$state" ]; then',
      '      case "$args" in',
      '        *createdAt*) cat "$state" ;;',
      '        *) cut -d" " -f1 "$state" ;;',
      '      esac',
      '    fi',
      '    ;;',
      '  "pr create")',
      '    printf "%s %s\\n" "$num" "$created" > "$state"',
      '    echo "https://github.com/Rockhopper-Co/mcp-gateway/pull/$num"',
      '    ;;',
      '  "pr edit") ;;',
      '  "pr merge")',
      '    if [ "${FAKE_MERGE_FAIL:-}" = "1" ]; then echo "not mergeable" >&2; exit 1; fi',
      // A merged pull request is no longer open, so the next run's `pr list`
      // must not find it.
      '    : > "$state"',
      '    echo "merged"',
      '    ;;',
      '  *) echo "gh shim: unhandled invocation: $args" >&2; exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(gh, 0o755);
  return dir;
}

/** A bare repository standing in for `Rockhopper-Co/mcp-gateway` on GitHub. */
function bareRemote(): string {
  const remote = mkdtempSync(join(tmpdir(), 'eng2844-remote-'));
  spawnSync('git', ['init', '-q', '--bare', '-b', 'dev', remote]);
  return remote;
}

/**
 * A fresh runner checkout of the gateway's `dev`, wired to `remote`.
 *
 * Each workflow run gets a brand-new clone, so two calls here are two
 * INDEPENDENT trees pointing at one remote — the only shape in which either the
 * redundant-push bug (ENG-2844) or a second run meeting an already-open pull
 * request (ENG-2843) is reproducible.
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

/**
 * ENG-2843 — a deliberately small, deliberately STRICT step sequencer.
 *
 * The invariant this change rests on is an ORDERING one: the merge step cannot
 * be reached unless the install proof and the run proof passed. Ordering is not
 * observable by reading a step's `run:` block in isolation, which is all the
 * helper above can do, and it is not observable by reading the YAML either — a
 * spec that asserts "the merge comes last" proves the file says so, not that a
 * failure stops it. So this runs the JOB: every `run:` step in order, with
 * GitHub's own skip semantics, against a scratch tree with a bare remote and a
 * `gh` that records what it was asked to do.
 *
 * It is strict on purpose. Every `if:` expression and every `${{ }}` it cannot
 * evaluate is a THROWN ERROR rather than a default — an evaluator that quietly
 * treats an unknown condition as true would turn this whole suite into theatre
 * the first time someone writes a condition it has not been taught.
 */
interface JobContext {
  secrets: Record<string, string>;
  github: Record<string, string>;
  steps: Record<string, { outputs: Record<string, string> }>;
}

function lookup(path: string, ctx: JobContext): string {
  const p = path.split('.');
  if (p[0] === 'secrets' && p.length === 2) return ctx.secrets[p[1]] ?? '';
  if (p[0] === 'github' && p.length === 2) return ctx.github[p[1]] ?? '';
  if (p[0] === 'steps' && p[2] === 'outputs' && p.length === 4)
    return ctx.steps[p[1]]?.outputs[p[3]] ?? '';
  throw new Error(
    `bump-gateway.yml uses an expression this harness cannot resolve: "${path}". Teach the harness rather than letting it guess.`,
  );
}

function expand(value: string, ctx: JobContext): string {
  return value.replace(/\$\{\{([^}]*)\}\}/g, (_match, body: string) => {
    const expression = body.trim();
    const comparison = /^([A-Za-z0-9_.-]+)\s*==\s*'([^']*)'$/.exec(expression);
    if (comparison) return String(lookup(comparison[1], ctx) === comparison[2]);
    return lookup(expression, ctx);
  });
}

/**
 * GitHub's rule, reproduced: an `if:` naming no status-check function gets an
 * implicit `success()`, so a step is skipped once an earlier step has failed.
 * The merge step spells `success()` out anyway — redundant to the runner,
 * legible to a reader, and asserted below.
 */
function evaluateIf(expression: string | undefined, ctx: JobContext, jobOk: boolean): boolean {
  const raw = (expression ?? 'success()').trim();
  let ok = true;
  let namesAStatusFunction = false;
  for (const clause of raw.split('&&').map((c) => c.trim())) {
    // `always()` and `failure()` are modelled, and NOT because the workflow
    // uses them — it must not. They are here so the regression this suite
    // exists to catch is expressible: rewriting the merge step's `if` to
    // `always() && …` is exactly "a merge step that runs regardless of the test
    // outcome", and the attack tests below have been run against that mutation
    // and go red on it. A harness that threw on `always()` would red for the
    // wrong reason and prove nothing about the merge.
    if (clause === 'success()' || clause === 'always()' || clause === 'failure()') {
      namesAStatusFunction = true;
      if (clause === 'success()') ok = ok && jobOk;
      if (clause === 'failure()') ok = ok && !jobOk;
      continue;
    }
    const comparison = /^steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)\s*==\s*'([^']*)'$/.exec(
      clause,
    );
    if (!comparison) {
      throw new Error(
        `bump-gateway.yml uses an \`if:\` this harness cannot evaluate: "${clause}". Teach the harness rather than letting it guess.`,
      );
    }
    ok = ok && (ctx.steps[comparison[1]]?.outputs[comparison[2]] ?? '') === comparison[3];
  }
  if (!namesAStatusFunction) ok = ok && jobOk;
  return ok;
}

interface JobResult {
  executed: string[];
  skipped: string[];
  failedAt: string | null;
  log: string;
}

function runJob(
  tree: string,
  extraEnv: Record<string, string>,
  eventName = 'workflow_run',
): JobResult {
  const ctx: JobContext = {
    secrets: { PACKAGE_SYNC_APP_ID: '123', PACKAGE_SYNC_PRIVATE_KEY: 'pem' },
    github: {
      event_name: eventName,
      server_url: 'https://github.com',
      repository: 'Rockhopper-Co/mcp-server',
      run_id: '99',
      repository_owner: 'Rockhopper-Co',
    },
    // The `uses:` steps run no shell. Their outputs are seeded exactly as the
    // runner would have produced them.
    steps: { app: { outputs: { token: 'ghs_fake', 'app-slug': 'package-sync' } } },
  };
  const outFile = join(tree, 'gh_output');
  const executed: string[] = [];
  const skipped: string[] = [];
  let failedAt: string | null = null;
  let log = '';

  for (const step of bump.jobs.bump.steps) {
    if (!step.run) continue;
    const name = step.name ?? '(unnamed)';
    if (!evaluateIf(step.if, ctx, failedAt === null)) {
      skipped.push(name);
      continue;
    }
    writeFileSync(outFile, '');
    const stepEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(step.env ?? {})) {
      stepEnv[key] = expand(String(value), ctx);
    }
    // `bash -e`, because that is the runner's default shell and the run proof
    // relies on it: `npm run typecheck` failing must abort the step rather than
    // fall through to `npm test`.
    const result = spawnSync('bash', ['-e', '-c', step.run], {
      cwd: tree,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(tree, 'bin')}:${process.env.PATH ?? ''}`,
        GITHUB_OUTPUT: outFile,
        ...extraEnv,
        ...stepEnv,
      },
    });
    executed.push(name);
    log += `${result.stdout}${result.stderr}`;
    if (step.id) {
      const outputs = ctx.steps[step.id]?.outputs ?? {};
      for (const line of readFileSync(outFile, 'utf8').split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
      }
      ctx.steps[step.id] = { outputs };
    }
    if ((result.status ?? -1) !== 0 && failedAt === null) failedAt = name;
  }
  return { executed, skipped, failedAt, log };
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

  it('fires on those three events and nothing else', () => {
    // This is a DEPLOY workflow, not a gate: it pushes into another repository
    // and merges. A `pull_request` or `push` trigger here would run that
    // against every branch. (The 2026-07-31 "CI on prod elevations only"
    // budget rule this used to cite was reversed on 2026-08-20 — dev gates are
    // welcome now, and this trigger set is still not one of them.)
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

  it('touches the gateway on `dev` and nowhere else, and never publishes', () => {
    expect(runScripts).toContain('--repo Rockhopper-Co/mcp-gateway --base dev');
    expect(runScripts).not.toMatch(/npm publish/);
    expect(runScripts).not.toMatch(/dist-tag\s+add/);

    // ENG-2843 — it merges now, and SP05's invariant is what bounds the merge:
    // the pin moves on `dev` and only `dev`. A bump landing on `staging`
    // without also being on `dev` makes every subsequent `dev`->`staging`
    // elevation conflict in both package.json and package-lock.json (measured
    // 2026-08-20: `git merge-tree --write-tree` exits 1).
    const bases = runScripts.match(/--base\s+\S+/g) ?? [];
    expect(bases.length).toBeGreaterThan(0);
    expect([...new Set(bases)]).toEqual(['--base dev']);
    expect(runScripts).not.toMatch(/refs\/heads\/(staging|main)/);
    expect(runScripts).not.toMatch(/push\s+(--force\s+)?origin\s+(staging|main)/);
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

/**
 * ENG-2843 — David ruled option B on 2026-08-20: the bump pull request merges
 * itself into the gateway's `dev`, and the `dev`->`staging` elevation stays a
 * human's.
 *
 * THE ONE INVARIANT. The merge must happen only when the proofs passed. GitHub
 * guards it with nothing — measured 2026-08-20,
 * `gh api repos/Rockhopper-Co/mcp-gateway/rules/branches/dev` returns `[]` and
 * both rulesets condition on `refs/heads/main` and `refs/heads/staging` — so
 * the workflow's own ordering is the entire gate. A merge step that ran
 * regardless of the test outcome would be strictly worse than a human who
 * occasionally forgets, because it would look automated and be unguarded.
 *
 * These tests do not read the YAML and conclude. They EXECUTE the job, plant a
 * failing proof, and assert on state: nothing on the remote, and no merge
 * asked of GitHub.
 */
describe('the bump merges itself, and ONLY when the proofs passed (ENG-2843)', () => {
  const MERGE = 'Merge it — the proofs already ran on this exact tree';
  const RUN_PROOF = 'Run proof — typecheck, build and the gateway suite on the bumped tree';
  const INSTALL_PROOF = 'Install proof — strict npm ci on the bumped tree';

  /** Everything the shims need, plus a pull-request store that outlives a run. */
  function env(tree: string, remote: string, seq: string, extra: Record<string, string> = {}) {
    return {
      POLL_ATTEMPTS: '3',
      POLL_SLEEP: '0',
      FAKE_STAGING_SEQ: seq,
      GH_LOG: join(tree, 'gh_log'),
      PR_STATE: join(remote, 'pr_state'),
      ...extra,
    };
  }

  /** What the workflow actually asked GitHub to do, one invocation per line. */
  function ghLog(tree: string): string[] {
    try {
      return readFileSync(join(tree, 'gh_log'), 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  const mergeCall = (tree: string) => ghLog(tree).find((l) => l.startsWith('pr merge'));

  it('merges the pull request it opened, and merges the exact commit it proved', () => {
    const remote = bareRemote();
    const tree = checkout(remote, OLD);

    const r = runJob(tree, env(tree, remote, NEW));

    expect(r.failedAt).toBeNull();
    expect(r.executed).toContain(MERGE);
    expect(remoteTip(remote)).not.toBe('');
    expect(ghLog(tree).find((l) => l.startsWith('pr create'))).toContain('--base dev');
    // `--match-head-commit` is what ties the thing merged to the thing proved.
    // Without it the step would merge whatever the branch happened to carry by
    // the time it ran, which no proof in this job ever saw.
    expect(mergeCall(tree)).toContain('--squash');
    expect(mergeCall(tree)).toContain(`--match-head-commit ${remoteTip(remote)}`);
  });

  it('records hop 4 so the two-minute claim is measured, not predicted', () => {
    const remote = bareRemote();
    const tree = checkout(remote, OLD);
    const r = runJob(tree, env(tree, remote, NEW, { FAKE_PR_CREATED: '2026-08-20T04:17:46Z' }));

    expect(r.log).toMatch(/HOP4 pull request #206 .* opened 2026-08-20T04:17:46Z, merged .* elapsed \d+s/);
  });

  it('ATTACK — a failing gateway suite leaves nothing pushed and nothing merged', () => {
    const remote = bareRemote();
    const tree = checkout(remote, OLD);

    const r = runJob(tree, env(tree, remote, NEW, { FAKE_TEST_FAIL: '1' }));

    expect(r.failedAt).toBe(RUN_PROOF);
    // STATE FIRST. No branch on the remote, so there is no pull request for a
    // human to mistake for a proven bump either.
    expect(remoteTip(remote)).toBe('');
    expect(mergeCall(tree)).toBeUndefined();
    expect(ghLog(tree).some((l) => l.startsWith('pr create'))).toBe(false);
    expect(r.skipped).toEqual(
      expect.arrayContaining([MERGE, 'Push the single bump branch']),
    );
  });

  it('ATTACK — a failing install proof does the same', () => {
    const remote = bareRemote();
    const tree = checkout(remote, OLD);

    const r = runJob(tree, env(tree, remote, NEW, { FAKE_CI_FAIL: '1' }));

    expect(r.failedAt).toBe(INSTALL_PROOF);
    expect(remoteTip(remote)).toBe('');
    expect(mergeCall(tree)).toBeUndefined();
    expect(r.skipped).toContain(MERGE);
  });

  it('ATTACK — a failing typecheck never reaches the suite, the push or the merge', () => {
    const remote = bareRemote();
    const tree = checkout(remote, OLD);

    const r = runJob(tree, env(tree, remote, NEW, { FAKE_TYPECHECK_FAIL: '1' }));

    expect(r.failedAt).toBe(RUN_PROOF);
    expect(remoteTip(remote)).toBe('');
    expect(mergeCall(tree)).toBeUndefined();
  });

  it('ATTACK — a failing proof does not merge a pull request that is ALREADY open', () => {
    // The sharpest case, and the one the ordering argument alone does not
    // cover: a mergeable pull request exists from an earlier run, so "there is
    // nothing to merge" cannot be what saves us. Only the skip does.
    const remote = bareRemote();
    const first = checkout(remote, OLD);
    expect(runJob(first, env(first, remote, NEW, { FAKE_MERGE_FAIL: '1' })).failedAt).toBe(MERGE);
    const openTip = remoteTip(remote);
    expect(openTip).not.toBe('');

    const NEWER = '2.1.31-staging.9f3ac21';
    const second = checkout(remote, OLD);
    const r = runJob(second, env(second, remote, NEWER, { FAKE_TEST_FAIL: '1' }));

    expect(r.failedAt).toBe(RUN_PROOF);
    expect(mergeCall(second)).toBeUndefined();
    // The open pull request is untouched — not merged, and not force-pushed to
    // a tree that failed its proof.
    expect(remoteTip(remote)).toBe(openTip);
  });

  it('the daily backstop still catches a stall — and now finishes it', () => {
    // ENG-2844 must survive option B. A publish-driven run that pushed and
    // opened the pull request but did not complete the merge (a cancelled run,
    // a GitHub hiccup) is exactly the stall the cron exists for.
    const remote = bareRemote();
    const first = checkout(remote, OLD);
    expect(runJob(first, env(first, remote, NEW, { FAKE_MERGE_FAIL: '1' })).failedAt).toBe(MERGE);
    const openTip = remoteTip(remote);

    const second = checkout(remote, OLD);
    const r = runJob(second, env(second, remote, NEW), 'schedule');

    expect(r.failedAt).toBeNull();
    expect(r.log).toContain('CAUGHT NOTHING');
    // The branch is NOT re-pushed, so the commit date still records when the
    // bump was proposed — the evidence SP06's first measurement lost.
    expect(remoteTip(remote)).toBe(openTip);
    // …and the merge still happens, against the REMOTE's sha. Emitting the
    // local one here would refuse every backstop run, which is the failure
    // this pairing exists to catch.
    expect(mergeCall(second)).toContain(`--match-head-commit ${openTip}`);
  });

  it('merges nothing when no bump is pending — the steady state stays quiet', () => {
    const remote = bareRemote();
    const tree = checkout(remote, NEW);
    // The gateway already pins the published version AND its lockfile is in
    // sync, which is what "nothing to do" means in production. Committing the
    // lockfile the install shim would produce is the only way to reach a clean
    // `git diff` here; without it the pin matches, the lockfile does not, and
    // the run is not the steady state it claims to be.
    writeFileSync(join(tree, 'package-lock.json'), `${JSON.stringify({ pin: NEW })}\n`);
    spawnSync('git', ['commit', '-q', '-a', '-m', 'lock'], { cwd: tree });

    const r = runJob(tree, env(tree, remote, NEW), 'schedule');

    expect(r.failedAt).toBeNull();
    expect(r.skipped).toContain(MERGE);
    expect(mergeCall(tree)).toBeUndefined();
    expect(remoteTip(remote)).toBe('');
  });

  it('refuses outright when the push step emitted no proven sha', () => {
    // THE SECOND BARRIER, and it is not decorative. Running the attack above
    // against a workflow whose merge step said `always() && …` showed the step
    // executing — and still refusing, because a skipped push emits no sha and
    // there is then no commit any proof in this job ever saw. The ordering is
    // the gate; this is what holds if someone weakens it.
    const remote = bareRemote();
    const tree = checkout(remote, OLD);
    const r = runStep(MERGE, tree, {
      SHA: '',
      V: NEW,
      GH_LOG: join(tree, 'gh_log'),
      PR_STATE: join(remote, 'pr_state'),
    });
    expect(r.code).toBe(1);
    expect(r.log).toContain('::error::');
    expect(mergeCall(tree)).toBeUndefined();
  });

  it('refuses when there is no open pull request to merge', () => {
    const remote = bareRemote();
    const tree = checkout(remote, OLD);
    const r = runStep(MERGE, tree, {
      SHA: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      V: NEW,
      GH_LOG: join(tree, 'gh_log'),
      PR_STATE: join(remote, 'pr_state'),
    });
    expect(r.code).toBe(1);
    expect(r.log).toContain('Refusing to merge something I cannot see');
    expect(mergeCall(tree)).toBeUndefined();
  });

  it('updates the pull request already open instead of opening a second one', () => {
    // The branch is force-pushed on every publish, so a second `pr create`
    // against the same head is not a duplicate that GitHub refuses — it is a
    // second run finding no open pull request and opening one, which is what
    // a broken `pr list` read looks like. The `// empty` jq fallback in the
    // step exists for exactly this, and nothing asserted the branch it guards.
    const remote = bareRemote();
    const first = checkout(remote, OLD);
    expect(runJob(first, env(first, remote, NEW, { FAKE_MERGE_FAIL: '1' })).failedAt).toBe(MERGE);
    expect(ghLog(first).filter((l) => l.startsWith('pr create'))).toHaveLength(1);

    // The backstop cron, hours later, on a fresh checkout. The pull request
    // from run 1 is still open because its merge failed.
    const second = checkout(remote, OLD);
    runJob(second, env(second, remote, NEW), 'schedule');

    expect(ghLog(second).some((l) => l.startsWith('pr create'))).toBe(false);
    const edit = ghLog(second).find((l) => l.startsWith('pr edit'));
    expect(edit).toContain('206');
    expect(edit).toContain(`chore(deps): pin mcp-server to ${NEW}`);
  });

  it('says in the pull request WHICH trigger opened it', () => {
    // Three ways in, and a reader of the bump pull request cannot otherwise
    // tell a publish-driven run from the cron catching a stall — which is the
    // distinction ENG-2844 exists to make visible.
    const remote = bareRemote();
    const OPEN_PR = 'Open the pull request, or update the one already open';
    const bodyFor = (trigger: string): string => {
      const tree = checkout(remote, OLD);
      const r = runStep(OPEN_PR, tree, {
        TRIGGER: trigger,
        V: NEW,
        RUN_URL: 'https://github.com/Rockhopper-Co/mcp-server/actions/runs/99',
        GH_LOG: join(tree, 'gh_log'),
        PR_STATE: join(tree, 'pr_state'),
      });
      expect(r.code).toBe(0);
      return readFileSync(join(tree, 'gh_log'), 'utf8');
    };

    expect(bodyFor('workflow_run')).toContain('a publish that just finished');
    expect(bodyFor('schedule')).toContain('the daily backstop cron');
    expect(bodyFor('workflow_dispatch')).toContain('a manual dispatch');
  });

  it('spells `success()` out, rather than leaning on GitHub inserting it', () => {
    // Redundant to the runner, not redundant to a reader: the one invariant
    // this change rests on should be visible in the file.
    const step = bump.jobs.bump.steps.find((s) => s.name === MERGE);
    expect(step?.if).toBe("success() && steps.pending.outputs.changed == 'true'");
  });

  it('runs last, after both proofs and after the pull request exists', () => {
    const names = bump.jobs.bump.steps.map((s) => s.name ?? '');
    expect(names[names.length - 1]).toBe(MERGE);
    const at = (fragment: string) => names.findIndex((n) => n.includes(fragment));
    expect(at('Install proof')).toBeLessThan(at(MERGE));
    expect(at('Run proof')).toBeLessThan(at(MERGE));
    expect(at('Open the pull request')).toBeLessThan(at(MERGE));
  });

  it('never asks for GitHub auto-merge, which would merge before anything ran', () => {
    // Measured 2026-08-20: `allow_auto_merge` is false on
    // Rockhopper-Co/mcp-gateway, so `--auto` would error outright — and
    // enabling it is a repository settings change no agent makes. It is also
    // the wrong shape: auto-merge waits for REQUIRED checks and `dev` has
    // none, so it would merge the instant it was asked.
    expect(runScripts).not.toMatch(/gh pr merge[^\n]*--auto/);
    expect(runScripts).not.toMatch(/gh pr merge[^\n]*--admin/);
    expect(runScripts).not.toMatch(/enablePullRequestAutoMerge/);
  });
});
