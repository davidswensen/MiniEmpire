import './styles.css';
import {
  BOT_LEVELS, MODE_NAMES, TECHS, TECH_INDEX, MODE_SLOTS, PLAYER_COLORS, PLAYER_COLOR_NAMES, EMOTES, QUICK_CHAT, cleanCode,
  type GameMode, type GameSetup, type RoomInfo, type ServerMsg,
} from '@mini/shared';
import { sfx, unlockAudio } from './audio.ts';
import { GameSession, loadReplays, replayTurns, storeReplay, type SavedReplay, type SessionKind } from './game.ts';
import { Input } from './input.ts';
import { LocalTransport, OnlineTransport, ReplayTransport, net, type GameTransport } from './net.ts';
import { HATS, addXp, levelFor, loadProfile, randomName, saveProfile } from './profile.ts';
import { Overlay } from './render/overlay.ts';
import { Renderer } from './render/scene.ts';
import { Tutorial } from './tutorial.ts';
import { Hud } from './ui/hud.ts';

const screen = document.getElementById('screen') as HTMLElement;
const view = document.getElementById('view') as HTMLElement;
const hudRoot = document.getElementById('hud') as HTMLElement;
const overlayCanvas = document.getElementById('overlay') as HTMLCanvasElement;

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);
}
function hex(c: number): string {
  return '#' + c.toString(16).padStart(6, '0');
}

function setScreen(html: string, overGame = false): void {
  screen.innerHTML = html;
  screen.classList.toggle('over-game', overGame);
}

screen.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest('[data-go]') as HTMLElement | null;
  if (!el || (el as HTMLButtonElement).disabled) return;
  unlockAudio();
  sfx('click');
  const fn = handlers[el.dataset.go as string];
  if (fn) fn(el);
});

const handlers: Record<string, (el: HTMLElement) => void> = {};

// ---------------------------------------------------------------- game lifecycle

interface Running {
  session: GameSession;
  renderer: Renderer;
  overlay: Overlay;
  input: Input;
  hud: Hud;
  tutorial: Tutorial | null;
  raf: number;
  lastFrame: number;
  offlineConfig?: { mode: GameMode; level: number };
}

let running: Running | null = null;
let lobbyRoom: RoomInfo | null = null;
let lobbyYou = -1;
let lastResult: { replay: SavedReplay } | null = null;

function startGame(setup: GameSetup, me: number, transport: GameTransport, kind: SessionKind, code = '', offlineConfig?: Running['offlineConfig']): GameSession {
  stopGame();
  setScreen('');
  const profile = loadProfile();
  const session = new GameSession({ setup, me, transport, kind, code });
  const renderer = new Renderer(view, session.state.map, profile.quality);
  renderer.setPlayerColors(session.state.players.map((p) => p.color));
  const overlay = new Overlay(overlayCanvas);
  const hud = new Hud(hudRoot, session, renderer, overlay, { quit: () => quitGame() });
  const input = new Input(session, renderer, overlay, hud);
  hud.setInput(input);
  const tutorial = kind === 'tutorial' ? new Tutorial() : null;
  // start the camera at our castle
  const myCastle = session.state.byId.get(session.myPlayer?.castleId ?? session.state.players[0].castleId);
  if (myCastle) renderer.lookAtTile(myCastle.x / 1024, myCastle.y / 1024 + 2);
  renderer.dist = 20;
  renderer.updateCamera();

  session.onEvents = (events) => {
    renderer.onEvents(session.state, events, session);
    playEventSounds(session, renderer, events);
  };
  session.onChat = (p, i, emote) => {
    const text = emote ? EMOTES[i] : QUICK_CHAT[i];
    if (!text) return;
    hud.chatLine(p, text);
    overlay.bubble(p, text);
    sfx('chat');
  };
  session.onGameOver = () => showEnd();

  let last = performance.now();
  const frame = (now: number) => {
    if (!running || running.session !== session) return;
    const dt = Math.min(100, now - last);
    last = now;
    running.lastFrame = performance.now();
    if (session.kind !== 'online' && session.kind !== 'replay' && !session.paused) session.transport.setPaused(false);
    session.update(dt);
    input.update(dt / 1000);
    renderer.render(session, dt / 1000);
    overlay.draw(session, renderer);
    hud.update();
    tutorial?.update(session, hud);
    if (session.desynced && !screen.innerHTML) showDesync();
    running.raf = requestAnimationFrame(frame);
  };
  running = { session, renderer, overlay, input, hud, tutorial, raf: requestAnimationFrame(frame), lastFrame: performance.now(), offlineConfig };
  if (import.meta.env.DEV) (window as unknown as { __game: Running }).__game = running;
  return session;
}

