// Fingerprint of the deterministic simulation source (packages/shared/src).
// The client build and the relay server both compute it; players whose
// fingerprints differ would desync, so the server refuses mismatched clients.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHARED_SRC = fileURLToPath(new URL('../packages/shared/src/', import.meta.url));

export function simVersion(dir = SHARED_SRC) {
  const h = createHash('sha256');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts')).sort()) {
    // normalise line endings so Windows and Linux checkouts agree
    h.update(f + '\n' + readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n'));
  }
  return h.digest('hex').slice(0, 12);
}
