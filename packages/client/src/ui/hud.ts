// In-game HUD (plain DOM): resources, selection panel, actions, minimap, chat, menus.

import {
  BUILD_MENU, BUILDINGS, CASTLE_UPGRADES, EMOTES, FP, MAX_POP, QUICK_CHAT, RESOURCES, TECHS, TECH_INDEX, TECH_PREFIX,
  Tile, UNITS, UPGRADE_ITEM, areFriends, researchesAt, techCost,
  type Cost,
} from '@mini/shared';
import { sfx } from '../audio.ts';
import type { GameSession } from '../game.ts';
import type { Input } from '../input.ts';
import { loadProfile, saveProfile } from '../profile.ts';
import type { Overlay } from '../render/overlay.ts';
import type { Renderer } from '../render/scene.ts';

const HOTKEYS = 'qertfgzxcvbnm';

function queueIcon(q: string): string {
  if (q === UPGRADE_ITEM) return '⭐';
  if (q.startsWith(TECH_PREFIX)) return TECHS[TECH_INDEX[q.slice(TECH_PREFIX.length)]]?.icon ?? '🔬';
  return UNITS[q]?.icon ?? '?';
}

function queueName(q: string): string {
  if (q === UPGRADE_ITEM) return 'Castle upgrade';
  if (q.startsWith(TECH_PREFIX)) return TECHS[TECH_INDEX[q.slice(TECH_PREFIX.length)]]?.name ?? 'Research';
  return UNITS[q]?.name ?? q;
}

function costHtml(c: Cost): string {
  const parts: string[] = [];
  if (c.wood) parts.push(`🪵${c.wood}`);
  if (c.gold) parts.push(`🪙${c.gold}`);
  return parts.join(' ') || 'free';
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);
}

function hex(c: number): string {
  return '#' + c.toString(16).padStart(6, '0');
}

export interface HudCallbacks {
  quit(): void;
}

export class Hud {
  readonly root: HTMLElement;
  private g: GameSession;
  private r: Renderer;
  readonly overlay: Overlay;
  private input!: Input;
  private cb: HudCallbacks;
  private panel!: HTMLElement;
  private topbar!: HTMLElement;
  private feed!: HTMLElement;
  private popup!: HTMLElement;
  private tutorialBox!: HTMLElement;
  private waitBox!: HTMLElement;
  private topRight!: HTMLElement;
  private replayBar!: HTMLElement;
  private minimap!: HTMLCanvasElement;
  private miniBase: ImageData | null = null;
  private sig = '';
  private lastPanel = 0;
  private lastMini = 0;
  private lastTop = '';
  private actions = new Map<string, () => void>();
  private hotkeyMap = new Map<string, string>();
  private toastEl: HTMLElement;
  private popupKind = '';

  constructor(root: HTMLElement, g: GameSession, r: Renderer, o: Overlay, cb: HudCallbacks) {
    this.root = root;
    this.g = g;
    this.r = r;
    this.overlay = o;
    this.cb = cb;
    this.toastEl = document.getElementById('toast') as HTMLElement;
    this.build();
  }

  setInput(i: Input): void {
    this.input = i;
  }