function playEventSounds(g: GameSession, r: Renderer, events: import('@mini/shared').GameEvent[]): void {
  const s = g.state;
  const vol = (x: number, y: number) => {
    const dx = x / 1024 - r.target.x;
    const dz = y / 1024 - r.target.z;
    const d = Math.hypot(dx, dz);
    return Math.max(0, 1 - d / (r.dist * 1.2));
  };
  for (const ev of events) {
    switch (ev.e) {
      case 'attack':
        if (!g.visibleAt(ev.x, ev.y) && !g.visibleAt(ev.tx, ev.ty)) break;
        sfx(ev.kind === 'catapult' ? 'boom' : ev.ranged ? 'arrow' : 'sword', vol(ev.x, ev.y) * 0.7);
        break;
      case 'death':
        if (ev.building) sfx('collapse', Math.max(0.4, vol(ev.x, ev.y)));
        else if (ev.owner >= 0) sfx('death', vol(ev.x, ev.y) * 0.6);
        break;
      case 'built':
        if (ev.owner === g.me) sfx('built', 0.8);
        break;
      case 'trained':
        if (ev.owner === g.me) sfx('train', 0.5);
        break;
      case 'levelup':
        if (ev.owner === g.me) {
          sfx('levelup');
          running?.hud.flash(`⭐ Castle level ${ev.level}! New things unlocked!`);
        }
        break;
      case 'eliminated': {
        const p = s.players[ev.owner];
        running?.hud.flash(ev.owner === g.me ? '💥 Your castle fell!' : `💥 ${p.name} is out!`);
        break;
      }
      case 'research':
        if (ev.owner === g.me) {
          const t = TECHS[TECH_INDEX[ev.tech]];
          sfx('levelup', 0.7);
          running?.hud.flash(`${t?.icon ?? '🔬'} ${t?.name ?? 'Research'}${(t?.levels ?? 1) > 1 ? ` ${ev.level}` : ''} done!`);
        }
        break;
      case 'diplomacy': {
        running?.hud.refreshDiplomacy();
        if (ev.from !== g.me && ev.to !== g.me) {
          if (ev.what === 'ally' || ev.what === 'break') {
            running?.hud.flash(ev.what === 'ally' ? `🤝 ${s.players[ev.from].name} and ${s.players[ev.to].name} are now allies` : `💔 ${s.players[ev.from].name} broke the alliance with ${s.players[ev.to].name}`);
          }
          break;
        }
        const other = s.players[ev.from === g.me ? ev.to : ev.from].name;
        const mine = ev.from === g.me;
        const msg = {
          offer: mine ? `🤝 You asked ${other} to be allies` : `🤝 ${other} wants to be your ally! Press 🤝 to answer.`,
          ally: `🤝 You and ${other} are now allies!`,
          break: mine ? `💔 You broke the alliance with ${other}` : `💔 ${other} broke your alliance! Watch out!`,
          withdraw: mine ? `You cancelled your offer to ${other}` : `${other} changed their mind`,
        }[ev.what];
        sfx(ev.what === 'break' ? 'error' : 'chat');
        running?.hud.flash(msg);
        break;
      }
    }
  }
}

function stopGame(): void {
  if (!running) return;
  cancelAnimationFrame(running.raf);
  running.input.dispose();
  running.hud.dispose();
  running.renderer.dispose();
  running.session.dispose();
  const ctx = overlayCanvas.getContext('2d');
  ctx?.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  running = null;
}

function quitGame(): void {
  const r = running;
  if (r && r.session.kind !== 'replay' && r.session.runner.log.length > 50) storeReplay(r.session.toReplay());
  stopGame();
  showMenu();
}

setInterval(() => {
  // no animation frames for a while (hidden tab, minimized window): keep up with the server
  if (!running) return;
  const stalled = performance.now() - running.lastFrame > 1000;
  const g = running.session;
  if (g.kind === 'online') {
    if (stalled) g.backgroundTick();
  } else if (g.transport.canPause && g.kind !== 'replay' && !g.paused) {
    // offline: freeze the local relay while nobody is watching
    g.transport.setPaused(stalled);
  }
}, 500);

