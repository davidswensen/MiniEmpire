// Mouse, touch and keyboard: camera, selection, contextual commands, placement.

import { BUILDINGS, FP, UNITS, areEnemies, canPlace, type Entity } from '@mini/shared';
import { sfx, unlockAudio } from './audio.ts';
import type { GameSession } from './game.ts';
import type { Overlay } from './render/overlay.ts';
import type { Renderer } from './render/scene.ts';

export interface HudHooks {
  hotkey(key: string): boolean;
  flash(msg: string): void;
  refresh(): void;
}

interface Down {
  id: number;
  x: number;
  y: number;
  button: number;
  moved: boolean;
  touch: boolean;
  t: number;
}

export class Input {
  private keys = new Set<string>();
  private pointers = new Map<number, { x: number; y: number }>();
  private down: Down | null = null;
  private pinch: { d: number; dist: number } | null = null;
  private mouse = { x: -1, y: -1, inside: false };
  private lastClick = { t: 0, id: 0 };
  boxMode = false;
  touchUI = false;
  private el: HTMLElement;
  private off: Array<() => void> = [];
  private g: GameSession;
  private r: Renderer;
  private o: Overlay;
  private hud: HudHooks;

  constructor(g: GameSession, r: Renderer, o: Overlay, hud: HudHooks) {
    this.g = g;
    this.r = r;
    this.o = o;
    this.hud = hud;
    this.el = r.renderer.domElement;
    this.touchUI = 'ontouchstart' in window;
    const on = <K extends keyof HTMLElementEventMap>(t: HTMLElement | Window, ev: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(ev, fn as EventListener, opts);
      this.off.push(() => t.removeEventListener(ev, fn as EventListener));
    };
    on(this.el, 'pointerdown', (e) => this.onDown(e));
    on(window, 'pointermove', (e) => this.onMove(e));
    on(window, 'pointerup', (e) => this.onUp(e));
    on(window, 'pointercancel', (e) => this.onUp(e));
    on(this.el, 'wheel', (e) => this.onWheel(e), { passive: false });
    on(this.el, 'contextmenu', (e) => e.preventDefault());
    on(this.el, 'pointerleave', () => { this.mouse.inside = false; });
    on(this.el, 'pointerenter', () => { this.mouse.inside = true; });
    on(window, 'keydown', (e) => this.onKey(e, true));
    on(window, 'keyup', (e) => this.onKey(e, false));
    on(window, 'blur', () => this.keys.clear());
  }

  dispose(): void {
    for (const f of this.off) f();
  }

  // ---------------------------------------------------------------- per frame

  update(dt: number): void {
    const sp = this.r.dist * 1.1 * dt;
    let dx = 0;
    let dz = 0;
    if (this.keys.has('arrowleft') || this.keys.has('a')) dx -= sp;
    if (this.keys.has('arrowright') || this.keys.has('d')) dx += sp;
    if (this.keys.has('arrowup') || this.keys.has('w')) dz -= sp;
    if (this.keys.has('arrowdown') || this.keys.has('s')) dz += sp;
    if (this.mouse.inside && this.mouse.x >= 0 && !this.down && !this.touchUI && document.hasFocus()) {
      const m = 6;
      if (this.mouse.x <= m) dx -= sp;
      if (this.mouse.x >= window.innerWidth - m) dx += sp;
      if (this.mouse.y <= m) dz -= sp;
      if (this.mouse.y >= window.innerHeight - m) dz += sp;
    }
    if (dx || dz) {
      this.r.target.x += dx;
      this.r.target.z += dz;
    }
    this.r.updateCamera();
    if (this.g.placing && this.mouse.x >= 0 && !this.touchUI) this.updateGhost(this.mouse.x, this.mouse.y);
  }

  // ---------------------------------------------------------------- pointer

