// A running match in the browser: owns the lockstep runner, the game clock,
// interpolation snapshots, fog-of-war visibility, selection and commands.

import {
  BUILDINGS, FP, LockstepRunner, TURN_MS, TICKS_PER_TURN, UNITS,
  type Command, type Entity, type GameEvent, type GameSetup, type GameState, type TurnMsg,
} from '@mini/shared';
import type { GameTransport } from './net.ts';
import type { ViewModel } from './render/scene.ts';

const TICK_MS = TURN_MS / TICKS_PER_TURN;

export type SessionKind = 'online' | 'offline' | 'tutorial' | 'replay';

export interface ChatEntry {
  p: number;
  text: string;
  at: number;
}

export interface SavedReplay {
  v: 1;
  date: number;
  setup: GameSetup;
  me: number;
  total: number;
  turns: Array<[number, TurnMsg['c']]>; // only turns that had commands
}

export class GameSession implements ViewModel {
  readonly runner: LockstepRunner;
  readonly kind: SessionKind;
  readonly transport: GameTransport;
  readonly code: string;
  me: number;
  state: GameState;
  alpha = 0;
  prev = new Map<number, [number, number]>();
  fogEnabled: boolean;
  vis: Uint8Array;
  selection = new Set<number>();
  placing: { kind: string; tx: number; ty: number; ok: boolean } | null = null;
  rallyMode = false;
  amoveMode = false;
  hover = 0;
  groups = new Map<number, number[]>();
  chat: ChatEntry[] = [];
  speed = 1;
  paused = false;
  waiting = false;
  catchingUp = false;
  desynced = false;
  ended = false;
  presence = new Map<number, boolean>();
  onEvents?: (events: GameEvent[]) => void;
  onGameOver?: () => void;
  onChat?: (p: number, i: number, emote: boolean) => void;
  private acc = 0;
  private visTick = -1;
  private sightCache = new Map<number, Array<[number, number]>>();
  private pendingEvents: GameEvent[] = [];
  private overAt = 0;

  constructor(opts: { setup: GameSetup; me: number; transport: GameTransport; kind: SessionKind; code?: string }) {
    this.kind = opts.kind;
    this.me = opts.me;
    this.code = opts.code ?? '';
    this.transport = opts.transport;
    this.runner = new LockstepRunner(opts.setup);
    this.state = this.runner.state;
    this.fogEnabled = opts.kind !== 'replay';
    this.vis = new Uint8Array(this.state.map.w * this.state.map.h);
    this.runner.hooks.beforeTick = (s) => {
      for (const e of s.entities) {
        if (e.size > 0) continue;
        const p = this.prev.get(e.id);
        if (p) {
          p[0] = e.x;
          p[1] = e.y;
        } else this.prev.set(e.id, [e.x, e.y]);
      }
    };
    this.runner.hooks.afterTick = (_s, events) => {
      if (events.length > 0) this.pendingEvents.push(...events);
    };
    this.runner.onHash = (t, h) => this.transport.sendHash(t, h);
    this.transport.events.onTurn = (t) => this.runner.push(t);
    this.transport.events.onChat = (p, i, emote) => this.onChat?.(p, i, emote);
    this.transport.events.onDesync = () => {
      this.desynced = true;
    };
    this.transport.events.onPresence = (slot, c) => this.presence.set(slot, c);
    this.computeVis(true);
  }

  get myPlayer() {
    return this.me >= 0 ? this.state.players[this.me] : undefined;
  }

  /** Advance the game clock by real time dt (ms). */
  update(dtMs: number): void {
    if (this.desynced) return;
    if (this.paused) {
      this.alpha = 1;
      return;
    }
    const buffered = this.kind === 'replay' ? 1 : this.runner.buffered();
    if (buffered > 30) {
      // reconnecting or loading a replay jump: fast-forward with a time budget
      this.catchingUp = true;
      const t0 = performance.now();
      while (performance.now() - t0 < 14 && this.runner.tick()) { /* run */ }
      this.prev.clear();
      this.computeVis(true);
      this.flushEvents(true);
      this.alpha = 1;
      return;
    }
    this.catchingUp = false;
    const catchUp = this.kind === 'replay' ? 1 : buffered > 3 ? Math.min(4, buffered / 2) : 1;
    const tickMs = TICK_MS / (this.speed * catchUp);
    this.acc += dtMs;
    let n = 0;
    this.waiting = false;
    while (this.acc >= tickMs && n < 40) {
      if (!this.runner.tick()) {
        this.acc = Math.min(this.acc, tickMs);
        this.waiting = this.kind !== 'replay' && !this.state.over;
        break;
      }
      this.acc -= tickMs;
      n++;
    }
    this.alpha = Math.max(0, Math.min(1, this.acc / tickMs));
    if (n > 0) {
      this.computeVis(false);
      this.flushEvents(false);
    }
    this.pruneSelection();
    if (this.state.over && !this.ended) {
      if (!this.overAt) this.overAt = performance.now();
      if (performance.now() - this.overAt > 1800) {
        this.ended = true;
        this.onGameOver?.();
      }
    }
  }

