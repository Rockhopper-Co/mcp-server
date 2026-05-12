#!/usr/bin/env node
/**
 * Copy non-`.ts` assets that live alongside source modules into `dist/` so
 * they are accessible at runtime via `import.meta.url`-based resolution.
 *
 * Currently used for:
 *   - `src/resources/orchestration-guide.md` → `dist/resources/orchestration-guide.md`
 *     (read at module init by `src/resources/orchestration-guide.ts`)
 *
 * Runs after `tsc` in the `build` npm script. Keeps the build hermetic — no
 * external bundler, no plugin.
 */

import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..', 'src');
const DIST_ROOT = join(__dirname, '..', 'dist');

const EXTENSIONS_TO_COPY = new Set(['.md']);

/**
 * @param {string} dir
 */
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === '__tests__') continue;
      walk(full);
      continue;
    }
    const dot = entry.lastIndexOf('.');
    const ext = dot === -1 ? '' : entry.slice(dot);
    if (!EXTENSIONS_TO_COPY.has(ext)) continue;
    const rel = relative(SRC_ROOT, full);
    const target = join(DIST_ROOT, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(full, target);
    process.stdout.write(`copied ${rel}\n`);
  }
}

walk(SRC_ROOT);