  private onDown(e: PointerEvent): void {
    unlockAudio();
    try {
      this.el.setPointerCapture?.(e.pointerId);
    } catch {
      /* pointer already gone: capture is only a nicety */
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const touch = e.pointerType === 'touch';
    if (touch) this.touchUI = true;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), dist: this.r.dist };
      this.down = null;
      this.o.box = null;
      return;
    }
    if (this.pointers.size > 2) return;
    this.down = { id: e.pointerId, x: e.clientX, y: e.clientY, button: e.button, moved: false, touch, t: performance.now() };
  }

  private onMove(e: PointerEvent): void {
    if (e.pointerType === 'mouse') {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
    }
    const p = this.pointers.get(e.pointerId);
    if (p) {
      const px = p.x;
      const py = p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (this.pinch && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > 10) this.r.dist = this.pinch.dist * (this.pinch.d / d);
        // two-finger pan
        this.panBy(px, py, e.clientX, e.clientY, 0.5);
        return;
      }
      const dn = this.down;
      if (dn && dn.id === e.pointerId) {
        if (!dn.moved && Math.hypot(e.clientX - dn.x, e.clientY - dn.y) > (dn.touch ? 12 : 6)) dn.moved = true;
        if (dn.moved) {
          const pan = dn.button === 1 || dn.button === 2 || (dn.touch && !this.boxMode);
          if (pan) this.panBy(px, py, e.clientX, e.clientY, 1);
          else if (dn.button === 0) this.o.box = { x0: dn.x, y0: dn.y, x1: e.clientX, y1: e.clientY };
        }
      }
    }
    if (e.pointerType === 'mouse' && !this.down) {
      const t = this.r.pick(this.g.state, e.clientX, e.clientY, this.g);
      this.g.hover = t ? t.id : 0;
      this.el.style.cursor = this.cursorFor(t);
    }
  }

  private cursorFor(t: Entity | null): string {
    if (this.g.placing || this.g.rallyMode || this.g.amoveMode) return 'crosshair';
    if (!t) return 'default';
    const mine = this.g.selectedOwnUnits();
    if (mine.length > 0 && t.owner >= 0 && areEnemies(this.g.state, this.g.me, t.owner)) return 'crosshair';
    return 'pointer';
  }

  private panBy(x0: number, y0: number, x1: number, y1: number, k: number): void {
    const a = this.r.groundAt(x0, y0);
    const b = this.r.groundAt(x1, y1);
    if (!a || !b) return;
    this.r.target.x -= (b.x - a.x) * k;
    this.r.target.z -= (b.z - a.z) * k;
    this.r.updateCamera();
  }

  private onUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) this.pinch = null;
      this.down = null;
      return;
    }
    const dn = this.down;
    if (!dn || dn.id !== e.pointerId) return;
    this.down = null;
    if (this.o.box) {
      const b = this.o.box;
      this.o.box = null;
      this.boxSelect(b.x0, b.y0, b.x1, b.y1, e.shiftKey);
      return;
    }
    if (!dn.moved) this.click(e.clientX, e.clientY, dn.button, e.shiftKey, dn.touch);
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.r.dist *= Math.exp(e.deltaY * 0.0012);
    this.r.updateCamera();
  }

  // ---------------------------------------------------------------- actions

  private updateGhost(sx: number, sy: number): void {
    const g = this.g;
    if (!g.placing) return;
    const p = this.r.groundAt(sx, sy);
    if (!p) return;
    const size = BUILDINGS[g.placing.kind].size;
    g.placing.tx = Math.floor(p.x - size / 2 + 0.5);
    g.placing.ty = Math.floor(p.z - size / 2 + 0.5);
    g.placing.ok = canPlace(g.state, g.me, g.placing.kind, g.placing.tx, g.placing.ty) && this.visibleFootprint(g.placing.tx, g.placing.ty, size);
  }

  private visibleFootprint(tx: number, ty: number, size: number): boolean {
    const w = this.g.state.map.w;
    for (let y = ty; y < ty + size; y++) for (let x = tx; x < tx + size; x++) if (this.g.vis[y * w + x] === 0) return false;
    return true;
  }

  /** Confirm the ghost (used by the touch "Place here" button too). */
  placeNow(keep: boolean): void {
    const g = this.g;
    if (!g.placing) return;
    if (!g.placing.ok) {
      sfx('error');
      this.hud.flash("Can't build there");
      return;
    }
    const workers = g.selectedOwnUnits().filter((u) => u.kind === 'worker').map((u) => u.id);
    if (workers.length === 0) {
      g.placing = null;
      return;
    }
    const p = g.myPlayer;
    const cost = BUILDINGS[g.placing.kind].cost;
    if (p && (p.wood < cost.wood || p.gold < cost.gold)) {
      sfx('error');
      this.hud.flash(p.wood < cost.wood ? 'Not enough wood 🪵' : 'Not enough gold 🪙');
      return;
    }
    g.command({ t: 'build', ids: workers, kind: g.placing.kind, tx: g.placing.tx, ty: g.placing.ty });
    sfx('build');
    const size = BUILDINGS[g.placing.kind].size;
    this.r.marker(g.placing.tx + size / 2, g.placing.ty + size / 2, 0x4ade80);
    if (!keep) g.placing = null;
    this.hud.refresh();
  }

  private click(sx: number, sy: number, button: number, shift: boolean, touch: boolean): void {
    const g = this.g;
    if (g.placing) {
      if (button === 2) {
        g.placing = null;
        this.hud.refresh();
        return;
      }
      this.updateGhost(sx, sy);
      if (!touch) this.placeNow(shift || g.placing.kind === 'wall');
      else this.hud.refresh();
      return;
    }
    const ground = this.r.groundAt(sx, sy);
    if (g.rallyMode && button === 0) {
      g.rallyMode = false;
      if (ground) this.setRally(ground.x, ground.z);
      this.hud.refresh();
      return;
    }
    if (g.amoveMode && button === 0) {
      g.amoveMode = false;
      const ids = g.selectedOwnUnits().map((u) => u.id);
      if (ground && ids.length > 0) {
        g.command({ t: 'amove', ids, x: Math.floor(ground.x * FP), y: Math.floor(ground.z * FP) });
        this.r.marker(ground.x, ground.z, 0xef4444);
        sfx('command');
      }
      return;
    }
    const target = this.r.pick(g.state, sx, sy, g);
    const mine = g.selectedOwnUnits();
    if (button === 2) {
      if (mine.length > 0) this.smart(target, ground);
      else if (ground) this.setRally(ground.x, ground.z);
      return;
    }
    if (button !== 0) return;
    if (target && target.owner === g.me) {
      const now = performance.now();
      const dbl = now - this.lastClick.t < 350 && this.lastClick.id === target.id;
      this.lastClick = { t: now, id: target.id };
      // workers clicking an unfinished own building = help build; units clicking own boat = board
      const helpBuild = mine.some((u) => u.kind === 'worker') && BUILDINGS[target.kind] && (!target.done || target.hp < target.maxHp) && !g.selection.has(target.id);
      const board = mine.length > 0 && UNITS[target.kind]?.cargo && !g.selection.has(target.id) && mine.every((u) => !UNITS[u.kind].naval);
      if ((helpBuild || board) && !shift) {
        this.smart(target, ground);
        return;
      }
      if (dbl && UNITS[target.kind]) {
        const same = this.r.anchors.filter((a) => a.e.owner === g.me && a.e.kind === target.kind).map((a) => a.e.id);
        g.select(same);
      } else if (shift && g.selection.has(target.id)) {
        g.selection.delete(target.id);
      } else {
        g.select([target.id], shift && UNITS[target.kind] !== undefined);
      }
      sfx('select');
      this.hud.refresh();
      return;
    }
    if (mine.length > 0) {
      this.smart(target, ground);
      return;
    }
    if (target) {
      g.select([target.id]);
      sfx('click');
    } else {
      g.select([]);
    }
    this.hud.refresh();
  }

  smart(target: Entity | null, ground: { x: number; z: number } | null): void {
    const g = this.g;
    const ids = g.selectedOwnUnits().map((u) => u.id);
    if (ids.length === 0) return;
    const x = ground ? Math.floor(ground.x * FP) : target ? target.x : 0;
    const y = ground ? Math.floor(ground.z * FP) : target ? target.y : 0;
    g.command({ t: 'smart', ids, x, y, target: target ? target.id : 0 });
    const enemy = target && target.owner >= 0 && areEnemies(g.state, g.me, target.owner);
    this.r.marker(target ? target.x / FP : x / FP, target ? target.y / FP : y / FP, enemy ? 0xef4444 : target ? 0xfacc15 : 0x4ade80);
    sfx('command');
  }

  private setRally(wx: number, wz: number): void {
    const g = this.g;
    const b = g.selected().find((e) => e.owner === g.me && BUILDINGS[e.kind]?.trains.length);
    if (!b) return;
    g.command({ t: 'rally', b: b.id, x: Math.floor(wx * FP), y: Math.floor(wz * FP) });
    this.r.marker(wx, wz, 0x60a5fa);
    sfx('command');
  }

  private boxSelect(x0: number, y0: number, x1: number, y1: number, add: boolean): void {
    const g = this.g;
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);
    const ids: number[] = [];
    for (const a of this.r.anchors) {
      if (a.e.owner !== g.me || !UNITS[a.e.kind]) continue;
      if (a.sx >= minX && a.sx <= maxX && a.sy >= minY && a.sy <= maxY) ids.push(a.e.id);
    }
    if (ids.length > 0) {
      g.select(ids, add);
      sfx('select');
    } else if (!add) g.select([]);
    this.boxMode = false;
    this.hud.refresh();
  }

  focus(e: Entity | undefined): void {
    if (!e) return;
    this.r.lookAtTile(e.x / FP, e.y / FP);
  }

  selectIdleWorker(): void {
    const g = this.g;
    const idle = g.state.entities.filter((e) => e.owner === g.me && e.kind === 'worker' && !e.inside && e.order === 0);
    if (idle.length === 0) {
      this.hud.flash('No idle workers 👍');
      return;
    }
    const cur = g.selection.size === 1 ? [...g.selection][0] : 0;
    const i = idle.findIndex((e) => e.id === cur);
    const next = idle[(i + 1) % idle.length];
    g.select([next.id]);
    this.focus(next);
    sfx('select');
    this.hud.refresh();
  }

  selectArmy(): void {
    const g = this.g;
    const ids = g.state.entities.filter((e) => e.owner === g.me && UNITS[e.kind] && e.kind !== 'worker' && !e.inside).map((e) => e.id);
    if (ids.length === 0) {
      this.hud.flash('You have no soldiers yet');
      return;
    }
    g.select(ids);
    sfx('select');
    this.hud.refresh();
  }

  selectCastle(): void {
    const g = this.g;
    const c = g.state.byId.get(g.myPlayer?.castleId ?? 0);
    if (!c) return;
    g.select([c.id]);
    this.focus(c);
    this.hud.refresh();
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (!down) {
      this.keys.delete(k);
      return;
    }
    if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'a', 'd', 'w', 's'].includes(k) && !e.ctrlKey) {
      // letters double as hotkeys only when the HUD claims them
      if (k.length === 1 && this.hud.hotkey(k)) return;
      this.keys.add(k);
      if (k.startsWith('arrow')) e.preventDefault();
      return;
    }
    const g = this.g;
    if (k === 'escape') {
      if (g.placing || g.rallyMode || g.amoveMode) {
        g.placing = null;
        g.rallyMode = false;
        g.amoveMode = false;
      } else g.select([]);
      this.hud.refresh();
      return;
    }
    if (/^[1-9]$/.test(k)) {
      const n = Number(k);
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        g.saveGroup(n);
        this.hud.flash(`Saved group ${n}`);
      } else {
        const sel = g.recallGroup(n);
        const now = performance.now();
        if (sel.length && now - this.lastClick.t < 350 && this.lastClick.id === -n) this.focus(sel[0]);
        this.lastClick = { t: now, id: -n };
        this.hud.refresh();
      }
      return;
    }
    if (k === ' ' || k === 'h') {
      e.preventDefault();
      this.selectCastle();
      return;
    }
    if (k === '.' || k === 'i') {
      this.selectIdleWorker();
      return;
    }
    if (k === 'tab') {
      e.preventDefault();
      this.selectArmy();
      return;
    }
    if (k.length === 1) this.hud.hotkey(k);
  }
}
