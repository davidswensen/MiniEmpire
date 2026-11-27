// MiniEmpire relay server: static file hosting + WebSocket lockstep relay.

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type { ClientMsg } from '@mini/shared';
import { Lobby, Session } from './rooms.ts';

const PORT = Number(process.env.PORT ?? 8080);
const here = fileURLToPath(new URL('.', import.meta.url));
const STATIC_DIR = resolve(here, '../../client/dist');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const lobby = new Lobby();

const http = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: lobby.rooms.size, sessions: lobby.sessions.size }));
    return;
  }
  if (!existsSync(STATIC_DIR)) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('MiniEmpire relay is running. Build the client (npm run build) or use the Vite dev server on :5173.');
    return;
  }
  let file = normalize(join(STATIC_DIR, decodeURIComponent(url.pathname)));
  if (!file.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(STATIC_DIR, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});

const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 16 * 1024 });

wss.on('connection', (ws) => {
  let sess: Session | null = null;
  ws.on('message', (data) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (!sess) {
      if (msg.type !== 'hello') return;
      const existing = msg.token ? lobby.sessions.get(String(msg.token)) : undefined;
      if (existing) {
        existing.ws?.close();
        sess = existing;
        sess.ws = ws;
        sess.send({ type: 'welcome', token: sess.token, rejoin: !!sess.room });
        lobby.reconnected(sess);
      } else {
        sess = new Session();
        sess.ws = ws;
        lobby.sessions.set(sess.token, sess);
        sess.send({ type: 'welcome', token: sess.token });
      }
      sess.name = String(msg.name ?? 'Player').replace(/[^\w ]/g, '').slice(0, 20) || 'Player';
      sess.hat = Math.max(0, Math.min(9, Number(msg.hat) | 0));
      return;
    }
    if (msg.type === 'hello') return;
    try {
      lobby.handle(sess, msg);
    } catch (err) {
      console.error('error handling message', msg.type, err);
    }
  });
  ws.on('close', () => {
    if (sess && sess.ws === ws) lobby.disconnected(sess);
  });
});

setInterval(() => lobby.sweep(), 10_000);

http.listen(PORT, () => {
  console.log(`MiniEmpire server on http://localhost:${PORT}  (WebSocket at /ws)`);
});
