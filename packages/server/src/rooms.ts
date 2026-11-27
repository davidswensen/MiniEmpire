// Rooms and the lockstep relay. The server never runs the simulation: it keeps
// time, orders commands, and compares state hashes to detect desyncs.

import { randomBytes, randomInt } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { WebSocket } from 'ws';
import {
  EMOTES, MODE_SLOTS, QUICK_CHAT, TURN_MS, cleanCode,
  type ClientMsg, type GameMode, type GameSetup, type LobbySlot, type PlayerCommand, type RoomInfo,
  type ServerMsg, type TurnMsg,
} from '@mini/shared';

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O
const MAX_CMDS_PER_SEC = 40;
const RECONNECT_GRACE_MS = 120_000;
const EMPTY_ROOM_MS = 60_000;

export class Session {
  token = randomBytes(12).toString('hex');
  name = 'Player';
  hat = 0;
  ws: WebSocket | null = null;
  room: Room | null = null;
  slot = -1;
  lastSeen = Date.now();
  cmdWindowStart = 0;
  cmdCount = 0;

  send(msg: ServerMsg): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }
}

export class Room {
  readonly code: string;
  readonly mode: GameMode;
  readonly isPublic: boolean;
  slots: LobbySlot[];
  members: Array<Session | null>;
  host = 0;
  started = false;
  setup: GameSetup | null = null;
  turns: TurnMsg[] = [];
  pending: PlayerCommand[] = [];
  timer: NodeJS.Timeout | null = null;
  startAt = 0;
  hashes = new Map<number, Map<number, number>>();
  desynced = false;
  emptySince = 0;
  createdAt = Date.now();

  constructor(code: string, mode: GameMode, isPublic: boolean) {
    this.code = code;
    this.mode = mode;
    this.isPublic = isPublic;
    this.slots = MODE_SLOTS[mode].map((team) => ({
      kind: 'open', name: '', team, ready: false, botLevel: 2, hat: 0, connected: false,
    }));
    this.members = this.slots.map(() => null);
  }

  info(): RoomInfo {
    return { code: this.code, mode: this.mode, host: this.host, slots: this.slots, isPublic: this.isPublic, started: this.started };
  }

  broadcast(msg: ServerMsg): void {
    const data = JSON.stringify(msg);
    for (const m of this.members) if (m?.ws && m.ws.readyState === 1) m.ws.send(data);
  }

  sendRoom(): void {
    this.members.forEach((m, i) => m?.send({ type: 'room', room: this.info(), you: i }));
  }

  openSlot(): number {
    return this.slots.findIndex((s) => s.kind === 'open');
  }

  humans(): number {
    return this.slots.filter((s) => s.kind === 'human').length;
  }

  connectedHumans(): number {
    return this.members.filter((m) => m && m.ws && m.ws.readyState === 1).length;
  }

  seat(sess: Session, slot: number): void {
    this.slots[slot] = { ...this.slots[slot], kind: 'human', name: sess.name, ready: false, hat: sess.hat, connected: true };
    this.members[slot] = sess;
    sess.room = this;
    sess.slot = slot;
  }

  unseat(slot: number): void {
    const team = this.slots[slot].team;
    this.slots[slot] = { kind: 'open', name: '', team, ready: false, botLevel: 2, hat: 0, connected: false };
    this.members[slot] = null;
    if (this.host === slot) {
      const next = this.slots.findIndex((s) => s.kind === 'human');
      this.host = next >= 0 ? next : 0;
    }
  }

  start(): string | null {
    if (this.started) return 'Already started';
    if (this.openSlot() >= 0) return 'Fill every slot with a player or a bot first';
    const notReady = this.slots.some((s, i) => s.kind === 'human' && i !== this.host && !s.ready);
    if (notReady) return 'Waiting for everyone to press Ready';
    this.started = true;
    this.setup = {
      seed: randomInt(1, 2 ** 31 - 1),
      mode: this.mode,
      players: this.slots.map((s, i) => ({
        name: s.kind === 'bot' ? `${BOT_NAMES[i % BOT_NAMES.length]} (bot)` : s.name,
        team: s.team,
        isBot: s.kind === 'bot',
        botLevel: s.botLevel,
        hat: s.hat,
      })),
    };
    this.members.forEach((m, i) => m?.send({ type: 'start', setup: this.setup as GameSetup, you: i, code: this.code }));
    this.startAt = Date.now();
    this.schedule();
    return null;
  }

