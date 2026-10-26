import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { REQUIRED_TOOL_HINTS } from '../../tools/tool-annotations.js';
import {
  CATALOGUE_SCOPES,
  type CatalogueEntry,
  captureCatalogue,
} from '../goldens/tool-catalogue.js';

/**
 * ENG-8021 — every tool, in every catalogue the server builds, states
 * `readOnlyHint`, `destructiveHint` and `openWorldHint` as booleans. OpenAI's
 * connector review rejects a tool that leaves any of the three to a default.
 *
 * Read off the real `tools/list` (the same capture the goldens use), not off
 * the source, so a registration that skips the `ToolAnnotations` type is
 * still caught. Failures name the tool and the key, never a count.
 */

/** `<tool>.<hint>` for every required hint that is not a boolean. */
function missingHints(entries: readonly CatalogueEntry[]): string[] {
  return entries.flatMap((entry) =>
    REQUIRED_TOOL_HINTS.filter(
      (hint) => typeof entry.annotations?.[hint] !== 'boolean',
    ).map((hint) => `${entry.name}.${hint}`),
  );
}

const SCOPES = Object.keys(CATALOGUE_SCOPES);

beforeAll(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('tool-annotations capture issued a request');
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('every tool states all three safety hints as booleans', () => {
  it.each(SCOPES)('%s', async (scope) => {
    const entries = await captureCatalogue(CATALOGUE_SCOPES[scope]);
    // Positive control: the check enumerated real tools, so an empty
    // catalogue cannot pass it vacuously.
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.map((e) => e.name)).toContain('list_files');
    expect(missingHints(entries)).toEqual([]);
  });

  it('covers every write family, so no write tool escapes the check', async () => {
    const names = (await captureCatalogue(CATALOGUE_SCOPES['read-write'])).map(
      (e) => e.name,
    );
    for (const name of [
      'add_comment',
      'create_review_request',
      'discard_changes',
      'enroll_file',
      'rename_file',
    ]) {
      expect(names, name).toContain(name);
    }
  });
});

describe('missingHints names the tool and the key it lacks', () => {
  const full = {
    name: 'complete',
    title: null,
    description: null,
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  };

  it('passes a tool that states all three', () => {
    expect(missingHints([full])).toEqual([]);
  });

  it('names each absent, non-boolean or missing-block hint', () => {
    const noOpenWorld = {
      ...full,
      name: 'no_open_world',
      annotations: { readOnlyHint: true, destructiveHint: false },
    };
    const stringHint = {
      ...full,
      name: 'string_hint',
      annotations: { ...full.annotations, destructiveHint: 'false' },
    };
    const noBlock = { ...full, name: 'no_block', annotations: null };
    expect(missingHints([full, noOpenWorld, stringHint, noBlock])).toEqual([
      'no_open_world.openWorldHint',
      'string_hint.destructiveHint',
      'no_block.readOnlyHint',
      'no_block.destructiveHint',
      'no_block.openWorldHint',
    ]);
  });
});