  private build(): void {
    const replay = this.g.kind === 'replay';
    this.root.innerHTML = `
      <div class="top-left">
        <button class="icon-btn" data-act="menu" title="Menu">☰</button>
        ${replay ? '' : '<button class="icon-btn" data-act="chat" title="Quick chat">💬</button>'}
        <button class="icon-btn" data-act="help" title="How to play">❓</button>
        ${!replay && this.g.state.diplomacy && this.g.me >= 0 ? '<button class="icon-btn" data-act="diplo" title="Alliances">🤝</button>' : ''}
      </div>
      <div class="topbar"></div>
      <div class="top-right">
        ${replay ? '' : `
        <button class="icon-btn" data-act="idle" title="Next idle worker (.)">🧑‍🌾</button>
        <button class="icon-btn" data-act="army" title="Select army (Tab)">⚔️</button>
        <button class="icon-btn" data-act="castle" title="Go to castle (H)">🏰</button>
        <button class="icon-btn touch-only" data-act="boxmode" title="Box select">⬚</button>`}
      </div>
      <div class="chat-feed"></div>
      <div class="tutorial hidden"></div>
      <div class="replay-bar ${replay ? '' : 'hidden'}"></div>
      <div class="waiting hidden"></div>
      <div class="popup hidden"></div>
      <div class="bottom">
        <div class="minimap-wrap"><canvas id="minimap" width="168" height="168"></canvas></div>
        <div class="panel"></div>
      </div>`;
    this.root.classList.remove('hidden');
    this.panel = this.root.querySelector('.panel') as HTMLElement;
    this.topbar = this.root.querySelector('.topbar') as HTMLElement;
    this.feed = this.root.querySelector('.chat-feed') as HTMLElement;
    this.popup = this.root.querySelector('.popup') as HTMLElement;
    this.tutorialBox = this.root.querySelector('.tutorial') as HTMLElement;
    this.waitBox = this.root.querySelector('.waiting') as HTMLElement;
    this.topRight = this.root.querySelector('.top-right') as HTMLElement;
    this.replayBar = this.root.querySelector('.replay-bar') as HTMLElement;
    this.minimap = this.root.querySelector('#minimap') as HTMLCanvasElement;
    if (!('ontouchstart' in window)) this.root.querySelectorAll('.touch-only').forEach((el) => el.classList.add('hidden'));
    this.root.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
      if (!el || (el as HTMLButtonElement).disabled) return;
      e.stopPropagation();
      this.run(el.dataset.act as string, el);
    });
    this.root.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.bindMinimap();
    if (replay) this.renderReplayBar();
  }

  // ---------------------------------------------------------------- actions

  private run(act: string, el: HTMLElement): void {
    const g = this.g;
    sfx('click');
    if (act.startsWith('dyn:')) {
      this.actions.get(act)?.();
      return;
    }
    switch (act) {
      case 'menu': this.togglePopup('menu'); break;
      case 'chat': this.togglePopup('chat'); break;
      case 'help': this.togglePopup('help'); break;
      case 'diplo': this.togglePopup('diplo'); break;
      case 'ally':
        g.command({ t: 'ally', target: Number(el.dataset.p) });
        break;
      case 'unally':
        g.command({ t: 'unally', target: Number(el.dataset.p) });
        break;
      case 'close': this.closePopup(); break;
      case 'idle': this.input.selectIdleWorker(); break;
      case 'army': this.input.selectArmy(); break;
      case 'castle': this.input.selectCastle(); break;
      case 'boxmode':
        this.input.boxMode = !this.input.boxMode;
        el.classList.toggle('on', this.input.boxMode);
        this.flash(this.input.boxMode ? 'Drag to select a group' : 'Drag to move the map');
        break;
      case 'quick': {
        const i = Number(el.dataset.i);
        g.transport.sendChat(i, el.dataset.emote === '1');
        this.closePopup();
        break;
      }
      case 'pause':
        g.paused = !g.paused;
        g.transport.setPaused(g.paused);
        this.closePopup();
        this.flash(g.paused ? 'Paused' : 'Go!');
        break;
      case 'sound': {
        const p = loadProfile();
        p.sound = !p.sound;
        saveProfile(p);
        this.togglePopup('menu', true);
        break;
      }
      case 'resign':
        if (g.kind === 'replay' || !g.myPlayer?.alive || g.state.over) this.cb.quit();
        else {
          g.command({ t: 'resign' });
          this.closePopup();
        }
        break;
      case 'quit': this.cb.quit(); break;
      case 'speed':
        g.speed = Number(el.dataset.v);
        g.paused = false;
        this.renderReplayBar();
        break;
      case 'rpause':
        g.paused = !g.paused;
        this.renderReplayBar();
        break;
      case 'place-ok': this.input.placeNow(false); break;
      case 'place-cancel':
        g.placing = null;
        this.refresh();
        break;
    }
  }

  private renderReplayBar(): void {
    const g = this.g;
    const speeds = [1, 2, 4, 8];
    this.replayBar.innerHTML = `<span class="tag">🎬 Replay</span>
      <button class="btn small ghost" data-act="rpause">${g.paused ? '▶️' : '⏸️'}</button>
      ${speeds.map((s) => `<button class="btn small ${g.speed === s && !g.paused ? '' : 'ghost'}" data-act="speed" data-v="${s}">${s}x</button>`).join('')}`;
  }

  hotkey(k: string): boolean {
    const act = this.hotkeyMap.get(k);
    if (!act) return false;
    const el = this.panel.querySelector(`[data-act="${act}"]`) as HTMLButtonElement | null;
    if (el && el.disabled) {
      sfx('error');
      return true;
    }
    this.actions.get(act)?.();
    sfx('click');
    return true;
  }

  flash(msg: string): void {
    const d = document.createElement('div');
    d.className = 'toast';
    d.textContent = msg;
    this.toastEl.appendChild(d);
    setTimeout(() => d.remove(), 3500);
  }

  chatLine(p: number, text: string): void {
    const pl = this.g.state.players[p];
    if (!pl) return;
    const d = document.createElement('div');
    d.className = 'chat-line';
    d.innerHTML = `<span style="color:${hex(pl.color)}">${esc(pl.name)}:</span> ${esc(text)}`;
    this.feed.appendChild(d);
    while (this.feed.children.length > 5) this.feed.firstChild?.remove();
    setTimeout(() => d.remove(), 7000);
  }

  setTutorial(html: string | null): void {
    this.tutorialBox.classList.toggle('hidden', !html);
    if (html) this.tutorialBox.innerHTML = html;
  }

  refresh(): void {
    this.sig = '';
  }

  private togglePopup(kind: string, keep = false): void {
    if (this.popupKind === kind && !keep) {
      this.closePopup();
      return;
    }
    this.popupKind = kind;
    const g = this.g;
    let html = '';
    if (kind === 'menu') {
      const snd = loadProfile().sound;
      html = `<h2>Menu</h2>
        ${g.transport.canPause && g.kind !== 'replay' ? `<button class="btn blue" data-act="pause">${g.paused ? '▶️ Resume' : '⏸️ Pause'}</button>` : ''}
        <button class="btn ghost" data-act="sound">${snd ? '🔊 Sound: on' : '🔇 Sound: off'}</button>
        ${g.kind !== 'replay' && g.myPlayer?.alive && !g.state.over ? '<button class="btn red" data-act="resign">🏳️ Give up</button>' : ''}
        <button class="btn ghost" data-act="quit">🚪 Leave game</button>
        <button class="btn ghost" data-act="close">Close</button>`;
    } else if (kind === 'chat') {
      html = `<h2>Quick chat</h2>
        <div class="emote-row">${EMOTES.map((e, i) => `<button data-act="quick" data-i="${i}" data-emote="1">${e}</button>`).join('')}</div>
        ${QUICK_CHAT.map((t, i) => `<button class="btn small ghost" data-act="quick" data-i="${i}">${esc(t)}</button>`).join('')}`;
    } else if (kind === 'diplo') {
      html = this.diploHtml();
    } else if (kind === 'help') {
      html = `<h2>How to play</h2>
        <p><b>Goal:</b> destroy the enemy castle 🏰 and protect yours!</p>
        <p>🧑‍🌾 <b>Workers</b> chop 🪵 wood and mine 🪙 gold. Click a worker, then click a tree or gold rock.</p>
        <p>🏠 Build <b>houses</b> to grow your army. Upgrade your castle to unlock knights, rams and catapults.</p>
        <h3>Who beats who</h3>
        <p>🗡️ Swordsman beats 🐴 Knight<br>🐴 Knight beats 🏹 Archer<br>🏹 Archer beats 🗡️ Swordsman<br>🪵 Rams, ☄️ catapults, 🏗️ trebuchets and 💣 cannons smash buildings</p>
        <h3>Flyers</h3>
        <p>🦅 Griffins, 🦎 wyverns and 🐉 dragons fly over water and walls. Only archers, towers, ships, other flyers and especially 🎯 ballistas can hit them.</p>
        <h3>Upgrades</h3>
        <p>Click your 🏰 castle, ⚒️ blacksmith, 🔨 workshop, ⚓ dock or 🪺 roost to research stronger soldiers, workers, ships and dragons.</p>
        <h3>Alliances</h3>
        <p>In free-for-all games press 🤝 to ask another player to be allies. Allies share vision and win together. You can break an alliance any time.</p>
        <h3>Controls</h3>
        <p class="small-text">Click to select · drag a box for many · click ground, trees or enemies to give orders · right-click works too · WASD / arrows / drag to move the map · wheel or pinch to zoom · H = castle · . = idle worker · Tab = army · Ctrl+1-9 save group, 1-9 pick group · Esc = cancel</p>
        <button class="btn ghost" data-act="close">Got it!</button>`;
    }
    this.popup.innerHTML = html;
    this.popup.classList.remove('hidden');
  }

  /** Rebuild the alliances popup if it is open (called after diplomacy events). */
  refreshDiplomacy(): void {
    if (this.popupKind === 'diplo') this.popup.innerHTML = this.diploHtml();
  }

  private diploHtml(): string {
    const g = this.g;
    const s = g.state;
    const me = s.players[g.me];
    const rows = s.players.filter((p) => p.slot !== g.me).map((p) => {
      const name = `<span style="color:${hex(p.color)};font-weight:800">■ ${esc(p.name)}</span>`;
      const bit = 1 << p.slot;
      let status: string;
      let btn = '';
      if (!p.alive) status = '💀 Out';
      else if (me.allies & bit) {
        status = '<span class="tag good">🤝 Ally</span>';
        btn = `<button class="btn small red" data-act="unally" data-p="${p.slot}">💔 Break</button>`;
      } else if (p.offers & (1 << g.me)) {
        status = '<span class="tag">Wants to be your ally!</span>';
        btn = `<button class="btn small green" data-act="ally" data-p="${p.slot}">🤝 Accept</button>`;
      } else if (me.offers & bit) {
        status = '<span class="tag">Asked… waiting</span>';
        btn = `<button class="btn small ghost" data-act="unally" data-p="${p.slot}">Cancel</button>`;
      } else {
        status = '<span class="tag">⚔️ Enemy</span>';
        btn = `<button class="btn small blue" data-act="ally" data-p="${p.slot}">🤝 Ask</button>`;
      }
      return `<div class="slot"><span class="grow">${name}<br>${status}</span>${me.alive ? btn : ''}</div>`;
    }).join('');
    return `<h2>🤝 Alliances</h2><p class="small-text muted">Allies share vision, never fight, and win together. Anyone can break an alliance at any time.</p>${rows}
      <button class="btn ghost" data-act="close">Close</button>`;
  }

  private closePopup(): void {
    this.popupKind = '';
    this.popup.classList.add('hidden');
  }

  // ---------------------------------------------------------------- per frame

  update(): void {
    const g = this.g;
    const s = g.state;
    const now = performance.now();
    // top bar
    const p = g.myPlayer;
    const mins = Math.floor(s.tick / 1200);
    const secs = Math.floor((s.tick % 1200) / 20);
    const time = `${mins}:${String(secs).padStart(2, '0')}`;
    let top: string;
    if (p && g.kind !== 'replay') {
      const popFull = p.pop >= p.popCap && p.popCap < MAX_POP;
      top = `<span class="res" title="Wood">🪵 ${p.wood}</span><span class="res" title="Gold">🪙 ${p.gold}</span>
        <span class="res ${popFull ? 'flash' : ''}" title="Army size (build houses for more)">👥 ${p.pop}/${p.popCap}</span>
        <span class="res" title="Castle level">🏰 Lv ${p.level}</span><span class="res">⏱ ${time}</span>`;
    } else {
      top = s.players.map((pl) => `<span class="res" style="color:${hex(pl.color)}">${pl.alive ? '' : '💀'}${esc(pl.name)} 🪵${pl.wood} 🪙${pl.gold} 👥${pl.pop}</span>`).join('') + `<span class="res">⏱ ${time}</span>`;
    }
    if (top !== this.lastTop) {
      this.topbar.innerHTML = top;
      this.lastTop = top;
    }
    // waiting / catching up / defeated messages
    let wait = '';
    if (g.catchingUp) wait = '⏩ Catching up…';
    else if (g.waiting) wait = '📡 Waiting for the server…';
    else if (g.paused && g.kind !== 'replay') wait = '⏸️ Paused';
    else if (p && !p.alive && !s.over && g.kind !== 'replay') wait = '💥 Your castle fell! You can keep watching.';
    this.waitBox.classList.toggle('hidden', !wait);
    if (wait && this.waitBox.textContent !== wait) this.waitBox.textContent = wait;
    // idle worker badge
    const idleBtn = this.topRight.querySelector('[data-act="idle"]');
    if (idleBtn) {
      const idle = s.entities.filter((e) => e.owner === g.me && e.kind === 'worker' && e.order === 0 && !e.inside).length;
      idleBtn.textContent = idle > 0 ? `🧑‍🌾${idle}` : '🧑‍🌾';
    }
    // panel
    const sig = this.signature();
    if (sig !== this.sig && now - this.lastPanel > 120) {
      this.sig = sig;
      this.lastPanel = now;
      this.renderPanel();
    }
    this.updateBars();
    if (now - this.lastMini > 200) {
      this.lastMini = now;
      this.drawMinimap();
    }
  }

  private signature(): string {
    const g = this.g;
    const p = g.myPlayer;
    const sel = g.selected();
    const parts: (string | number)[] = [sel.map((e) => e.id).join(','), g.placing ? `${g.placing.kind}:${g.placing.ok}` : '', g.rallyMode ? 'r' : '', this.input?.touchUI ? 't' : ''];
    if (p) parts.push(p.level, p.pop >= p.popCap ? 'full' : '', p.tech.join(''));
    if (p) for (const e of sel.slice(0, 1)) if (e.kind in BUILDINGS) parts.push(g.state.entities.filter((x) => x.owner === g.me).flatMap((x) => x.queue).filter((q) => q.startsWith(TECH_PREFIX)).join(','));
    for (const e of sel.slice(0, 1)) parts.push(e.done ? 1 : 0, e.queue.join('+'), e.cargo.length, e.kind);
    if (sel.length > 1) parts.push(sel.map((e) => e.kind).sort().join(','));
    // affordability of every action that might be shown
    if (p) {
      const aff: string[] = [];
      const check = (c: Cost) => (p.wood >= c.wood && p.gold >= c.gold ? '1' : '0');
      for (const k of BUILD_MENU) aff.push(check(BUILDINGS[k].cost));
      for (const k of Object.keys(UNITS)) aff.push(check(UNITS[k].cost));
      const up = CASTLE_UPGRADES[p.level];
      if (up) aff.push(check(up.cost));
      parts.push(aff.join(''));
    }
    return parts.join('|');
  }

  private updateBars(): void {
    const s = this.g.state;
    this.panel.querySelectorAll<HTMLElement>('[data-hp]').forEach((el) => {
      const e = s.byId.get(Number(el.dataset.hp));
      if (e) el.style.width = `${Math.max(0, (e.hp / e.maxHp) * 100)}%`;
    });
    this.panel.querySelectorAll<HTMLElement>('[data-qp]').forEach((el) => {
      const e = s.byId.get(Number(el.dataset.qp));
      if (!e || e.queue.length === 0) return;
      const item = e.queue[0];
      const total = item === UPGRADE_ITEM
        ? CASTLE_UPGRADES[s.players[e.owner].level]?.time ?? 1
        : item.startsWith(TECH_PREFIX) ? TECHS[TECH_INDEX[item.slice(TECH_PREFIX.length)]]?.time ?? 1 : UNITS[item]?.trainTime ?? 1;
      el.style.width = `${Math.min(100, (e.queueTime / total) * 100)}%`;
    });
    this.panel.querySelectorAll<HTMLElement>('[data-bp]').forEach((el) => {
      const e = s.byId.get(Number(el.dataset.bp));
      if (e && BUILDINGS[e.kind]) el.textContent = `${Math.floor((e.progress / BUILDINGS[e.kind].buildTime) * 100)}%`;
    });
    this.panel.querySelectorAll<HTMLElement>('[data-amt]').forEach((el) => {
      const e = s.byId.get(Number(el.dataset.amt));
      if (e) el.textContent = String(e.amount);
    });
  }

  private act(id: string, icon: string, label: string, sub: string, enabled: boolean, fn: () => void, on = false, title = ''): string {
    const key = HOTKEYS[this.actions.size];
    const act = `dyn:${id}`;
    this.actions.set(act, fn);
    if (key) this.hotkeyMap.set(key, act);
    return `<button class="act ${on ? 'on' : ''}" data-act="${act}" ${enabled ? '' : 'disabled'} title="${esc(title || label)}">
      ${key ? `<span class="key">${key.toUpperCase()}</span>` : ''}<span class="em">${icon}</span><span>${esc(label)}</span>${sub ? `<span class="cost">${sub}</span>` : ''}</button>`;
  }

  private renderPanel(): void {
    const g = this.g;
    const s = g.state;
    const p = g.myPlayer;
    this.actions.clear();
    this.hotkeyMap.clear();
    const sel = g.selected();
    let html = '';
    const afford = (c: Cost) => !!p && p.wood >= c.wood && p.gold >= c.gold;

    if (g.placing && this.input?.touchUI) {
      const bd = BUILDINGS[g.placing.kind];
      html += `<div class="sel-head"><div class="portrait">${bd.icon}</div><div><div class="sel-name">Place ${esc(bd.name)}</div><div class="hint">Tap the map to move it, then press ✔</div></div></div>
        <div class="row"><button class="btn green" data-act="place-ok" ${g.placing.ok ? '' : 'disabled'}>✔ Build here</button><button class="btn ghost" data-act="place-cancel">✖ Cancel</button></div>`;
      this.panel.innerHTML = html;
      return;
    }

    if (sel.length === 0) {
      html = `<div class="sel-name">${g.kind === 'replay' ? '🎬 Watching a replay' : '👋 Nothing selected'}</div>
        <div class="hint">${g.kind === 'replay' ? 'Click anything to see what it is. Use the speed buttons at the top.' : 'Click a worker 🧑‍🌾 to gather and build, or your castle 🏰 to train more workers. Drag a box to select many.'}</div>`;
      this.panel.innerHTML = html;
      return;
    }

    const first = sel[0];
    const own = first.owner === g.me && g.kind !== 'replay';
    const ud = UNITS[first.kind];
    const bd = BUILDINGS[first.kind];
    const rd = RESOURCES[first.kind];
    const ownerP = first.owner >= 0 ? s.players[first.owner] : null;
    const border = ownerP ? hex(ownerP.color) : '#facc15';

    if (ud && sel.length > 1) {
      const counts = new Map<string, number>();
      for (const e of sel) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
      html += `<div class="group-list">${[...counts].map(([k, n]) => `<button class="chip" data-act="dyn:only-${k}">${UNITS[k]?.icon ?? '?'} ${n}</button>`).join('')}</div>`;
      for (const k of counts.keys()) {
        this.actions.set(`dyn:only-${k}`, () => {
          g.select(sel.filter((e) => e.kind === k).map((e) => e.id));
          this.refresh();
        });
      }
    } else {
      const name = ud?.name ?? bd?.name ?? (rd ? (rd.res === 'wood' ? 'Tree' : 'Gold rock') : first.kind);
      const icon = ud?.icon ?? bd?.icon ?? (rd ? (rd.res === 'wood' ? '🌳' : '🪙') : '?');
      const desc = ud?.desc ?? bd?.desc ?? (rd ? `Has <b data-amt="${first.id}">${first.amount}</b> ${rd.res}. Send workers to collect it.` : '');
      const owner = ownerP ? `<span class="tag" style="color:${border}">${esc(ownerP.name)}</span>` : '';
      html += `<div class="sel-head"><div class="portrait" style="border-color:${border}">${icon}</div><div class="grow">
        <div class="sel-name">${esc(name)} ${owner}</div>
        ${ud || bd ? `<div class="hpbar"><div data-hp="${first.id}"></div></div>` : ''}
        <div class="hint">${desc}</div></div></div>`;
    }

    if (!own || !p) {
      this.panel.innerHTML = html;
      return;
    }

    let acts = '';
    if (ud) {
      const workers = sel.filter((e) => e.kind === 'worker');
      if (workers.length > 0) {
        for (const k of BUILD_MENU) {
          const b = BUILDINGS[k];
          const locked = p.level < b.level;
          acts += this.act(`b-${k}`, locked ? '🔒' : b.icon, b.name, locked ? `Castle Lv${b.level}` : costHtml(b.cost), !locked && afford(b.cost), () => {
            g.placing = { kind: k, tx: -100, ty: -100, ok: false };
            g.rallyMode = false;
            if (this.input.touchUI) {
              const c = this.r.target;
              const size = b.size;
              g.placing.tx = Math.floor(c.x - size / 2 + 0.5);
              g.placing.ty = Math.floor(c.z - size / 2 + 0.5);
            }
            this.flash(this.input.touchUI ? `Tap where the ${b.name} should go` : `Click where the ${b.name} should go${k === 'wall' ? ' (keep clicking for more)' : ''}`);
            this.refresh();
          }, g.placing?.kind === k, b.desc);
        }
      }
      acts += this.act('stop', '✋', 'Stop', '', true, () => g.command({ t: 'stop', ids: sel.map((e) => e.id) }));
      const fighters = sel.filter((e) => UNITS[e.kind].atk > 0 && e.kind !== 'worker');
      if (fighters.length > 0) {
        acts += this.act('charge', '📯', 'Charge!', 'attack all', true, () => {
          this.flash('Click where to charge — they fight everything on the way!');
          g.amoveMode = true;
          g.placing = null;
        }, false, 'Attack-move: fight anything you meet on the way');
      }
      const boats = sel.filter((e) => e.kind === 'transport' && e.cargo.length > 0);
      if (boats.length > 0) html += `<div class="hint">⛵ Click on land near the water to unload your units.</div>`;
      if (sel.some((e) => e.kind === 'transport' && e.cargo.length === 0)) html += `<div class="hint">⛵ Select soldiers and click this boat to get on board.</div>`;
    } else if (bd) {
      if (!first.done) {
        html += `<div class="hint">🔨 Being built: <b data-bp="${first.id}">0%</b>. Select workers and click it to help!</div>`;
      } else {
        for (const k of bd.trains) {
          const u = UNITS[k];
          const locked = p.level < u.level;
          acts += this.act(`t-${k}`, locked ? '🔒' : u.icon, u.name, locked ? `Castle Lv${u.level}` : costHtml(u.cost), !locked && afford(u.cost) && first.queue.length < 5, () => {
            g.command({ t: 'train', b: first.id, kind: k });
            sfx('train');
          }, false, u.desc);
        }
        const researching = s.entities.filter((x) => x.owner === g.me).flatMap((x) => x.queue);
        for (const t of researchesAt(first.kind)) {
          const ti = TECH_INDEX[t.id];
          const lvl = p.tech[ti];
          if (lvl >= t.levels) continue;
          const locked = p.level < t.castleLevel;
          const busy = researching.includes(TECH_PREFIX + t.id);
          const cost = techCost(t, lvl + 1);
          const label = t.levels > 1 ? `${t.name} ${lvl + 1}` : t.name;
          acts += this.act(`r-${t.id}`, locked ? '🔒' : t.icon, label, locked ? `Castle Lv${t.castleLevel}` : busy ? 'researching…' : costHtml(cost),
            !locked && !busy && afford(cost) && first.queue.length < 5, () => {
              g.command({ t: 'research', b: first.id, tech: t.id });
              sfx('train');
            }, false, `${t.desc} (level ${lvl + 1} of ${t.levels})`);
        }
        if (first.kind === 'castle') {
          const up = CASTLE_UPGRADES[p.level];
          if (up && !first.queue.includes(UPGRADE_ITEM)) {
            acts += this.act('up', '⭐', `Level ${p.level + 1}`, costHtml(up.cost), afford(up.cost) && first.queue.length < 5, () => g.command({ t: 'upgrade', b: first.id }), false,
              p.level === 1 ? 'Unlocks knights, rams, towers, stables, workshops and warships' : 'Unlocks catapults and a golden castle');
          }
        }
        if (bd.trains.length > 0) {
          acts += this.act('rally', '🚩', 'Rally point', 'where new units go', true, () => {
            g.rallyMode = true;
            this.flash('Click where new units should go');
            this.refresh();
          }, g.rallyMode);
        }
        if (first.queue.length > 0) {
          html += `<div class="queue">${first.queue.map((q, i) => `<div class="qitem" title="${esc(queueName(q))}">${queueIcon(q)}${i === 0 ? `<div class="fill" data-qp="${first.id}"></div>` : ''}</div>`).join('')}
            <button class="btn small ghost" data-act="dyn:cancel">✖ Cancel last</button></div>`;
          this.actions.set('dyn:cancel', () => g.command({ t: 'cancel', b: first.id }));
          if (p.pop >= p.popCap && first.queue[0] !== UPGRADE_ITEM) html += `<div class="hint">🏠 Not enough room! Build a house so new units can join.</div>`;
        }
        if (first.kind === 'dock') html += `<div class="hint">⚓ Boats appear on the water next to the dock.</div>`;
      }
    }
    if (acts) html += `<div class="actions">${acts}</div>`;
    this.panel.innerHTML = html;
  }

  // ---------------------------------------------------------------- minimap

  private bindMinimap(): void {
    const mm = this.minimap;
    let dragging = false;
    const toWorld = (e: PointerEvent) => {
      const rect = mm.getBoundingClientRect();
      const s = this.g.state;
      return { x: ((e.clientX - rect.left) / rect.width) * s.map.w, z: ((e.clientY - rect.top) / rect.height) * s.map.h };
    };
    mm.addEventListener('contextmenu', (e) => e.preventDefault());
    mm.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      const w = toWorld(e);
      if (e.button === 2) {
        this.input.smart(null, w);
        return;
      }
      dragging = true;
      mm.setPointerCapture(e.pointerId);
      this.r.lookAtTile(w.x, w.z);
    });
    mm.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const w = toWorld(e);
      this.r.lookAtTile(w.x, w.z);
    });
    mm.addEventListener('pointerup', () => { dragging = false; });
  }

  private drawMinimap(): void {
    const g = this.g;
    const s = g.state;
    const { w, h, tiles } = s.map;
    const ctx = this.minimap.getContext('2d') as CanvasRenderingContext2D;
    if (!this.miniBase || this.miniBase.width !== w) {
      this.miniBase = ctx.createImageData(w, h);
      for (let i = 0; i < w * h; i++) {
        const t = tiles[i];
        const c = t === Tile.WATER ? [56, 150, 220] : t === Tile.SAND ? [230, 210, 140] : [92, 170, 70];
        this.miniBase.data.set([c[0], c[1], c[2], 255], i * 4);
      }
    }
    const img = ctx.createImageData(w, h);
    img.data.set(this.miniBase.data);
    const me = g.me;
    for (const e of s.entities) {
      if (e.inside) continue;
      const friendly = e.owner >= 0 && me >= 0 && areFriends(s, e.owner, me);
      if (!friendly && !g.isVisible(e)) continue;
      let col: number[];
      if (e.owner >= 0) {
        const c = s.players[e.owner].color;
        col = [(c >> 16) & 255, (c >> 8) & 255, c & 255];
      } else col = e.kind === 'tree' ? [30, 100, 40] : [250, 210, 40];
      const sz = e.size > 0 ? e.size : 1;
      const x0 = e.size > 0 ? e.tileX : Math.floor(e.x / FP);
      const y0 = e.size > 0 ? e.tileY : Math.floor(e.y / FP);
      for (let y = y0; y < y0 + sz; y++) for (let x = x0; x < x0 + sz; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        img.data.set([col[0], col[1], col[2], 255], (y * w + x) * 4);
      }
    }
    if (g.fogEnabled) {
      for (let i = 0; i < w * h; i++) {
        const v = g.vis[i];
        if (v === 2) continue;
        const k = v === 1 ? 0.55 : 0.12;
        img.data[i * 4] *= k;
        img.data[i * 4 + 1] *= k;
        img.data[i * 4 + 2] *= k;
      }
    }
    // draw at map resolution, then scale up
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    (tmp.getContext('2d') as CanvasRenderingContext2D).putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, this.minimap.width, this.minimap.height);
    ctx.drawImage(tmp, 0, 0, this.minimap.width, this.minimap.height);
    // camera view
    const rect = this.r.renderer.domElement.getBoundingClientRect();
    const corners = [[rect.left, rect.top], [rect.right, rect.top], [rect.right, rect.bottom], [rect.left, rect.bottom]]
      .map(([x, y]) => this.r.groundAt(x, y));
    if (corners.every((c) => c)) {
      const sx = this.minimap.width / w;
      const sy = this.minimap.height / h;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      corners.forEach((c, i) => {
        const px = Math.max(-5, Math.min(w + 5, c!.x)) * sx;
        const py = Math.max(-5, Math.min(h + 5, c!.z)) * sy;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.stroke();
    }
  }

  dispose(): void {
    this.root.innerHTML = '';
    this.root.classList.add('hidden');
  }
}