window.addEventListener('resize', () => {
  running?.renderer.resize();
  running?.overlay.resize();
});

// ---------------------------------------------------------------- end of game

function showEnd(): void {
  const r = running;
  if (!r) return;
  const g = r.session;
  const s = g.state;
  const replay = g.toReplay();
  lastResult = { replay };
  if (g.kind !== 'replay') storeReplay(replay);
  let banner = '';
  let xp = 0;
  if (g.kind === 'replay') banner = '<p class="banner win">The End</p>';
  else {
    const won = g.me >= 0 && (s.winners & (1 << g.me)) !== 0;
    banner = won ? '<p class="banner win">Victory! 🏆</p>' : '<p class="banner lose">Defeat 🛡️</p>';
    xp = won ? 100 : 40;
    const prof = loadProfile();
    if (g.kind === 'tutorial' && !prof.tutorialDone) {
      xp += 50;
      prof.tutorialDone = true;
    }
    prof.games++;
    if (won) prof.wins++;
    saveProfile(prof);
    const lv = addXp(xp);
    sfx(won ? 'victory' : 'defeat');
    if (lv.after > lv.before) setTimeout(() => running?.hud.flash(`🎉 You reached level ${lv.after}! Check Customize for new hats.`), 600);
  }
  const prof = loadProfile();
  const lvl = levelFor(prof.xp);
  const rows = s.players.map((p) => `<tr><td><span style="color:${hex(p.color)}">■</span> ${esc(p.name)}${p.slot === g.me ? ' (you)' : ''}</td>
    <td>${p.stats.trained}</td><td>${p.stats.kills}</td><td>${p.stats.lost}</td><td>${p.stats.gathered}</td><td>${p.stats.built}</td></tr>`).join('');
  const mins = Math.floor(s.tick / 1200);
  setScreen(`<div class="card wide">
    ${banner}
    <p class="subtitle">Game time ${mins}:${String(Math.floor((s.tick % 1200) / 20)).padStart(2, '0')}</p>
    <table class="stats"><tr><th>Player</th><th>Trained</th><th>Defeated</th><th>Lost</th><th>Gathered</th><th>Built</th></tr>${rows}</table>
    ${xp ? `<h3>+${xp} XP · Level ${lvl}</h3><div class="xpbar"><div style="width:${prof.xp % 100}%"></div></div>` : ''}
    <div class="row" style="margin-top:18px">
      <button class="btn blue" data-go="watch-last">🎬 Watch replay</button>
      <button class="btn ghost" data-go="download-last">💾 Save replay file</button>
      ${r.offlineConfig ? '<button class="btn green" data-go="again">🔁 Play again</button>' : ''}
      <button class="btn" data-go="menu">🏠 Menu</button>
    </div></div>`, true);
}

function showDesync(): void {
  const r = running;
  if (!r) return;
  lastResult = { replay: r.session.toReplay() };
  setScreen(`<div class="card"><h2>😵 Connection problem</h2>
    <p>The games on each computer stopped matching (a "desync"). This is a bug on our side, sorry!</p>
    <p class="muted small-text">The server saved a copy so it can be fixed. You can also save your replay file.</p>
    <div class="row"><button class="btn ghost" data-go="download-last">💾 Save replay file</button><button class="btn" data-go="menu">🏠 Menu</button></div></div>`, true);
}