  /**
   * Drift-free turn clock: turn n is due at startAt + (n + 1) * TURN_MS.
   * (setInterval drifts late, which made clients run dry and stall every few turns.)
   */
  private schedule(): void {
    const due = this.startAt + (this.turns.length + 1) * TURN_MS;
    this.timer = setTimeout(() => {
      this.timer = null;
      // if the process was busy, catch up (but never send a huge burst)
      let n = 0;
      while (n < 5 && Date.now() >= this.startAt + (this.turns.length + 1) * TURN_MS) {
        this.turn();
        n++;
      }
      if (n === 0) this.turn();
      if (!this.desynced) this.schedule();
    }, Math.max(0, due - Date.now()));
  }

  private turn(): void {
    const t: TurnMsg = { t: this.turns.length, c: this.pending };
    this.pending = [];
    this.turns.push(t);
    this.broadcast({ type: 'turn', turn: t });
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  command(sess: Session, msg: Extract<ClientMsg, { type: 'cmd' }>): void {
    if (!this.started || this.desynced || sess.slot < 0) return;
    const now = Date.now();
    if (now - sess.cmdWindowStart > 1000) {
      sess.cmdWindowStart = now;
      sess.cmdCount = 0;
    }
    if (++sess.cmdCount > MAX_CMDS_PER_SEC) return;
    if (!msg.c || typeof msg.c !== 'object' || JSON.stringify(msg.c).length > 4000) return;
    // the slot is stamped by the server, never trusted from the client
    this.pending.push({ p: sess.slot, c: msg.c });
  }

  hash(sess: Session, t: number, h: number): void {
    if (this.desynced || !Number.isInteger(t) || sess.slot < 0) return;
    let m = this.hashes.get(t);
    if (!m) {
      m = new Map();
      this.hashes.set(t, m);
    }
    m.set(sess.slot, h >>> 0);
    const values = [...m.values()];
    if (values.some((v) => v !== values[0])) {
      this.desynced = true;
      console.warn(`[room ${this.code}] DESYNC at turn ${t}:`, Object.fromEntries(m));
      this.saveDesync(t, Object.fromEntries(m));
      this.broadcast({ type: 'desync', t });
      this.stop();
    }
    // forget old checkpoints
    for (const k of this.hashes.keys()) if (k < t - 100) this.hashes.delete(k);
  }

  private saveDesync(t: number, hashes: Record<number, number>): void {
    try {
      mkdirSync('desyncs', { recursive: true });
      const file = `desyncs/${this.code}-${t}-${Date.now()}.json`;
      writeFileSync(file, JSON.stringify({ setup: this.setup, turns: this.turns, hashes, at: t }));
      console.warn(`[room ${this.code}] saved ${file} (replay it with: npm test -- desync)`);
    } catch (err) {
      console.error('could not save desync log', err);
    }
  }

  chat(sess: Session, i: number, emote: boolean): void {
    const list = emote ? EMOTES : QUICK_CHAT;
    if (!Number.isInteger(i) || i < 0 || i >= list.length || sess.slot < 0) return;
    this.broadcast({ type: 'chat', p: sess.slot, i, emote });
  }
}

const BOT_NAMES = ['Sir Clank', 'Lady Bolt', 'Baron Gear', 'Duke Sprocket'];

export class Lobby {
  rooms = new Map<string, Room>();
  sessions = new Map<string, Session>();

  newCode(): string {
    for (;;) {
      let c = '';
      for (let i = 0; i < 4; i++) c += CODE_LETTERS[randomInt(CODE_LETTERS.length)];
      if (!this.rooms.has(c)) return c;
    }
  }

