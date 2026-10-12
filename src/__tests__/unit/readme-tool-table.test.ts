import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ApiClient } from '../../api-client.js';
import { PAT_CAPABILITIES } from '../../capabilities.js';
import { registerTools } from '../../tools/index.js';

/**
 * ENG-5878 — the README ships in the npm package, and its tool tables are the
 * first list a customer reads. They drifted: they named `update_file_description`
 * months after ENG-1439 renamed it `rename_file`, and omitted every tool added
 * since. This pins the README's tables to the names the registrars actually
 * register, driven the same network-free way as `generate:postman`
 * (see generated-artifacts.test.ts, ENG-2833).
 *
 * Compares by IDENTITY in both directions, never by count: a README that drops
 * one tool and adds a stale one has the right length and the wrong contents.
 */

const README = resolve(__dirname, '../../../README.md');

/** Every name the registrars register with every write family granted. */
function registeredToolNames(): string[] {
  const names: string[] = [];
  const server = {
    registerTool(name: string) {
      names.push(name);
    },
  };
  registerTools(
    server as never,
    new ApiClient({ baseUrl: 'https://api.invalid', token: 'readme-tool-table' }),
    { capabilities: PAT_CAPABILITIES },
  );
  return names;
}

/**
 * The tool names in the first column of every table under a `## … Tools`
 * heading. Other sections (resources, prompts, env vars) are excluded so a
 * backticked name there is not mistaken for a tool row.
 */
function readmeToolNames(markdown: string): string[] {
  const names: string[] = [];
  let inToolSection = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('## ')) {
      inToolSection = /\bTools\b/.test(line);
      continue;
    }
    if (!inToolSection) continue;
    const row = /^\|\s*`([a-z_]+)`\s*\|/.exec(line);
    if (row) names.push(row[1]);
  }
  return names;
}

describe('README tool tables match the registered tools (ENG-5878)', () => {
  const registered = registeredToolNames();
  const documented = readmeToolNames(readFileSync(README, 'utf8'));

  it('drives the registrars and reads the README to a non-empty set', () => {
    // Positive control: an empty side would make the identity checks vacuous.
    expect(registered).toContain('rename_file');
    expect(documented).toContain('list_files');
  });

  it('documents every registered tool', () => {
    expect(registered.filter((n) => !documented.includes(n))).toEqual([]);
  });

  it('documents no tool that is not registered', () => {
    expect(documented.filter((n) => !registered.includes(n))).toEqual([]);
  });

  it('documents each tool once', () => {
    expect(documented.filter((n, i) => documented.indexOf(n) !== i)).toEqual([]);
  });
});
