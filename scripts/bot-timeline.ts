// Prints a minute-by-minute summary of a hard-bot 1v1 game: npx tsx scripts/bot-timeline.ts <seed>
import { botSetup, LockstepRunner, UNITS, Order } from '@mini/shared';
const seed = Number(process.argv[2] ?? 1);
const lr = new LockstepRunner(botSetup(seed, '1v1', 3));
for (let t = 0; t < 12000; t++) {
  lr.push({ t, c: [] }); lr.runAvailable();
  if (t % 1200 === 0 || lr.state.over) {
    const s = lr.state;
    const line = s.players.map((p) => {
      const c = s.byId.get(p.castleId);
      const army = s.entities.filter((e) => e.owner === p.slot && UNITS[e.kind] && e.kind !== 'worker');
      const orders: Record<number, number> = {};
      for (const a of army) orders[a.order] = (orders[a.order] ?? 0) + 1;
      return `P${p.slot} L${p.level} w${p.wood} g${p.gold} pop${p.pop}/${p.popCap} army${army.length} ${JSON.stringify(orders)} castleHp${c?.hp} waves${p.bot?.waves}/${p.bot?.waveSize} k${p.stats.kills}`;
    }).join(' | ');
    console.log(`${(t / 600).toFixed(1)}min`, line);
    if (s.over) { console.log('OVER winner', s.winnerTeam); break; }
  }
}
void Order;