  handle(sess: Session, msg: ClientMsg): void {
    const room = sess.room;
    switch (msg.type) {
      case 'create': {
        this.leave(sess);
        const mode: GameMode = (['1v1', '2v2', 'ffa3', 'ffa4'] as const).includes(msg.mode) ? msg.mode : '1v1';
        const r = new Room(this.newCode(), mode, !!msg.isPublic);
        this.rooms.set(r.code, r);
        r.seat(sess, 0);
        r.host = 0;
        r.sendRoom();
        return;
      }
      case 'join': {
        const r = this.rooms.get(cleanCode(msg.code));
        if (!r) return sess.send({ type: 'error', msg: 'No room with that code' });
        if (r.started) return sess.send({ type: 'error', msg: 'That game already started' });
        const slot = r.openSlot();
        if (slot < 0) return sess.send({ type: 'error', msg: 'That room is full' });
        this.leave(sess);
        r.seat(sess, slot);
        r.sendRoom();
        return;
      }
      case 'quick': {
        this.leave(sess);
        let r = [...this.rooms.values()].find((x) => x.isPublic && !x.started && x.openSlot() >= 0 && x.humans() > 0);
        if (!r) {
          r = new Room(this.newCode(), '1v1', true);
          this.rooms.set(r.code, r);
        }
        r.seat(sess, r.openSlot());
        if (r.humans() === 1) r.host = sess.slot;
        r.sendRoom();
        return;
      }
      case 'leave':
        this.leave(sess);
        sess.send({ type: 'left' });
        return;
      case 'ready':
        if (!room || room.started || sess.slot < 0) return;
        room.slots[sess.slot].ready = !!msg.ready;
        room.sendRoom();
        return;
      case 'setBot': {
        if (!room || room.started || room.host !== sess.slot) return;
        const slot = msg.slot | 0;
        if (slot < 0 || slot >= room.slots.length || room.slots[slot].kind === 'human') return;
        if (msg.botLevel < 0) room.slots[slot] = { ...room.slots[slot], kind: 'open', name: '' };
        else {
          const lvl = Math.max(1, Math.min(3, msg.botLevel | 0));
          room.slots[slot] = { ...room.slots[slot], kind: 'bot', name: BOT_NAMES[slot % BOT_NAMES.length], botLevel: lvl, ready: true, connected: true };
        }
        room.sendRoom();
        return;
      }
      case 'start': {
        if (!room || room.host !== sess.slot) return;
        const err = room.start();
        if (err) sess.send({ type: 'error', msg: err });
        else console.log(`[room ${room.code}] started ${room.mode} seed=${room.setup?.seed}`);
        return;
      }
      case 'cmd':
        room?.command(sess, msg);
        return;
      case 'hash':
        room?.hash(sess, msg.t, msg.h);
        return;
      case 'chat':
        room?.chat(sess, msg.i, !!msg.emote);
        return;
      case 'ping':
        sess.send({ type: 'pong', at: msg.at });
        return;
    }
  }

  leave(sess: Session): void {
    const r = sess.room;
    if (!r) return;
    const slot = sess.slot;
    sess.room = null;
    sess.slot = -1;
    if (slot < 0) return;
    if (!r.started) {
      r.unseat(slot);
      if (r.humans() === 0) this.closeRoom(r);
      else r.sendRoom();
    } else {
      r.members[slot] = null;
      r.slots[slot].connected = false;
      r.broadcast({ type: 'presence', slot, connected: false });
      if (r.connectedHumans() === 0) this.closeRoom(r);
    }
  }

  disconnected(sess: Session): void {
    sess.ws = null;
    sess.lastSeen = Date.now();
    const r = sess.room;
    if (!r) return;
    if (!r.started) {
      this.leave(sess);
      return;
    }
    r.slots[sess.slot].connected = false;
    r.broadcast({ type: 'presence', slot: sess.slot, connected: false });
  }

  /** A returning browser (same token) gets its seat and the full turn history. */
  reconnected(sess: Session): void {
    const r = sess.room;
    if (!r || sess.slot < 0) return;
    if (r.started && r.setup) {
      r.slots[sess.slot].connected = true;
      sess.send({ type: 'history', setup: r.setup, you: sess.slot, code: r.code, turns: r.turns });
      r.broadcast({ type: 'presence', slot: sess.slot, connected: true });
    } else {
      r.sendRoom();
    }
  }

  closeRoom(r: Room): void {
    r.stop();
    this.rooms.delete(r.code);
    for (const m of r.members) {
      if (m && m.room === r) {
        m.room = null;
        m.slot = -1;
      }
    }
    console.log(`[room ${r.code}] closed`);
  }

  /** Periodic cleanup of abandoned sessions and rooms. */
  sweep(): void {
    const now = Date.now();
    for (const [tok, s] of this.sessions) {
      if (!s.ws && now - s.lastSeen > RECONNECT_GRACE_MS) {
        this.leave(s);
        this.sessions.delete(tok);
      }
    }
    for (const r of this.rooms.values()) {
      const live = r.connectedHumans();
      if (live === 0) {
        if (!r.emptySince) r.emptySince = now;
        if (now - r.emptySince > EMPTY_ROOM_MS) this.closeRoom(r);
      } else r.emptySince = 0;
      if (now - r.createdAt > 3 * 3600_000) this.closeRoom(r);
    }
  }
}
