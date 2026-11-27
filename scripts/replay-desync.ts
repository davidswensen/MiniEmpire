// Replays a saved desync log with the current code and prints the hashes it
// produces next to the ones each player reported. A player whose hash differs
// from this replay was running different code.
//   npx tsx scripts/replay-desync.ts packages/server/desyncs/<file>.json
import { readFileSync } from 'node:fs';
import { LockstepRunner } from '@mini/shared';
const d = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const r = new LockstepRunner(d.setup);
const hs: Record<number, string> = {};
r.onHash = (t, h) => { hs[t] = h.toString(16) + ' (' + h + ')'; };
for (const t of d.turns) r.push(t);
r.runAvailable();
console.log('current code hashes:', hs, 'reported:', d.hashes);
