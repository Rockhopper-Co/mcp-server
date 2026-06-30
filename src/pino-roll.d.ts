/**
 * Ambient declaration for `pino-roll` (v4) — the package ships no types.
 *
 * Phase 1.5 / KI-225 — used by {@link ../logger.ts} to obtain a rotating
 * file destination. The default export is an async factory returning a
 * Sonic-boom stream usable directly as a Pino destination (NOT a worker
 * transport): keeping the destination in-process lets us `flushSync()` the
 * last line before a crash exit.
 */
declare module 'pino-roll' {
  import type { SonicBoom, SonicBoomOpts } from 'sonic-boom';

  /** Retention strategy for rotated files. */
  interface PinoRollLimitOptions {
    /** Files to keep, in addition to the currently-active file. */
    count?: number;
    removeOtherLogFiles?: boolean;
  }

  /** Options accepted by the pino-roll factory (plus passthrough Sonic-boom opts). */
  interface PinoRollOptions extends SonicBoomOpts {
    /** Base log file path. A number + extension are appended (e.g. `mcp-server.1.log`). */
    file: string | (() => string);
    /** Max size per file before rolling — e.g. `'5m'`, `'500k'`, or bytes. */
    size?: string | number;
    /** Time-based rotation — `'daily'`, `'hourly'`, or milliseconds. */
    frequency?: string | number;
    extension?: string;
    symlink?: boolean;
    limit?: PinoRollLimitOptions;
    dateFormat?: string;
  }

  /** Returns a Sonic-boom stream that auto-rolls per the supplied rules. */
  export default function pinoRoll(
    options?: PinoRollOptions,
  ): Promise<SonicBoom>;
}
