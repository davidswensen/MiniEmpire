import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GOLDEN, LockstepRunner, UNITS, botSetup, hashState, makeRng, randInt, replayHash, runBotGame,
  type Command, type GameSetup, type TurnMsg,
} from '../src/index.ts';

describe('determinism', () => {
  it('matches the golden hashes (same results as every browser)', () => {
    for (const g of GOLDEN) {
      const r = runBotGame(botSetup(g.seed, g.mode, g.level), g.turns);
      expect(r.final.toString(16), `${g.mode} seed ${g.seed}`).toBe(g.hash.toString(16));
    }
  });

  it('same seed twice gives the same hash trail; another seed differs', () => {
    const a = runBotGame(botSetup(5, '1v1', 3), 600);
    const b = runBotGame(botSetup(5, '1v1', 3), 600);
    const c = runBotGame(botSetup(6, '1v1', 3), 600);
    expect(a.hashes).toEqual(b.hashes);
    expect(a.final).not.toBe(c.final);
  });

  it('a recorded command log replays to the identical state (fuzzed human input)', () => {
    const setup: GameSetup = {
      seed: 2024,
      mode: '2v2',
      players: [
        { name: 'human', team: 0, isBot: false, botLevel: 0, hat: 0 },
        { name: 'bot', team: 0, isBot: true, botLevel: 2, hat: 0 },
        { name: 'human2', team: 1, isBot: false, botLevel: 0, hat: 0 },
        { name: 'bot2', team: 1, isBot: true, botLevel: 3, hat: 0 },
      ],
    };
    const live = new LockstepRunner(setup);
    const fuzz = makeRng(99);
    const turns: TurnMsg[] = [];
    for (let t = 0; t < 1500; t++) {
      const c: TurnMsg['c'] = [];
      for (const p of [0, 2]) {
        if (randInt(fuzz, 4) !== 0) continue;
        const mine = live.state.entities.filter((e) => e.owner === p && UNITS[e.kind]);
        const blds = live.state.entities.filter((e) => e.owner === p && !UNITS[e.kind]);
        const pick = mine.length ? mine[randInt(fuzz, mine.length)] : null;
        const any = live.state.entities[randInt(fuzz, live.state.entities.length)];
        const x = randInt(fuzz, live.state.map.w * 1024);
        const y = randInt(fuzz, live.state.map.h * 1024);
        const options: Command[] = [
          { t: 'smart', ids: pick ? [pick.id] : [], x, y, target: randInt(fuzz, 2) ? any.id : 0 },
          { t: 'amove', ids: mine.slice(0, 6).map((e) => e.id), x, y },
          { t: 'build', ids: pick ? [pick.id] : [], kind: ['house', 'barracks', 'wall', 'storehouse'][randInt(fuzz, 4)], tx: randInt(fuzz, 64), ty: randInt(fuzz, 64) },
          { t: 'train', b: blds.length ? blds[randInt(fuzz, blds.length)].id : 0, kind: ['worker', 'swordsman', 'archer'][randInt(fuzz, 3)] },
          { t: 'stop', ids: pick ? [pick.id] : [] },
        ];
        c.push({ p, c: options[randInt(fuzz, options.length)] });
      }
      const turn = { t, c };
      turns.push(JSON.parse(JSON.stringify(turn))); // what the network would deliver
      live.push(turn);
      live.runAvailable();
    }
    const replayed = replayHash(setup, turns);
    expect(replayed.hash).toBe(hashState(live.state));
    expect(live.state.entities.length).toBeGreaterThan(20);
  });

  it('a game can be resumed mid-way from the turn log (reconnect fast-forward)', () => {
    const setup = botSetup(31, 'ffa3', 2);
    const full = new LockstepRunner(setup);
    const log: TurnMsg[] = [];
    for (let t = 0; t < 800; t++) {
      log.push({ t, c: [] });
      full.push(log[t]);
      full.runAvailable();
    }
    const rejoined = new LockstepRunner(setup);
    for (const t of log) rejoined.push(t);
    rejoined.runAvailable();
    expect(hashState(rejoined.state)).toBe(hashState(full.state));
  });

  it('replays any saved desync logs (if present)', () => {
    const dir = new URL('../../../desyncs/', import.meta.url);
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const d = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
      const r = replayHash(d.setup, d.turns);
      console.log(`desync log ${f}: replays to ${r.hash.toString(16)}, clients reported`, d.hashes);
    }
  });
});
