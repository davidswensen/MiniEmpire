// Networking: a reconnecting WebSocket to the relay, plus transports that feed
// lockstep turns to a game session (online relay, local offline relay, replay).

import { TURN_MS, type ClientMsg, type Command, type ServerMsg, type TurnMsg } from '@mini/shared';
import { loadProfile } from './profile.ts';

type Listener = (msg: ServerMsg) => void;

const TOKEN_KEY = 'miniempire.token';

function getToken(): string | undefined {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function setToken(t: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* ignore */
  }
}

export class Net {
  ws: WebSocket | null = null;
  connected = false;
  private listeners = new Set<Listener>();
  private retry = 0;
  private wantOpen = false;
  private outbox: ClientMsg[] = [];
  rtt = 0;
  onStatus?: (connected: boolean) => void;

  url(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  open(): void {
    this.wantOpen = true;
    if (this.ws && this.ws.readyState <= 1) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url());
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      const p = loadProfile();
      ws.send(JSON.stringify({ type: 'hello', name: p.name, hat: p.hat, token: getToken() } satisfies ClientMsg));
    };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === 'welcome') {
        setToken(msg.token);
        this.connected = true;
        this.onStatus?.(true);
        const queued = this.outbox;
        this.outbox = [];
        for (const m of queued) this.send(m);
      }
      if (msg.type === 'pong') this.rtt = performance.now() - msg.at;
      for (const l of [...this.listeners]) l(msg);
    };
    ws.onclose = () => {
      const was = this.connected;
      this.connected = false;
      this.ws = null;
      if (was) this.onStatus?.(false);
      if (this.wantOpen) this.scheduleRetry();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleRetry(): void {
    const delay = Math.min(5000, 500 * 2 ** this.retry++);
    setTimeout(() => this.wantOpen && this.open(), delay);
  }

  send(msg: ClientMsg): void {
    if (this.ws && this.connected && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
    else if (msg.type !== 'cmd' && msg.type !== 'hash' && msg.type !== 'ping') {
      this.outbox.push(msg);
      this.open();
    }
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Update name/hat on the server by re-saying hello. */
  refreshHello(): void {
    if (this.ws && this.connected) {
      const p = loadProfile();
      this.ws.send(JSON.stringify({ type: 'hello', name: p.name, hat: p.hat, token: getToken() }));
    }
  }
}

export const net = new Net();

export interface TransportEvents {
  onTurn: (t: TurnMsg) => void;
  onChat: (p: number, i: number, emote: boolean) => void;
  onDesync: (t: number) => void;
  onPresence: (slot: number, connected: boolean) => void;
}

export interface GameTransport {
  readonly online: boolean;
  readonly canPause: boolean;
  events: Partial<TransportEvents>;
  sendCmd(c: Command): void;
  sendHash(t: number, h: number): void;
  sendChat(i: number, emote: boolean): void;
  setPaused(p: boolean): void;
  close(): void;
}

/** Relay server transport. */
export class OnlineTransport implements GameTransport {
  readonly online = true;
  readonly canPause = false;
  events: Partial<TransportEvents> = {};
  private off: () => void;

  constructor() {
    this.off = net.on((m) => {
      if (m.type === 'turn') this.events.onTurn?.(m.turn);
      else if (m.type === 'history') for (const t of m.turns) this.events.onTurn?.(t);
      else if (m.type === 'chat') this.events.onChat?.(m.p, m.i, !!m.emote);
      else if (m.type === 'desync') this.events.onDesync?.(m.t);
      else if (m.type === 'presence') this.events.onPresence?.(m.slot, m.connected);
    });
  }
  sendCmd(c: Command): void {
    net.send({ type: 'cmd', c });
  }
  sendHash(t: number, h: number): void {
    net.send({ type: 'hash', t, h });
  }
  sendChat(i: number, emote: boolean): void {
    net.send({ type: 'chat', i, emote });
  }
  setPaused(): void {}
  close(): void {
    this.off();
    net.send({ type: 'leave' });
  }
}

/**
 * Offline play: this browser acts as its own relay. It is the same lockstep path
 * as online play, just with zero latency (and pausing is allowed).
 */
export class LocalTransport implements GameTransport {
  readonly online = false;
  readonly canPause = true;
  events: Partial<TransportEvents> = {};
  private pending: Command[] = [];
  private turn = 0;
  private timer: number;
  private paused = false;
  private slot: number;

  constructor(slot = 0) {
    this.slot = slot;
    this.timer = window.setInterval(() => this.tick(), TURN_MS);
  }
  private tick(): void {
    if (this.paused) return;
    const t: TurnMsg = { t: this.turn++, c: this.pending.map((c) => ({ p: this.slot, c })) };
    this.pending = [];
    this.events.onTurn?.(t);
  }
  sendCmd(c: Command): void {
    if (!this.paused) this.pending.push(c);
  }
  sendHash(): void {}
  sendChat(i: number, emote: boolean): void {
    this.events.onChat?.(this.slot, i, emote);
  }
  setPaused(p: boolean): void {
    this.paused = p;
  }
  close(): void {
    clearInterval(this.timer);
  }
}

/** Replays: all turns are known up front. */
export class ReplayTransport implements GameTransport {
  readonly online = false;
  readonly canPause = true;
  events: Partial<TransportEvents> = {};
  sendCmd(): void {}
  sendHash(): void {}
  sendChat(): void {}
  setPaused(): void {}
  close(): void {}
}
