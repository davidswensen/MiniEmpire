// Measures lockstep smoothness with 4 real clients on the relay (default ws://localhost:8080/ws).
// Each client runs the browser GameSession at 60 fps with simulated network jitter and we count
// how often the "Waiting for the server" banner would flip.
//   npx tsx scripts/net-jitter.ts [seconds] [maxJitterMs]
import WebSocket from 'ws';
import type { ServerMsg, TurnMsg } from '@mini/shared';
import { GameSession } from '../packages/client/src/game.ts';
import type { GameTransport } from '../packages/client/src/net.ts';

const SECONDS = Number(process.argv[2] ?? 15);
const JITTER = Number(process.argv[3] ?? 60);
const URL = process.env.RELAY ?? 'ws://localhost:8080/ws';
const g = globalThis as unknown as { performance: Performance };
void g;

function client(name: string) {
  const ws = new WebSocket(URL);
  const msgs: ServerMsg[] = [];
  const listeners: Array<(m: ServerMsg) => void> = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d)) as ServerMsg;
    // simulated network jitter on the way in (order preserved, like TCP)
    const delay = Math.random() * JITTER;
    const at = Math.max(Date.now() + delay, last);
    last = at;
    setTimeout(() => { msgs.push(m); listeners.forEach((l) => l(m)); }, at - Date.now());
  });
  let last = 0;
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  const wait = async <T extends ServerMsg['type']>(type: T, pred: (m: Extract<ServerMsg, { type: T }>) => boolean = () => true) => {
    for (;;) {
      const m = msgs.find((x) => x.type === type && pred(x as never));
      if (m) return m as Extract<ServerMsg, { type: T }>;
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { ws, msgs, listeners, send, wait, name, open: new Promise((r) => ws.once('open', r)) };
}

const cs = ['A', 'B', 'C', 'D'].map(client);
await Promise.all(cs.map((c) => c.open));
cs.forEach((c) => c.send({ type: 'hello', name: c.name, hat: 0 }));
await Promise.all(cs.map((c) => c.wait('welcome')));
cs[0].send({ type: 'create', mode: 'ffa4', isPublic: false });
const code = (await cs[0].wait('room')).room.code;
for (const c of cs.slice(1)) { c.send({ type: 'join', code }); await c.wait('room', (m) => m.you > 0); c.send({ type: 'ready', ready: true }); }
await cs[0].wait('room', (m) => m.room.slots.every((s, i) => i === 0 || s.ready));
cs[0].send({ type: 'start' });

const turnTimes: number[] = [];
const results = await Promise.all(cs.map(async (c, ci) => {
  const st = await c.wait('start');
  const transport: GameTransport = {
    online: true, canPause: false, events: {},
    sendCmd: (cmd) => c.send({ type: 'cmd', c: cmd }),
    sendHash: (t, h) => c.send({ type: 'hash', t, h }),
    sendChat: () => {}, setPaused: () => {}, close: () => {},
  };
  const gs = new GameSession({ setup: st.setup, me: st.you, transport, kind: 'online', code });
  c.listeners.push((m) => {
    if (m.type === 'turn') {
      if (ci === 0) turnTimes.push(Date.now());
      transport.events.onTurn?.(m.turn as TurnMsg);
    }
  });
  for (const m of c.msgs) if (m.type === 'turn') transport.events.onTurn?.(m.turn);
  let frames = 0, waitingFrames = 0, flips = 0, prev = false, lastT = performance.now();
  const end = performance.now() + SECONDS * 1000;
  while (performance.now() < end) {
    await new Promise((r) => setTimeout(r, 16));
    const now = performance.now();
    gs.update(Math.min(100, now - lastT));
    lastT = now;
    frames++;
    if (gs.waiting) waitingFrames++;
    if (gs.waiting !== prev) flips++;
    prev = gs.waiting;
  }
  return { name: c.name, frames, waitingFrames, flips, tick: gs.state.tick, desync: gs.desynced, buffered: gs.runner.buffered() };
}));

const gaps = turnTimes.slice(1).map((t, i) => t - turnTimes[i]);
const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
console.log(`room ${code}, ${SECONDS}s, jitter up to ${JITTER} ms`);
console.log(`server turns received: ${turnTimes.length} (avg gap ${avg.toFixed(1)} ms; ideal 100)`);
for (const r of results) console.log(`  ${r.name}: frames ${r.frames}, waiting frames ${r.waitingFrames}, banner flips ${r.flips}, tick ${r.tick}, buffered ${r.buffered}, desync ${r.desync}`);
cs.forEach((c) => c.ws.close());
process.exit(0);