function download(name: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function watchReplay(rep: SavedReplay): void {
  const t = new ReplayTransport();
  const g = startGame(rep.setup, rep.me, t, 'replay');
  for (const turn of replayTurns(rep)) g.runner.push(turn);
}

handlers['watch-last'] = () => lastResult && watchReplay(lastResult.replay);
handlers['download-last'] = () => lastResult && download(`miniempire-replay-${new Date(lastResult.replay.date).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`, lastResult.replay);
handlers.again = () => {
  const cfg = running?.offlineConfig;
  if (cfg) startOffline(cfg.mode, cfg.level);
};

// ---------------------------------------------------------------- main menu

function showMenu(): void {
  stopGame();
  lobbyRoom = null;
  const p = loadProfile();
  const lvl = levelFor(p.xp);
  setScreen(`<div class="card">
    <h1 class="title">MiniEmpire</h1>
    <p class="subtitle">Build a castle · gather wood and gold · train knights · win!</p>
    <div class="row" style="margin-bottom:14px">
      <span style="font-size:34px">${HATS[p.hat]?.icon ?? '🙂'}</span>
      <input type="text" id="nick" class="grow" maxlength="20" value="${esc(p.name)}" aria-label="Nickname" />
      <button class="btn ghost" data-go="reroll" title="Random name">🎲</button>
    </div>
    <div class="row" style="margin-bottom:6px"><span class="tag">Level ${lvl}</span><span class="tag">🏆 ${p.wins} wins</span><span class="tag">${p.games} games</span></div>
    <div class="xpbar" style="margin-bottom:18px"><div style="width:${p.xp % 100}%"></div></div>
    ${p.tutorialDone ? '' : '<button class="btn big green" data-go="tutorial" style="margin-bottom:12px">🎓 Start here: Tutorial</button>'}
    <div class="menu-grid">
      <button class="btn big" data-go="offline">🤖 Play vs Bots</button>
      <button class="btn big blue" data-go="online">🌍 Play Online</button>
      <button class="btn ghost" data-go="tutorial">🎓 Tutorial</button>
      <button class="btn ghost" data-go="customize">🎩 Customize</button>
      <button class="btn ghost" data-go="replays">🎬 Replays</button>
      <button class="btn ghost" data-go="settings">⚙️ Settings</button>
    </div>
    <p class="muted small-text" style="text-align:center;margin-top:16px">No accounts, no chat with strangers: only quick-chat buttons. Your progress stays in this browser.</p>
  </div>`);
  const nick = document.getElementById('nick') as HTMLInputElement;
  nick.addEventListener('change', () => {
    const prof = loadProfile();
    prof.name = nick.value.replace(/[^\w ]/g, '').trim().slice(0, 20) || randomName();
    saveProfile(prof);
    nick.value = prof.name;
    net.refreshHello();
  });
}

handlers.menu = () => {
  if (lobbyRoom) net.send({ type: 'leave' });
  showMenu();
};
handlers.reroll = () => {
  const p = loadProfile();
  p.name = randomName();
  saveProfile(p);
  net.refreshHello();
  showMenu();
};

// ---------------------------------------------------------------- offline vs bots

let offMode: GameMode = '1v1';
let offLevel = 2;

function showOffline(): void {
  const modes: GameMode[] = ['1v1', '2v2', 'ffa3', 'ffa4'];
  setScreen(`<div class="card">
    <h2>🤖 Play vs Bots</h2>
    <h3>Game type</h3>
    <div class="seg">${modes.map((m) => `<button class="${m === offMode ? 'on' : ''}" data-go="offmode" data-v="${m}">${MODE_NAMES[m]}</button>`).join('')}</div>
    <p class="muted small-text">${offMode === '2v2' ? 'You and a bot friend vs two bots.' : 'Everyone else is a bot.'}</p>
    <h3>Bot difficulty</h3>
    <div class="seg">${[1, 2, 3].map((l) => `<button class="${l === offLevel ? 'on' : ''}" data-go="offlevel" data-v="${l}">${BOT_LEVELS[l]}</button>`).join('')}</div>
    <div class="row" style="margin-top:20px"><button class="btn ghost" data-go="menu">⬅ Back</button><button class="btn big green grow" data-go="offstart">▶ Start!</button></div>
  </div>`);
}

function startOffline(mode: GameMode, level: number): void {
  const prof = loadProfile();
  const teams = MODE_SLOTS[mode];
  const setup: GameSetup = {
    seed: (Math.random() * 2 ** 31) | 0,
    mode,
    players: teams.map((team, i) => i === 0
      ? { name: prof.name, team, isBot: false, botLevel: 0, hat: prof.hat }
      : { name: `${['', 'Sir Clank', 'Lady Bolt', 'Baron Gear'][i]} (bot)`, team, isBot: true, botLevel: level, hat: (i * 2) % HATS.length }),
  };
  startGame(setup, 0, new LocalTransport(0), 'offline', '', { mode, level });
}

handlers.offline = () => showOffline();
handlers.offmode = (el) => {
  offMode = el.dataset.v as GameMode;
  showOffline();
};
handlers.offlevel = (el) => {
  offLevel = Number(el.dataset.v);
  showOffline();
};
handlers.offstart = () => startOffline(offMode, offLevel);

handlers.tutorial = () => {
  const prof = loadProfile();
  const setup: GameSetup = {
    seed: 12345,
    mode: '1v1',
    players: [
      { name: prof.name, team: 0, isBot: false, botLevel: 0, hat: prof.hat },
      { name: 'Sleepy Sam (bot)', team: 1, isBot: true, botLevel: 0, hat: 1 },
    ],
  };
  startGame(setup, 0, new LocalTransport(0), 'tutorial');
};

// ---------------------------------------------------------------- online

let createMode: GameMode = '1v1';
let createPublic = false;
let onlineError = '';

function showOnline(): void {
  lobbyRoom = null;
  net.open();
  const status = net.connected ? '<span class="tag good">● Connected</span>' : '<span class="tag">● Connecting…</span>';
  const modes: GameMode[] = ['1v1', '2v2', 'ffa3', 'ffa4'];
  setScreen(`<div class="card">
    <div class="row"><h2 class="grow" style="margin:0">🌍 Play Online</h2>${status}</div>
    ${onlineError ? `<p style="color:#fca5a5">${esc(onlineError)}</p>` : ''}
    <h3>Play with a friend</h3>
    <div class="row"><input type="text" id="code" class="code-input" maxlength="4" placeholder="CODE" autocomplete="off" />
      <button class="btn blue" data-go="join">Join room</button></div>
    <h3>Make a room</h3>
    <div class="seg">${modes.map((m) => `<button class="${m === createMode ? 'on' : ''}" data-go="cmode" data-v="${m}">${MODE_NAMES[m]}</button>`).join('')}</div>
    <div class="seg" style="margin-top:8px">
      <button class="${!createPublic ? 'on' : ''}" data-go="cpub" data-v="0">🔒 Friends only (code)</button>
      <button class="${createPublic ? 'on' : ''}" data-go="cpub" data-v="1">🌐 Anyone can join</button>
    </div>
    <div class="row" style="margin-top:10px"><button class="btn green" data-go="create">➕ Create room</button></div>
    <h3>Quick play</h3>
    <button class="btn big" data-go="quick">⚡ Find a 1 vs 1 game</button>
    <div class="row" style="margin-top:18px"><button class="btn ghost" data-go="menu">⬅ Back</button></div>
  </div>`);
  const code = document.getElementById('code') as HTMLInputElement;
  code.addEventListener('input', () => { code.value = cleanCode(code.value); });
  code.addEventListener('keydown', (e) => { if (e.key === 'Enter') handlers.join(code); });
}

handlers.online = () => {
  onlineError = '';
  showOnline();
};
handlers.cmode = (el) => {
  createMode = el.dataset.v as GameMode;
  showOnline();
};
handlers.cpub = (el) => {
  createPublic = el.dataset.v === '1';
  showOnline();
};
handlers.create = () => net.send({ type: 'create', mode: createMode, isPublic: createPublic });
handlers.quick = () => net.send({ type: 'quick' });
handlers.join = () => {
  const code = cleanCode((document.getElementById('code') as HTMLInputElement | null)?.value ?? '');
  if (code.length !== 4) {
    onlineError = 'Room codes have 4 letters';
    showOnline();
    return;
  }
  net.send({ type: 'join', code });
};

function showLobby(): void {
  const room = lobbyRoom;
  if (!room) return;
  const you = lobbyYou;
  const isHost = room.host === you;
  const full = room.slots.every((s) => s.kind !== 'open');
  const allReady = room.slots.every((s, i) => s.kind !== 'human' || i === room.host || s.ready);
  const slots = room.slots.map((s, i) => {
    const color = PLAYER_COLORS[i];
    let body = '';
    if (s.kind === 'open') {
      body = `<span class="grow muted">Waiting for a player…</span>${isHost ? [1, 2, 3].map((l) => `<button class="btn small ghost" data-go="addbot" data-slot="${i}" data-v="${l}">+ ${BOT_LEVELS[l]} bot</button>`).join('') : ''}`;
    } else if (s.kind === 'bot') {
      body = `<span class="grow">🤖 ${esc(s.name)} <span class="tag">${BOT_LEVELS[s.botLevel]}</span></span>${isHost ? `<button class="btn small ghost" data-go="rmbot" data-slot="${i}">✖</button>` : ''}`;
    } else {
      body = `<span class="grow">${HATS[s.hat]?.icon ?? ''} ${esc(s.name)}${i === you ? ' (you)' : ''}</span>
        ${i === room.host ? '<span class="tag">👑 Host</span>' : s.ready ? '<span class="tag good">✔ Ready</span>' : '<span class="tag">Not ready</span>'}`;
    }
    return `<div class="slot"><div class="swatch" style="background:${hex(color)}" title="${PLAYER_COLOR_NAMES[i]}"></div><span class="tag">Team ${s.team + 1}</span>${body}</div>`;
  }).join('');
  const me = room.slots[you];
  setScreen(`<div class="card">
    <h2>🏰 Room</h2>
    <p class="muted" style="margin:0;text-align:center">Tell your friend this code:</p>
    <div class="big-code">${room.code}</div>
    <p class="muted" style="text-align:center;margin-top:-6px">${MODE_NAMES[room.mode]} · ${room.isPublic ? 'anyone can join' : 'friends only'}</p>
    ${onlineError ? `<p style="color:#fca5a5">${esc(onlineError)}</p>` : ''}
    ${slots}
    <div class="row" style="margin-top:14px">
      <button class="btn ghost" data-go="menu">🚪 Leave</button>
      ${isHost && !full ? '<button class="btn ghost" data-go="fillbots">🤖 Fill with bots</button>' : ''}
      <span class="grow"></span>
      ${isHost
        ? `<button class="btn green" data-go="start" ${full && allReady ? '' : 'disabled'}>▶ Start game</button>`
        : `<button class="btn ${me?.ready ? 'ghost' : 'green'}" data-go="ready">${me?.ready ? 'Not ready' : '✔ I\'m ready!'}</button>`}
    </div>
    ${isHost && !full ? '<p class="hint">Fill every slot with a friend or a bot to start.</p>' : ''}
    ${isHost && full && !allReady ? '<p class="hint">Waiting for everyone to press Ready.</p>' : ''}
  </div>`);
}

handlers.addbot = (el) => net.send({ type: 'setBot', slot: Number(el.dataset.slot), botLevel: Number(el.dataset.v) });
handlers.rmbot = (el) => net.send({ type: 'setBot', slot: Number(el.dataset.slot), botLevel: -1 });
handlers.fillbots = () => {
  lobbyRoom?.slots.forEach((s, i) => {
    if (s.kind === 'open') net.send({ type: 'setBot', slot: i, botLevel: 2 });
  });
};
handlers.ready = () => net.send({ type: 'ready', ready: !lobbyRoom?.slots[lobbyYou]?.ready });
handlers.start = () => net.send({ type: 'start' });

net.on((m: ServerMsg) => {
  switch (m.type) {
    case 'room':
      if (running) return;
      lobbyRoom = m.room;
      lobbyYou = m.you;
      onlineError = '';
      showLobby();
      break;
    case 'error':
      onlineError = m.msg;
      sfx('error');
      if (m.outdated && running) {
        setScreen(`<div class="card"><h2>🔄 New version</h2><p>${esc(m.msg)}</p><div class="row"><button class="btn" data-go="menu">🏠 Menu</button></div></div>`, true);
        break;
      }
      if (lobbyRoom) showLobby();
      else if (!running) showOnline();
      break;
    case 'start':
      lobbyRoom = null;
      startGame(m.setup, m.you, new OnlineTransport(), 'online', m.code);
      break;
    case 'history': {
      // reconnecting: resume the same match if it is already open, else rebuild it
      if (running && running.session.kind === 'online' && running.session.code === m.code) return; // transport pushes the turns
      lobbyRoom = null;
      const t = new OnlineTransport();
      startGame(m.setup, m.you, t, 'online', m.code);
      for (const turn of m.turns) running?.session.runner.push(turn);
      break;
    }
    case 'left':
      if (!running) showMenu();
      break;
  }
});
net.onStatus = (c) => {
  if (!running && !lobbyRoom && screen.querySelector('[data-go="quick"]')) showOnline();
  if (running?.session.kind === 'online') running.hud.flash(c ? '📡 Reconnected!' : '📡 Connection lost… trying again');
};

// ---------------------------------------------------------------- customize, replays, settings

function showCustomize(): void {
  const p = loadProfile();
  const lvl = levelFor(p.xp);
  setScreen(`<div class="card">
    <h2>🎩 Customize</h2>
    <p class="muted">Hats show up on all your workers and soldiers. Play games to level up and unlock more!</p>
    <div class="hat-grid">${HATS.map((h, i) => `<button class="hat ${p.hat === i ? 'on' : ''}" data-go="hat" data-v="${i}" ${lvl >= h.level ? '' : 'disabled'}>
      <span class="em">${lvl >= h.level ? h.icon : '🔒'}</span>${esc(h.name)}${lvl >= h.level ? '' : `<br><span class="small-text muted">Level ${h.level}</span>`}</button>`).join('')}</div>
    <div class="row" style="margin-top:18px"><button class="btn ghost" data-go="menu">⬅ Back</button></div>
  </div>`);
}
handlers.customize = () => showCustomize();
handlers.hat = (el) => {
  const p = loadProfile();
  p.hat = Number(el.dataset.v);
  saveProfile(p);
  net.refreshHello();
  showCustomize();
};

function showReplays(): void {
  const list = loadReplays();
  setScreen(`<div class="card">
    <h2>🎬 Replays</h2>
    ${list.length === 0 ? '<p class="muted">No replays yet. Finish a game and it will show up here!</p>' : ''}
    ${list.map((r, i) => `<div class="slot"><span class="grow">${new Date(r.date).toLocaleString()} · ${MODE_NAMES[r.setup.mode]} · ${Math.round(r.total / 600)} min<br>
      <span class="small-text muted">${r.setup.players.map((p) => esc(p.name)).join(' vs ')}</span></span>
      <button class="btn small blue" data-go="watch" data-i="${i}">▶ Watch</button><button class="btn small ghost" data-go="dl" data-i="${i}">💾</button></div>`).join('')}
    <div class="row" style="margin-top:12px">
      <button class="btn ghost" data-go="menu">⬅ Back</button>
      <label class="btn ghost" style="display:inline-flex;align-items:center">📂 Open replay file<input type="file" id="rfile" accept=".json,application/json" hidden /></label>
    </div>
  </div>`);
  const f = document.getElementById('rfile') as HTMLInputElement;
  f.addEventListener('change', async () => {
    const file = f.files?.[0];
    if (!file) return;
    try {
      const rep = JSON.parse(await file.text()) as SavedReplay;
      if (rep.v !== 1 || !rep.setup || !Array.isArray(rep.turns)) throw new Error('bad file');
      watchReplay(rep);
    } catch {
      alert('That is not a MiniEmpire replay file.');
    }
  });
}
handlers.replays = () => showReplays();
handlers.watch = (el) => {
  const r = loadReplays()[Number(el.dataset.i)];
  if (r) watchReplay(r);
};
handlers.dl = (el) => {
  const r = loadReplays()[Number(el.dataset.i)];
  if (r) download(`miniempire-replay-${r.date}.json`, r);
};

function showSettings(): void {
  const p = loadProfile();
  setScreen(`<div class="card">
    <h2>⚙️ Settings</h2>
    <h3>Sound</h3>
    <div class="seg"><button class="${p.sound ? 'on' : ''}" data-go="snd" data-v="1">🔊 On</button><button class="${!p.sound ? 'on' : ''}" data-go="snd" data-v="0">🔇 Off</button></div>
    <h3>Graphics</h3>
    <div class="seg"><button class="${p.quality === 'high' ? 'on' : ''}" data-go="gfx" data-v="high">✨ Pretty (shadows)</button><button class="${p.quality === 'low' ? 'on' : ''}" data-go="gfx" data-v="low">⚡ Fast (for Chromebooks)</button></div>
    <h3>Reset</h3>
    <button class="btn red small" data-go="reset">Reset my progress</button>
    <div class="row" style="margin-top:18px"><button class="btn ghost" data-go="menu">⬅ Back</button></div>
  </div>`);
}
handlers.settings = () => showSettings();
handlers.snd = (el) => {
  const p = loadProfile();
  p.sound = el.dataset.v === '1';
  saveProfile(p);
  showSettings();
};
handlers.gfx = (el) => {
  const p = loadProfile();
  p.quality = el.dataset.v as 'high' | 'low';
  saveProfile(p);
  showSettings();
};
handlers.reset = () => {
  if (!confirm('Reset level, wins and hats?')) return;
  const p = loadProfile();
  Object.assign(p, { xp: 0, wins: 0, games: 0, hat: 1, tutorialDone: false });
  saveProfile(p);
  showSettings();
};

// ---------------------------------------------------------------- boot

showMenu();
// If this tab was in an online game before a reload, the server will send the history.
try {
  if (sessionStorage.getItem('miniempire.token')) net.open();
} catch {
  /* ignore */
}
