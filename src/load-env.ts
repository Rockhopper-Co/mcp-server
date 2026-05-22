import { config } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Load `.env` from package root and cwd (does not override existing env vars). */
export function loadEnvFiles(): void {
  const packageRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
  );
  config({ path: resolve(packageRoot, '.env') });
  config();
}
