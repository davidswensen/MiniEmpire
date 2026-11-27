// Automated balance playtest: difficulty matrix across seeds, plus a scripted
// "beginner" who follows the tutorial against the sleepy tutorial bot.
//   npx tsx scripts/balance.ts [seeds]
import {
  LockstepRunner, UNITS, canPlace, type Command, type Entity, type GameSetup, type GameState,
} from '@mini/shared';

const SEEDS = Number(process.argv[2] ?? 6);
const MAX_TURNS = 25 * 600; // 25 minutes
const NAMES = ['Sleepy', 'Easy', 'Normal', 'Hard'];

function botVsBot(seed: number, a: number, b: number): { winner: number; minutes: number } {
  const setup: GameSetup = { seed, mode: '1v1', players: [
    { name: 'A', team: 0, isBot: true, botLevel: a, hat: 0 },
    { name: 'B', team: 1, isBot: true, botLevel: b, hat: 0 }] };
  const r = new LockstepRunner(setup);
  for (let t = 0; t < MAX_TURNS && !r.state.over; t++) { r.push({ t, c: [] }); r.runAvailable(); }
  return { winner: r.state.over ? r.state.winnerTeam : -1, minutes: r.state.tick / 1200 };
}

/** A simple human-like plan: what the tutorial teaches, then attack with everything. */
function beginner(s: GameState, me: number): Command[] {
  const out: Command[] = [];
  const mine = s.entities.filter((e) => e.owner === me);
  const p = s.players[me];
  const castle = s.byId.get(p.castleId) as Entity;
  const workers = mine.filter((e) => e.kind === 'worker');
  const army = mine.filter((e) => UNITS[e.kind] && e.kind !== 'worker');
  const idle = workers.filter((w) => w.order === 0);
  const near = (kind: string, from: Entity) => s.entities.filter((e) => e.kind === kind).sort((x, y) => Math.hypot(x.x - from.x, x.y - from.y) - Math.hypot(y.x - from.x, y.y - from.y))[0];
  idle.forEach((w, i) => { const r = near(i % 2 ? 'goldmine' : 'tree', w); if (r) out.push({ t: 'gather', ids: [w.id], target: r.id }); });
  if (workers.length < 10 && castle.queue.length === 0) out.push({ t: 'train', b: castle.id, kind: 'worker' });
  const spot = (kind: string): [number, number] | null => {
    for (let r = 4; r < 14; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const x = castle.tileX + dx; const y = castle.tileY + dy;
      if (canPlace(s, me, kind, x, y)) return [x, y];
    }
    return null;
  };
  const build = (kind: string) => { const sp = spot(kind); if (sp && workers[0]) out.push({ t: 'build', ids: [workers[0].id, workers[1]?.id ?? workers[0].id], kind, tx: sp[0], ty: sp[1] }); };
  const has = (k: string) => mine.some((e) => e.kind === k);
  if (p.popCap - p.pop < 3 && !mine.some((e) => e.kind === 'house' && !e.done) && p.wood >= 40) build('house');
  else if (!has('barracks') && p.wood >= 120) build('barracks');
  const bar = mine.find((e) => e.kind === 'barracks' && e.done);
  if (bar && bar.queue.length < 2) out.push({ t: 'train', b: bar.id, kind: s.tick % 3 === 0 ? 'archer' : 'swordsman' });
  if (army.length >= 12 && army.some((u) => u.order === 0)) {
    const enemy = s.byId.get(s.players[1 - me].castleId);
    if (enemy) out.push({ t: 'attack', ids: army.map((u) => u.id), target: enemy.id });
  }
  return out;
}

function beginnerVs(seed: number, botLevel: number): { winner: number; minutes: number } {
  const setup: GameSetup = { seed, mode: '1v1', players: [
    { name: 'Kid', team: 0, isBot: false, botLevel: 0, hat: 0 },
    { name: 'Bot', team: 1, isBot: true, botLevel: botLevel, hat: 0 }] };
  const r = new LockstepRunner(setup);
  for (let t = 0; t < MAX_TURNS && !r.state.over; t++) {
    // a kid clicks a few times a second, not every turn
    const c = t % 15 === 0 ? beginner(r.state, 0).map((cmd) => ({ p: 0, c: cmd })) : [];
    r.push({ t, c });
    r.runAvailable();
  }
  return { winner: r.state.over ? r.state.winnerTeam : -1, minutes: r.state.tick / 1200 };
}

function summary(label: string, results: Array<{ winner: number; minutes: number }>): void {
  const w0 = results.filter((x) => x.winner === 0).length;
  const w1 = results.filter((x) => x.winner === 1).length;
  const draws = results.length - w0 - w1;
  const done = results.filter((x) => x.winner >= 0).map((x) => x.minutes);
  const avg = done.length ? (done.reduce((a, b) => a + b, 0) / done.length).toFixed(1) : '-';
  console.log(`${label.padEnd(28)} first ${w0}  second ${w1}  unfinished ${draws}  avg ${avg} min`);
}

console.log(`Balance playtest, ${SEEDS} seeds per row, ${MAX_TURNS / 600} minute cap\n`);
for (const [a, b] of [[3, 1], [3, 2], [2, 1], [2, 2]]) {
  summary(`${NAMES[a]} vs ${NAMES[b]}`, Array.from({ length: SEEDS }, (_, i) => botVsBot(100 + i, a, b)));
}
for (const lvl of [0, 1, 2]) {
  summary(`Beginner vs ${NAMES[lvl]} bot`, Array.from({ length: SEEDS }, (_, i) => beginnerVs(200 + i, lvl)));
}
