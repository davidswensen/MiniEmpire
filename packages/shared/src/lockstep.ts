// Runs the simulation one lockstep turn at a time. Used by the browser, the
// replay viewer and the tests, so there is exactly one code path.

import { HASH_EVERY_TURNS, TICKS_PER_TURN } from './defs.ts';
import { hashState } from './hash.ts';
import type { TurnMsg } from './protocol.ts';
import { applyCommand, createGame, step } from './sim.ts';
import type { GameEvent, GameSetup, GameState } from './types.ts';

export interface TickHooks {
  beforeTick?: (s: GameState) => void;
  afterTick?: (s: GameState, events: GameEvent[]) => void;
}

export class LockstepRunner {
  readonly setup: GameSetup;
  state: GameState;
  /** Turns received but not yet executed, keyed by turn number. */
  private pending = new Map<number, TurnMsg>();
  /** Every executed turn, for replays and desync reports. */
  readonly log: TurnMsg[] = [];
  nextTurn = 0;
  /** Ticks left to run inside the current turn (commands already applied). */
  private ticksLeft = 0;
  hooks: TickHooks = {};
  onHash?: (t: number, h: number) => void;

  constructor(setup: GameSetup) {
    this.setup = setup;
    this.state = createGame(setup);
  }

  push(turn: TurnMsg): void {
    if (turn.t >= this.nextTurn) this.pending.set(turn.t, turn);
  }

  /** Turns buffered and ready to run (including a partially run one). */
  buffered(): number {
    let n = this.ticksLeft > 0 ? 1 : 0;
    let t = this.nextTurn;
    while (this.pending.has(t)) {
      n++;
      t++;
    }
    return n;
  }

  /** Run a single tick if input is available. Returns false when waiting for the server. */
  tick(): boolean {
    if (this.ticksLeft === 0) {
      const turn = this.pending.get(this.nextTurn);
      if (!turn) return false;
      this.pending.delete(this.nextTurn);
      for (const pc of turn.c) applyCommand(this.state, pc);
      this.log.push(turn);
      this.ticksLeft = TICKS_PER_TURN;
    }
    this.hooks.beforeTick?.(this.state);
    step(this.state);
    this.hooks.afterTick?.(this.state, this.state.events);
    this.ticksLeft--;
    if (this.ticksLeft === 0) {
      const t = this.nextTurn;
      this.nextTurn++;
      if (t % HASH_EVERY_TURNS === 0 && this.onHash) this.onHash(t, hashState(this.state));
    }
    return true;
  }

  /** Run whole turns as fast as possible (used to catch up after reconnecting). */
  runAvailable(maxTicks = 1 << 30): number {
    let n = 0;
    while (n < maxTicks && this.tick()) n++;
    return n;
  }
}

/** Replay a full game log headlessly and return the final state hash. */
export function replayHash(setup: GameSetup, turns: TurnMsg[]): { hash: number; state: GameState } {
  const r = new LockstepRunner(setup);
  for (const t of turns) r.push(t);
  r.runAvailable();
  return { hash: hashState(r.state), state: r.state };
}
