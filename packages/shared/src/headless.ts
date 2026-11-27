// Headless bot-vs-bot games for determinism checks (Node tests and the browser page).

import { hashState } from './hash.ts';
import { LockstepRunner } from './lockstep.ts';
import type { GameMode, GameSetup } from './types.ts';

export function botSetup(seed: number, mode: GameMode = '1v1', level = 3): GameSetup {
  const teams: Record<GameMode, number[]> = { '1v1': [0, 1], '2v2': [0, 0, 1, 1], ffa3: [0, 1, 2], ffa4: [0, 1, 2, 3] };
  return {
    seed,
    mode,
    players: teams[mode].map((team, i) => ({ name: `Bot ${i + 1}`, team, isBot: true, botLevel: level, hat: 0 })),
  };
}

/** Run a bots-only game for `turns` lockstep turns; return the hash trail. */
export function runBotGame(setup: GameSetup, turns: number): { hashes: number[]; final: number; tick: number; over: boolean; winner: number } {
  const r = new LockstepRunner(setup);
  const hashes: number[] = [];
  r.onHash = (_t, h) => hashes.push(h);
  for (let t = 0; t < turns; t++) {
    r.push({ t, c: [] });
    r.runAvailable();
    if (r.state.over) break;
  }
  return { hashes, final: hashState(r.state), tick: r.state.tick, over: r.state.over, winner: r.state.winnerTeam };
}