  /**
   * Browsers pause requestAnimationFrame in hidden tabs. Online, the server keeps
   * sending turns, so we keep simulating from a timer (without effects) to stay
   * in sync and keep reporting hashes.
   */
  backgroundTick(): void {
    if (this.kind !== 'online' || this.desynced) return;
    let n = 0;
    while (n < 4000 && this.runner.tick()) n++;
    if (n > 0) {
      this.prev.clear();
      this.computeVis(true);
      this.flushEvents(true);
    }
    if (this.state.over && !this.ended) {
      this.ended = true;
      this.onGameOver?.();
    }
  }

  private flushEvents(skip: boolean): void {
    const ev = this.pendingEvents;
    this.pendingEvents = [];
    if (!skip && ev.length > 0) this.onEvents?.(ev);
    // a defeated player watches the rest without fog
    const p = this.myPlayer;
    if (p && !p.alive) this.fogEnabled = false;
  }

  private sightOffsets(r: number): Array<[number, number]> {
    let c = this.sightCache.get(r);
    if (!c) {
      c = [];
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r + r) c.push([dx, dy]);
      this.sightCache.set(r, c);
    }
    return c;
  }

  computeVis(force: boolean): void {
    const s = this.state;
    if (!force && s.tick - this.visTick < 4) return;
    this.visTick = s.tick;
    const { w, h } = s.map;
    const vis = this.vis;
    for (let i = 0; i < vis.length; i++) if (vis[i] === 2) vis[i] = 1;
    const team = this.myPlayer?.team ?? -99;
    for (const e of s.entities) {
      if (e.owner < 0 || e.inside || s.players[e.owner].team !== team) continue;
      const ud = UNITS[e.kind];
      const bd = BUILDINGS[e.kind];
      const r = ud ? ud.sight : bd ? (e.done ? bd.sight : 2) + (e.size >> 1) : 0;
      if (r <= 0) continue;
      const cx = Math.floor(e.x / FP);
      const cy = Math.floor(e.y / FP);
      for (const [dx, dy] of this.sightOffsets(r)) {
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && y >= 0 && x < w && y < h) vis[y * w + x] = 2;
      }
    }
  }

  visibleAt(x: number, y: number): boolean {
    if (!this.fogEnabled) return true;
    return this.vis[Math.floor(y / FP) * this.state.map.w + Math.floor(x / FP)] === 2;
  }

  isVisible(e: Entity): boolean {
    if (!this.fogEnabled) return true;
    const i = Math.floor(e.y / FP) * this.state.map.w + Math.floor(e.x / FP);
    if (e.owner >= 0 && this.myPlayer && this.state.players[e.owner].team === this.myPlayer.team) return true;
    return UNITS[e.kind] ? this.vis[i] === 2 : this.vis[i] > 0;
  }

  // ---------------------------------------------------------------- selection

  selected(): Entity[] {
    const out: Entity[] = [];
    for (const id of this.selection) {
      const e = this.state.byId.get(id);
      if (e && !e.dead && !e.inside) out.push(e);
    }
    return out;
  }

  selectedOwnUnits(): Entity[] {
    return this.selected().filter((e) => e.owner === this.me && UNITS[e.kind]);
  }

  pruneSelection(): void {
    for (const id of this.selection) {
      const e = this.state.byId.get(id);
      if (!e || e.dead || e.inside || !this.isVisible(e)) this.selection.delete(id);
    }
  }

  select(ids: number[], add = false): void {
    if (!add) this.selection.clear();
    for (const id of ids) this.selection.add(id);
    this.placing = null;
    this.rallyMode = false;
    this.amoveMode = false;
  }

  saveGroup(n: number): void {
    this.groups.set(n, this.selectedOwnUnits().map((e) => e.id));
  }

  recallGroup(n: number): Entity[] {
    const ids = (this.groups.get(n) ?? []).filter((id) => this.state.byId.has(id));
    this.select(ids);
    return this.selected();
  }

  // ---------------------------------------------------------------- commands

  command(c: Command): void {
    if (this.kind === 'replay' || this.state.over || !this.myPlayer?.alive) return;
    this.transport.sendCmd(c);
  }

  /** Smallest snapshot that reproduces this game exactly. */
  toReplay(): SavedReplay {
    const turns: SavedReplay['turns'] = [];
    for (const t of this.runner.log) if (t.c.length > 0) turns.push([t.t, t.c]);
    return { v: 1, date: Date.now(), setup: this.runner.setup, me: this.me, total: this.runner.log.length, turns };
  }

  dispose(): void {
    this.transport.close();
  }
}

/** Expand a saved replay into the full turn list. */
export function replayTurns(r: SavedReplay): TurnMsg[] {
  const map = new Map(r.turns);
  const out: TurnMsg[] = [];
  for (let t = 0; t < r.total; t++) out.push({ t, c: map.get(t) ?? [] });
  return out;
}

const REPLAY_KEY = 'miniempire.replays.v1';

export function loadReplays(): SavedReplay[] {
  try {
    return JSON.parse(localStorage.getItem(REPLAY_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function storeReplay(r: SavedReplay): void {
  try {
    const list = [r, ...loadReplays()].slice(0, 6);
    localStorage.setItem(REPLAY_KEY, JSON.stringify(list));
  } catch {
    /* storage full or blocked: replay can still be downloaded */
  }
}
