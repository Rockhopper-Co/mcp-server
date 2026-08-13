import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/server';

/**
 * ENG-2175 — the package is on the v2 MCP SDK.
 *
 * v2 is a package SPLIT, not a version bump: `@modelcontextprotocol/sdk`
 * stays on the v1 line (1.30.0) forever, and v2 ships as
 * `@modelcontextprotocol/{core,server,client,node}`. So "are we on v2" is a
 * question about WHICH PACKAGE is depended on, not about a version range.
 */
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const pkg = JSON.parse(
  readFileSync(resolve(projectRoot, 'package.json'), 'utf8'),
) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  engines: { node: string };
};

describe('MCP SDK v2 surface', () => {
  it('depends on the v2 split packages, not the v1 umbrella package', () => {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(deps)).toContain('@modelcontextprotocol/server');
    expect(Object.keys(deps)).toContain('@modelcontextprotocol/client');
    expect(Object.keys(deps)).not.toContain('@modelcontextprotocol/sdk');
  });

  it('has no source file importing the v1 umbrella package', () => {
    // Read the tracked tree, not a grep exit code: `git grep` exits 1 on "no
    // match", which is indistinguishable from a grep that never ran. Asserting
    // the corpus is non-empty first makes an empty scan impossible to pass.
    const tracked = execFileSync('git', ['ls-files', '--', 'src'], {
      cwd: projectRoot,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter((f) => /\.tsx?$/.test(f));
    expect(tracked.length).toBeGreaterThan(50);

    const importers = tracked.filter((f) =>
      readFileSync(resolve(projectRoot, f), 'utf8').includes(
        '@modelcontextprotocol/sdk',
      ),
    );
    expect(importers).toEqual([]);
  });

  it('declares the Node floor the v2 packages require', () => {
    // Every v2 package sets `engines.node: ">=20"`. A published package that
    // still advertises >=18 lies to consumers about where it runs.
    expect(pkg.engines.node).toBe('>=20.0.0');
  });

  it('still serves 2025-11-25 — being on v2 is not the 2026-07-28 revision', () => {
    expect(LATEST_PROTOCOL_VERSION).toBe('2025-11-25');
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain('2025-11-25');
    expect(SUPPORTED_PROTOCOL_VERSIONS).not.toContain('2026-07-28');
  });
});
