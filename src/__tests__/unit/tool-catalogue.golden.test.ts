import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  PAT_CAPABILITIES,
  registeredToolsForCapabilities,
  WRITE_TOOLS_BY_CAPABILITY,
} from '../../capabilities.js';
import {
  CATALOGUE_SCOPES,
  type CatalogueEntry,
  captureCatalogue,
  readGolden,
  serialiseCatalogue,
  updateRequested,
  writeGolden,
} from '../goldens/tool-catalogue.js';

/**
 * ENG-6032 — `tools/list` per token scope, byte-compared with a checked-in
 * golden. A renamed tool, a reworded description or a changed input schema
 * fails here and shows the diff; the pull request that re-records the golden
 * is where a reviewer sees the names, descriptions and input schemas every MCP
 * client will now be told. Titles and annotations are NOT in the golden.
 *
 * Re-record locally: `npm run golden:tool-catalogue:update`. Refused under CI.
 * A missing golden FAILS — it is never written by a normal run.
 */

const SCOPES = Object.keys(CATALOGUE_SCOPES);
const UPDATE = updateRequested(process.env);

beforeAll(() => {
  // Capturing the catalogue must not touch the network.
  vi.stubGlobal('fetch', () => {
    throw new Error('tool-catalogue capture issued a request');
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('tool catalogue matches the checked-in golden, per scope', () => {
  it.each(SCOPES)('%s', async (scope) => {
    const emitted = serialiseCatalogue(
      await captureCatalogue(CATALOGUE_SCOPES[scope]),
    );
    if (UPDATE) writeGolden(scope, emitted);
    expect(emitted).toBe(readGolden(scope));
  });
});

describe('each golden holds the tools its scope grants, by name', () => {
  const namesIn = (scope: string): string[] =>
    (JSON.parse(readGolden(scope)) as CatalogueEntry[])
      .map((entry) => entry.name)
      .sort();
  // Read inside each test, so a missing golden fails that test rather than
  // aborting collection of the whole file.
  const readOnly = (): string[] => namesIn('read-only');

  it('read-write is the read floor plus every write family', () => {
    // Registered tools only: a name listed in a family before its registrar
    // lands (PENDING_WRITE_TOOLS) is not on the wire and must not be expected.
    const everyWrite = registeredToolsForCapabilities(PAT_CAPABILITIES);
    expect(namesIn('read-write')).toEqual([...readOnly(), ...everyWrite].sort());
  });

  it.each(PAT_CAPABILITIES)('%s is the read floor plus its own family', (c) => {
    const scope = c.replace(':', '-');
    expect(namesIn(scope)).toEqual(
      [...readOnly(), ...registeredToolsForCapabilities([c])].sort(),
    );
  });

  it('the read floor holds no write tool', () => {
    const everyWrite = new Set(
      PAT_CAPABILITIES.flatMap((c) => WRITE_TOOLS_BY_CAPABILITY[c]),
    );
    const floor = readOnly();
    expect(floor.filter((name) => everyWrite.has(name))).toEqual([]);
    // Paired positive: the floor is not vacuously write-free by being empty.
    expect(floor).toContain('list_files');
  });
});

describe('the golden mechanism cannot self-seed or pass vacuously', () => {
  it('a missing golden throws and names the file', () => {
    expect(() => readGolden('no-such-scope')).toThrow(
      /Missing tool-catalogue golden .*no-such-scope\.json/,
    );
  });

  it('an empty catalogue does not match any golden', () => {
    for (const scope of SCOPES) {
      expect(serialiseCatalogue([])).not.toBe(readGolden(scope));
    }
  });

  it('re-record is off by default and refused under CI', () => {
    expect(updateRequested({})).toBe(false);
    expect(updateRequested({ UPDATE_GOLDEN: '1' })).toBe(true);
    expect(() => updateRequested({ UPDATE_GOLDEN: '1', CI: 'true' })).toThrow(
      /refused under CI/,
    );
  });

  it('serialises in name order whatever order tools arrive in', () => {
    const a = { name: 'a', description: null, inputSchema: {} };
    const b = { name: 'b', description: 'x', inputSchema: {} };
    expect(serialiseCatalogue([b, a])).toBe(serialiseCatalogue([a, b]));
    expect(serialiseCatalogue([a]).endsWith('}\n]\n')).toBe(true);
  });
});
