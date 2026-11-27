// Integration test: real server process, two real WebSocket clients.
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMsg } from '@mini/shared';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simVersion } from '../../../scripts/sim-version.mjs';

const VERSION = simVersion();

const PORT = 18000 + Math.floor(Math.random() * 1000);
let proc: ChildProcess;

class Client {
  ws: WebSocket;
  msgs: ServerMsg[] = [];
  constructor() {
    this.ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    this.ws.on('message', (d) => this.msgs.push(JSON.parse(String(d))));
  }
  open(): Promise<void> {
    return new Promise((r) => this.ws.once('open', () => r()));
  }
  send(m: unknown): void {
    const msg = m as { type?: string; version?: string };
    // every hello carries the simulation version, like the real client
    if (msg.type === 'hello' && !('version' in msg)) msg.version = VERSION;
    this.ws.send(JSON.stringify(msg));
  }
  async wait<T extends ServerMsg['type']>(type: T, pred: (m: Extract<ServerMsg, { type: T }>) => boolean = () => true, ms = 5000): Promise<Extract<ServerMsg, { type: T }>> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const m = this.msgs.find((x) => x.type === type && pred(x as Extract<ServerMsg, { type: T }>));
      if (m) return m as Extract<ServerMsg, { type: T }>;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timeout waiting for ${type}`);
  }
}

beforeAll(async () => {
  // desync logs from the deliberate mismatch below go to a temp folder, not the repo
  const desyncDir = mkdtempSync(join(tmpdir(), 'mini-desync-'));
  proc = spawn(process.execPath, ['--import', 'tsx', 'packages/server/src/index.ts'], { env: { ...process.env, PORT: String(PORT), DESYNC_DIR: desyncDir }, stdio: 'pipe' });
  await new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('server did not start')), 20000);
    proc.stdout?.on('data', (d) => {
      if (String(d).includes('MiniEmpire server')) {
        clearTimeout(to);
        resolve();
      }
    });
  });
});

afterAll(() => {
  proc?.kill();
});

describe('relay server', () => {
  it('runs a room: create, join, bots, ready, start, ordered turns, chat, desync detection', async () => {
    const a = new Client();
    const b = new Client();
    await Promise.all([a.open(), b.open()]);
    a.send({ type: 'hello', name: 'Alice', hat: 1 });
    b.send({ type: 'hello', name: 'Bob<script>', hat: 2 });
    await a.wait('welcome');
    await b.wait('welcome');

    a.send({ type: 'create', mode: '2v2', isPublic: false });
    const room = await a.wait('room');
    expect(room.room.code).toMatch(/^[A-Z]{4}$/);
    b.send({ type: 'join', code: room.room.code.toLowerCase() });
    const joined = await b.wait('room');
    expect(joined.you).toBe(1);
    expect(joined.room.slots[1].name).toBe('Bobscript');

    // non-host cannot add bots; host can
    b.send({ type: 'setBot', slot: 2, botLevel: 2 });
    a.send({ type: 'start' });
    await a.wait('error', (m) => m.msg.includes('Fill'));
    a.send({ type: 'setBot', slot: 2, botLevel: 2 });
    a.send({ type: 'setBot', slot: 3, botLevel: 3 });
    await a.wait('room', (m) => m.room.slots.every((s) => s.kind !== 'open'));
    a.send({ type: 'start' });
    await a.wait('error', (m) => m.msg.includes('Ready'));
    b.send({ type: 'ready', ready: true });
    await a.wait('room', (m) => m.room.slots[1].ready);
    a.send({ type: 'start' });
    const sa = await a.wait('start');
    const sb = await b.wait('start');
    expect(sa.setup).toEqual(sb.setup);
    expect(sa.setup.players[2].isBot).toBe(true);
    expect(sa.you).toBe(0);
    expect(sb.you).toBe(1);

    // commands are stamped with the sender's slot, in one order for everyone
    b.send({ type: 'cmd', c: { t: 'stop', ids: [1] } });
    a.send({ type: 'cmd', c: { t: 'stop', ids: [2] } });
    await a.wait('turn', (m) => m.turn.c.length >= 1);
    await new Promise((r) => setTimeout(r, 400));
    const ta = a.msgs.filter((m) => m.type === 'turn').map((m) => (m as Extract<ServerMsg, { type: 'turn' }>).turn);
    const tb = b.msgs.filter((m) => m.type === 'turn').map((m) => (m as Extract<ServerMsg, { type: 'turn' }>).turn);
    const n = Math.min(ta.length, tb.length);
    expect(n).toBeGreaterThan(3);
    expect(ta.slice(0, n)).toEqual(tb.slice(0, n));
    ta.forEach((t, i) => expect(t.t).toBe(i));
    const all = ta.flatMap((t) => t.c);
    expect(all.find((c) => (c.c as { ids: number[] }).ids[0] === 1)?.p).toBe(1);
    expect(all.find((c) => (c.c as { ids: number[] }).ids[0] === 2)?.p).toBe(0);

    // quick chat only accepts known phrases
    a.send({ type: 'chat', i: 0 });
    a.send({ type: 'chat', i: 999 });
    const chat = await b.wait('chat');
    expect(chat).toMatchObject({ p: 0, i: 0 });

    // matching hashes are fine, a mismatch is flagged as a desync
    a.send({ type: 'hash', t: 0, h: 123 });
    b.send({ type: 'hash', t: 0, h: 123 });
    a.send({ type: 'hash', t: 10, h: 5 });
    b.send({ type: 'hash', t: 10, h: 6 });
    const ds = await a.wait('desync');
    expect(ds.t).toBe(10);

    a.ws.close();
    b.ws.close();
  });

  it('lets a disconnected player rejoin and receive the full turn history', async () => {
    const a = new Client();
    await a.open();
    a.send({ type: 'hello', name: 'Ann', hat: 0 });
    const wel = await a.wait('welcome');
    a.send({ type: 'create', mode: '1v1', isPublic: false });
    await a.wait('room');
    a.send({ type: 'setBot', slot: 1, botLevel: 1 });
    await a.wait('room', (m) => m.room.slots[1].kind === 'bot');
    a.send({ type: 'start' });
    await a.wait('start');
    await new Promise((r) => setTimeout(r, 500));
    a.ws.close();
    await new Promise((r) => setTimeout(r, 300));

    const again = new Client();
    await again.open();
    again.send({ type: 'hello', name: 'Ann', hat: 0, token: wel.token });
    const w2 = await again.wait('welcome');
    expect(w2.rejoin).toBe(true);
    const hist = await again.wait('history');
    expect(hist.turns.length).toBeGreaterThan(5);
    hist.turns.forEach((t, i) => expect(t.t).toBe(i));
    again.ws.close();
  });

  it('sends turns on a steady 100 ms clock (no drift)', async () => {
    const a = new Client();
    await a.open();
    a.send({ type: 'hello', name: 'Tim', hat: 0 });
    await a.wait('welcome');
    a.send({ type: 'create', mode: '1v1', isPublic: false });
    await a.wait('room');
    a.send({ type: 'setBot', slot: 1, botLevel: 1 });
    await a.wait('room', (m) => m.room.slots[1].kind === 'bot');
    const times: number[] = [];
    a.ws.on('message', (d) => { if (String(d).includes('"type":"turn"')) times.push(Date.now()); });
    a.send({ type: 'start' });
    await new Promise((r) => setTimeout(r, 3000));
    a.ws.close();
    // 3 s should hold ~30 turns; a drifting setInterval delivers noticeably fewer
    const span = times[times.length - 1] - times[0];
    const avg = span / (times.length - 1);
    expect(times.length).toBeGreaterThanOrEqual(28);
    expect(avg).toBeGreaterThan(95);
    expect(avg).toBeLessThan(104);
  });

  it('turns away a client running a different game version (would desync)', async () => {
    const old = new Client();
    await old.open();
    const closed = new Promise<number>((r) => old.ws.once('close', (code) => r(code)));
    old.send({ type: 'hello', name: 'Old', hat: 0, version: 'outdated123' });
    const err = await old.wait('error');
    expect(err.outdated).toBe(true);
    expect(await closed).toBe(4001);
    expect(old.msgs.some((m) => m.type === 'welcome')).toBe(false);

    const none = new Client(); // very old pages send no version at all
    await none.open();
    none.ws.send(JSON.stringify({ type: 'hello', name: 'Ancient', hat: 0 }));
    expect((await none.wait('error')).outdated).toBe(true);
  });

  it('serves pages uncached so players always get the current version', async () => {
    const res = await fetch(`http://localhost:${PORT}/`);
    if (res.headers.get('content-type')?.includes('text/html')) expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('serves a health check', async () => {
    const res = await fetch(`http://localhost:${PORT}/health`);
    expect((await res.json()).ok).toBe(true);
  });
});
