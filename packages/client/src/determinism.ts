// Browser half of the cross-engine determinism test (see determinism.html).
import { GOLDEN, botSetup, runBotGame } from '@mini/shared';

const out = document.getElementById('out') as HTMLTableElement;
const status = document.getElementById('status') as HTMLElement;
let pass = 0;

async function run(): Promise<void> {
  for (const g of GOLDEN) {
    await new Promise((r) => setTimeout(r, 0));
    const t0 = performance.now();
    const res = runBotGame(botSetup(g.seed, g.mode, g.level), g.turns);
    const ms = performance.now() - t0;
    const ok = res.final === g.hash;
    if (ok) pass++;
    const row = out.insertRow();
    row.innerHTML = `<td>${g.seed}</td><td>${g.mode}</td><td>${g.turns}</td><td>${g.hash.toString(16)}</td><td>${res.final.toString(16)}</td><td class="${ok ? 'ok' : 'bad'}">${ok ? '✔ match' : '✖ DIFFERENT'} (${ms.toFixed(0)} ms)</td>`;
  }
  const all = pass === GOLDEN.length;
  status.innerHTML = `<span class="${all ? 'ok' : 'bad'}">${all ? '✔ All' : '✖ Only'} ${pass}/${GOLDEN.length} games match.</span> ${navigator.userAgent}`;
  (window as unknown as { __determinism: unknown }).__determinism = { pass, total: GOLDEN.length };
}
void run();
