import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createDiagnosticLogger } from '../../logger.js';

// KI-225 — the file-sink edges of `createDiagnosticLogger` the happy-path
// logger.test.ts doesn't reach:
//   - the async `flush()` it returns (logger.ts 137-144), including the
//     swallow-and-resolve branch when the destination's flush throws, and
//   - the construction-failure fallback to the no-op logger (logger.ts 147-150).

const tmpDirs: string[] = [];

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-logger-sink-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

describe('createDiagnosticLogger flush + failure fallback (KI-225)', () => {
  it('resolves async flush() on the happy path and when the destination throws', async () => {
    const dir = mkTmp();
    const { flush, destination } = await createDiagnosticLogger({ dir });
    expect(destination).toBeDefined();

    // Happy path — destination.flush(cb) invokes cb → the promise resolves.
    await expect(flush()).resolves.toBeUndefined();

    // Failure path — `flush` closes over this same destination object, so
    // swapping in a throwing flush exercises the try/catch that swallows the
    // error and still resolves (logger.ts 141-142).
    (destination as unknown as { flush: (cb: () => void) => void }).flush =
      () => {
        throw new Error('stream not ready');
      };
    await expect(flush()).resolves.toBeUndefined();
  });

  it('degrades to a no-op logger (no destination) when the file sink cannot be built', async () => {
    const spy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    const { logger, flush, destination } = await createDiagnosticLogger({
      dir: mkTmp(),
    });

    // Construction threw before pino-roll → fell into the catch fallback.
    expect(destination).toBeUndefined();
    expect(() => {
      logger.debug({ event: 'd' }, 'd');
      logger.info({ event: 'i' }, 'i');
      logger.warn({ event: 'w' }, 'w');
      logger.error({ event: 'e' }, 'e');
      logger.fatal({ event: 'f' }, 'f');
    }).not.toThrow();
    await expect(flush()).resolves.toBeUndefined();

    spy.mockRestore();
  });
});
