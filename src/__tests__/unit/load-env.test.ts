import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('loadEnvFiles', () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    process.chdir(originalCwd);
  });

  it('should load variables from a .env file in cwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-env-'));
    writeFileSync(
      join(dir, '.env'),
      'ROCKHOPPER_TOKEN=rh_pat_from_dotenv\nROCKHOPPER_API_URL=http://localhost:3100\n',
    );
    process.chdir(dir);
    vi.stubEnv('ROCKHOPPER_TOKEN', '');
    vi.stubEnv('ROCKHOPPER_API_URL', '');

    const { loadEnvFiles } = await import('../../load-env.js');
    loadEnvFiles();

    expect(process.env.ROCKHOPPER_TOKEN).toBe('rh_pat_from_dotenv');
    expect(process.env.ROCKHOPPER_API_URL).toBe('http://localhost:3100');
  });

  it('should not override variables already set in the environment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-env-'));
    writeFileSync(
      join(dir, '.env'),
      'ROCKHOPPER_TOKEN=rh_pat_from_dotenv\n',
    );
    process.chdir(dir);
    vi.stubEnv('ROCKHOPPER_TOKEN', 'rh_pat_existing');

    const { loadEnvFiles } = await import('../../load-env.js');
    loadEnvFiles();

    expect(process.env.ROCKHOPPER_TOKEN).toBe('rh_pat_existing');
  });
});
