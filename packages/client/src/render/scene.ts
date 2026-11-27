// Three.js renderer. Reads simulation state (never writes it) and draws blocky
// instanced models, fog of war, projectiles and particles.

import * as THREE from 'three';
import {
  BUILDINGS, FP, RESOURCES, Tile, UNITS, areFriends, type Entity, type GameEvent, type GameMap, type GameState,
} from '@mini/shared';
import { HAT_MODELS, MODELS, type Model, type Part } from './models.ts';

export interface ViewModel {
  state: GameState;
  alpha: number;
  prev: Map<number, [number, number]>;
  me: number;
  fogEnabled: boolean;
  vis: Uint8Array; // 0 unexplored, 1 explored, 2 visible
  selection: Set<number>;
  placing: { kind: string; tx: number; ty: number; ok: boolean } | null;
  hover: number;
}

interface PartMesh {
  part: Part;
  mesh: THREE.InstancedMesh;
  local: THREE.Matrix4;
  count: number;
}

interface KindMesh {
  model: Model;
  parts: PartMesh[];
  capacity: number;
}

interface AnimState {
  yaw: number;
  x: number;
  z: number;
  moving: number; // 0..1 smoothed
  phase: number;
  wheel: number;
  attackAt: number;
  faceX: number;
  faceZ: number;
  seen: number;
}

interface Projectile {
  mesh: THREE.Mesh;
  from: THREE.Vector3;
  to: THREE.Vector3;
  t0: number;
  dur: number;
  arc: number;
  splash: boolean;
  style: ShotStyle;
}

interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; max: number; size: number;
  color: THREE.Color;
  gravity: number;
}

const tmpM = new THREE.Matrix4();
const tmpM2 = new THREE.Matrix4();
const outM = new THREE.Matrix4();
const rotM = new THREE.Matrix4();
const trM = new THREE.Matrix4();
const hatM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const tmpC = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);
const SCAFFOLD = new THREE.Color(0xc8a26a);
const AX = new THREE.Vector3(1, 0, 0);
const AZ = new THREE.Vector3(0, 0, 1);

/** Flyers cruise this high above the ground. */
export const FLY_HEIGHT = 2.4;

type ShotStyle = 'arrow' | 'bolt' | 'rock' | 'boulder' | 'cannon' | 'fire';
const SHOT: Record<string, ShotStyle> = {
  catapult: 'rock', trebuchet: 'boulder', ballista: 'bolt', skytower: 'bolt',
  bombard: 'cannon', galleon: 'cannon', cannontower: 'cannon',
  dragon: 'fire', wyvern: 'fire', fireship: 'fire', flametower: 'fire',
};

const BUILDING_HEIGHT: Record<string, number> = {
  castle: 2.6, tower: 2.4, barracks: 1.4, stable: 1.3, workshop: 1.6, house: 1.3, storehouse: 1.0,
  dock: 1.0, wall: 1.1, gate: 1.4, tree: 1.5, goldmine: 1.1,
  blacksmith: 1.3, roost: 1.9, skytower: 2.8, flametower: 2.7, cannontower: 2.5,
};

export function teamColor(hex: number, variant: 'team' | 'teamDark' | 'teamLight'): THREE.Color {
  const c = new THREE.Color(hex);
  if (variant === 'teamDark') c.multiplyScalar(0.62);
  if (variant === 'teamLight') c.lerp(new THREE.Color(0xffffff), 0.45);
  return c;
}

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly target = new THREE.Vector3();
  dist = 20;
  private map: GameMap;
  private fogData: Uint8Array;
  private fogTex: THREE.DataTexture;
  private fogCur: Float32Array;
  private fogUniform = { value: null as THREE.DataTexture | null };
  private mapSizeUniform = { value: new THREE.Vector2(1, 1) };
  private kinds = new Map<string, KindMesh>();
  private hats: KindMesh[] = [];
  private anim = new Map<number, AnimState>();
  private ring: THREE.InstancedMesh;
  private ghost: THREE.Mesh;
  private ghostEdge: THREE.LineSegments;
  private rally: THREE.Group;
  private projectiles: Projectile[] = [];
  private projPool: THREE.Mesh[] = [];
  private particles: Particle[] = [];
  private particleMesh: THREE.InstancedMesh;
  private markers: Array<{ mesh: THREE.Mesh; t0: number }> = [];
  private sun: THREE.DirectionalLight;
  private water: THREE.Mesh;
  private time = 0;
  private teamColors: THREE.Color[][] = [];
  readonly container: HTMLElement;
  private quality: 'high' | 'low';
  /** Screen-space anchors for the overlay (health bars, labels). */
  anchors: Array<{ e: Entity; sx: number; sy: number; scale: number; topY: number }> = [];

  constructor(container: HTMLElement, map: GameMap, quality: 'high' | 'low') {
    this.container = container;
    this.map = map;
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({ antialias: quality === 'high', powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality === 'high' ? 2 : 1));
    this.renderer.shadowMap.enabled = quality === 'high';
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.5, 300);
    this.scene.background = new THREE.Color(0x7dd3fc);

    // lights
    this.scene.add(new THREE.HemisphereLight(0xe0f2fe, 0x3f6212, 1.6));
    this.sun = new THREE.DirectionalLight(0xfff7e0, 2.2);
    this.sun.position.set(-20, 40, 15);
    if (quality === 'high') {
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(2048, 2048);
      const sc = this.sun.shadow.camera;
      sc.left = -30; sc.right = 30; sc.top = 30; sc.bottom = -30; sc.near = 1; sc.far = 120;
      this.sun.shadow.bias = -0.0008;
    }
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // fog of war texture
    this.fogData = new Uint8Array(map.w * map.h * 4).fill(255);
    this.fogCur = new Float32Array(map.w * map.h).fill(0);
    this.fogTex = new THREE.DataTexture(this.fogData, map.w, map.h, THREE.RGBAFormat);
    this.fogTex.magFilter = THREE.LinearFilter;
    this.fogTex.minFilter = THREE.LinearFilter;
    this.fogTex.wrapS = THREE.ClampToEdgeWrapping;
    this.fogTex.wrapT = THREE.ClampToEdgeWrapping;
    this.fogTex.needsUpdate = true;
    this.fogUniform.value = this.fogTex;
    this.mapSizeUniform.value.set(map.w, map.h);

    this.buildTerrain();
    this.water = this.scene.children[this.scene.children.length - 1] as THREE.Mesh;

    // selection rings
    const ringGeo = new THREE.RingGeometry(0.86, 1, 28);
    ringGeo.rotateX(-Math.PI / 2);
    this.ring = new THREE.InstancedMesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }), 256);
    this.ring.frustumCulled = false;
    this.ring.count = 0;
    this.ring.renderOrder = 2;
    this.scene.add(this.ring);

    // placement ghost
    this.ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 0.3, 1), new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.45, depthWrite: false }));
    this.ghostEdge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0xffffff }));
    this.ghost.visible = false;
    this.ghostEdge.visible = false;
    this.scene.add(this.ghost, this.ghostEdge);

    // rally flag
    this.rally = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.9, 0.05), new THREE.MeshLambertMaterial({ color: 0x5c3a1a }));
    pole.position.y = 0.45;
    const flag = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.25, 0.03), new THREE.MeshLambertMaterial({ color: 0xffffff }));
    flag.position.set(0.2, 0.75, 0);
    flag.name = 'flag';
    this.rally.add(pole, flag);
    this.rally.visible = false;
    this.scene.add(this.rally);

    // particles
    const pGeo = new THREE.BoxGeometry(1, 1, 1);
    this.particleMesh = new THREE.InstancedMesh(pGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), 800);
    this.particleMesh.frustumCulled = false;
    this.particleMesh.count = 0;
    this.particleMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(800 * 3), 3);
    this.scene.add(this.particleMesh);

    this.resize();
  }

  setPlayerColors(colors: number[]): void {
    this.teamColors = colors.map((c) => [teamColor(c, 'team'), teamColor(c, 'teamDark'), teamColor(c, 'teamLight')]);
  }

  /** Multiply every fragment by the fog-of-war texture (sampled by world xz). */
  private patchFog(mat: THREE.Material): void {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uFogMap = this.fogUniform;
      shader.uniforms.uMapSize = this.mapSizeUniform;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform vec2 uMapSize;\nvarying vec2 vFogUv;')
        .replace(
          '#include <project_vertex>',
          `#include <project_vertex>
           vec4 fogWp = vec4(transformed, 1.0);
           #ifdef USE_INSTANCING
             fogWp = instanceMatrix * fogWp;
           #endif
           fogWp = modelMatrix * fogWp;
           vFogUv = fogWp.xz / uMapSize;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uFogMap;\nvarying vec2 vFogUv;')
        .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n  gl_FragColor.rgb *= texture2D(uFogMap, vFogUv).r;');
    };
  }

  private buildTerrain(): void {
    const { w, h, tiles } = this.map;
    let land = 0;
    for (let i = 0; i < tiles.length; i++) if (tiles[i] !== Tile.WATER) land++;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.patchFog(mat);
    const mesh = new THREE.InstancedMesh(geo, mat, land);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    let k = 0;
    const grassA = new THREE.Color(0x65c34a);
    const grassB = new THREE.Color(0x5bb341);
    const sand = new THREE.Color(0xf2d98d);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = tiles[y * w + x];
        if (t === Tile.WATER) continue;
        const top = t === Tile.SAND ? -0.04 : 0;
        tmpM.makeTranslation(x + 0.5, top - 0.5, y + 0.5);
        mesh.setMatrixAt(k, tmpM);
        const n = ((x * 73856093) ^ (y * 19349663)) >>> 0;
        const c = t === Tile.SAND ? sand.clone() : ((x + y) % 2 === 0 ? grassA : grassB).clone();
        c.offsetHSL(0, 0, ((n % 7) - 3) * 0.006);
        mesh.setColorAt(k, c);
        k++;
      }
    }
    this.scene.add(mesh);

    // outer ground so the world does not end in sky
    const outerMat = new THREE.MeshLambertMaterial({ color: 0x3f7a2c });
    this.patchFog(outerMat);
    const outer = new THREE.Mesh(new THREE.PlaneGeometry(w + 120, h + 120), outerMat);
    outer.rotation.x = -Math.PI / 2;
    outer.position.set(w / 2, -0.9, h / 2); // below the lake bed, so it never covers water
    this.scene.add(outer);

    const bedMat = new THREE.MeshLambertMaterial({ color: 0x1e3a8a });
    this.patchFog(bedMat);
    const bed = new THREE.Mesh(new THREE.PlaneGeometry(w, h), bedMat);
    bed.rotation.x = -Math.PI / 2;
    bed.position.set(w / 2, -0.7, h / 2);
    this.scene.add(bed);

    const waterMat = new THREE.MeshLambertMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.82 });
    this.patchFog(waterMat);
    const water = new THREE.Mesh(new THREE.PlaneGeometry(w, h), waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.set(w / 2, -0.16, h / 2);
    this.scene.add(water);
  }

  private makeKindMesh(model: Model, capacity: number): KindMesh {
    const parts: PartMesh[] = model.parts.map((part) => {
      const geo = new THREE.BoxGeometry(part.s[0], part.s[1], part.s[2]);
      const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
      this.patchFog(mat);
      const mesh = new THREE.InstancedMesh(geo, mat, capacity);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      mesh.frustumCulled = false;
      mesh.castShadow = this.quality === 'high';
      mesh.receiveShadow = this.quality === 'high';
      mesh.count = 0;
      this.scene.add(mesh);
      const local = new THREE.Matrix4();
      const r = part.r ?? [0, 0, 0];
      local.makeRotationFromEuler(new THREE.Euler(r[0], r[1], r[2]));
      local.setPosition(part.p[0], part.p[1], part.p[2]);
      return { part, mesh, local, count: 0 };
    });
    return { model, parts, capacity };
  }

  private kindMesh(kind: string, needed: number): KindMesh | null {
    let km = this.kinds.get(kind);
    const model = MODELS[kind];
    if (!model) return null;
    if (!km || km.capacity < needed) {
      if (km) for (const p of km.parts) {
        this.scene.remove(p.mesh);
        p.mesh.geometry.dispose();
        (p.mesh.material as THREE.Material).dispose();
        p.mesh.dispose();
      }
      let cap = km ? km.capacity : 64;
      while (cap < needed) cap *= 2;
      km = this.makeKindMesh(model, cap);
      this.kinds.set(kind, km);
    }
    return km;
  }

  resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- camera

  updateCamera(): void {
    const { w, h } = this.map;
    this.target.x = Math.max(0, Math.min(w, this.target.x));
    this.target.z = Math.max(0, Math.min(h, this.target.z));
    this.dist = Math.max(7, Math.min(48, this.dist));
    const pitch = 0.95;
    this.camera.position.set(this.target.x, this.target.y + Math.sin(pitch) * this.dist, this.target.z + Math.cos(pitch) * this.dist);
    this.camera.lookAt(this.target);
    this.sun.position.set(this.target.x - 18, 40, this.target.z + 14);
    this.sun.target.position.copy(this.target);
  }

  lookAtTile(x: number, z: number): void {
    this.target.set(x, 0, z);
    this.updateCamera();
  }

  /** Ground point (world units) under a screen pixel. */
  groundAt(sx: number, sy: number, planeY = 0): THREE.Vector3 | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((sx - rect.left) / rect.width) * 2 - 1, -((sy - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const plane = new THREE.Plane(UP, -planeY);
    const out = new THREE.Vector3();
    return ray.ray.intersectPlane(plane, out) ? out : null;
  }

  project(x: number, y: number, z: number): { x: number; y: number; on: boolean } {
    tmpV.set(x, y, z).project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return {
      x: rect.left + ((tmpV.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - tmpV.y) / 2) * rect.height,
      on: tmpV.z < 1 && Math.abs(tmpV.x) < 1.1 && Math.abs(tmpV.y) < 1.1,
    };
  }

  /** Find the entity under a screen point: units by screen distance, then tall static footprints. */
  pick(s: GameState, sx: number, sy: number, vm: ViewModel): Entity | null {
    let best: Entity | null = null;
    let bestD = 1e9;
    for (const a of this.anchors) {
      const e = a.e;
      if (e.size > 0) continue;
      const r = 26 * a.scale + 6;
      const d = Math.hypot(a.sx - sx, a.sy - sy);
      if (d < r && d < bestD) {
        bestD = d;
        best = e;
      }
    }
    if (best) return best;
    for (const py of [2.4, 1.8, 1.2, 0.6, 0.05]) {
      const g = this.groundAt(sx, sy, py);
      if (!g) continue;
      const tx = Math.floor(g.x);
      const ty = Math.floor(g.z);
      if (tx < 0 || ty < 0 || tx >= s.map.w || ty >= s.map.h) continue;
      const id = s.occ[ty * s.map.w + tx];
      if (!id) continue;
      const e = s.byId.get(id);
      if (!e) continue;
      const hgt = (BUILDING_HEIGHT[e.kind] ?? 1) * (e.done ? 1 : 0.4);
      if (hgt + 0.1 < py) continue;
      if (vm.fogEnabled && vm.vis[ty * s.map.w + tx] === 0) continue;
      return e;
    }
    return null;
  }

  // ---------------------------------------------------------------- effects

  marker(x: number, z: number, color: number): void {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.42, 20), new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.04, z);
    this.scene.add(m);
    this.markers.push({ mesh: m, t0: this.time });
  }

  burst(x: number, y: number, z: number, n: number, color: THREE.Color | number, speed: number, size: number, life = 0.8, gravity = 9): void {
    const c = color instanceof THREE.Color ? color : new THREE.Color(color);
    for (let i = 0; i < n && this.particles.length < 800; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.4 + Math.random() * 0.8);
      this.particles.push({
        x, y, z,
        vx: Math.cos(a) * sp, vy: speed * (0.6 + Math.random()), vz: Math.sin(a) * sp,
        life: life * (0.6 + Math.random() * 0.6), max: life, size: size * (0.6 + Math.random() * 0.8),
        color: c.clone().offsetHSL(0, 0, (Math.random() - 0.5) * 0.15), gravity,
      });
    }
  }

  onEvents(s: GameState, events: GameEvent[], vm: ViewModel): void {
    const w = s.map.w;
    const seen = (x: number, y: number) => !vm.fogEnabled || vm.vis[Math.floor(y / FP) * w + Math.floor(x / FP)] === 2;
    for (const ev of events) {
      if (ev.e === 'attack') {
        const st = this.anim.get(ev.from);
        if (st) {
          st.attackAt = this.time;
          st.faceX = ev.tx / FP;
          st.faceZ = ev.ty / FP;
        }
        if (!seen(ev.x, ev.y) && !seen(ev.tx, ev.ty)) continue;
        const fromAir = !!UNITS[ev.kind]?.air;
        const target = s.byId.get(ev.to);
        const toAir = !!(target && UNITS[target.kind]?.air);
        if (ev.ranged) {
          const style: ShotStyle = SHOT[ev.kind] ?? 'arrow';
          const lob = style === 'rock' || style === 'boulder';
          const startY = fromAir ? FLY_HEIGHT + 0.5 : ev.kind in BUILDINGS ? (BUILDING_HEIGHT[ev.kind] ?? 1.8) : lob ? 0.9 : 0.6;
          const from = new THREE.Vector3(ev.x / FP, startY, ev.y / FP);
          const to = new THREE.Vector3(ev.tx / FP, toAir ? FLY_HEIGHT + 0.4 : 0.4, ev.ty / FP);
          const dist = from.distanceTo(to);
          const mesh = this.projPool.pop() ?? new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0xffffff }));
          const mat = mesh.material as THREE.MeshLambertMaterial;
          mat.emissive.set(0x000000);
          let speed = 14;
          let arc = dist * 0.08;
          switch (style) {
            case 'rock': mesh.scale.set(0.2, 0.2, 0.2); mat.color.set(0x57534e); speed = 7; arc = dist * 0.35; break;
            case 'boulder': mesh.scale.set(0.34, 0.34, 0.34); mat.color.set(0x44403c); speed = 7; arc = dist * 0.4; break;
            case 'bolt': mesh.scale.set(0.07, 0.07, 0.7); mat.color.set(0x3f2a14); speed = 20; arc = dist * 0.03; break;
            case 'cannon': mesh.scale.set(0.17, 0.17, 0.17); mat.color.set(0x111827); speed = 13; arc = dist * 0.12; break;
            case 'fire': mesh.scale.set(0.24, 0.24, 0.24); mat.color.set(0xf97316); mat.emissive.set(0xc2410c); speed = 11; arc = dist * 0.04; break;
            default: mesh.scale.set(0.04, 0.04, 0.38); mat.color.set(ev.kind === 'warship' || ev.kind === 'longship' ? 0x3f2a14 : 0xf5f5f4);
          }
          mesh.position.copy(from);
          this.scene.add(mesh);
          if (style === 'cannon') this.burst(from.x, from.y, from.z, 6, 0xd6d3d1, 0.8, 0.18, 0.7, -0.5);
          this.projectiles.push({ mesh, from, to, t0: this.time, dur: Math.max(0.12, dist / speed), arc, splash: lob || style === 'cannon' || style === 'fire', style });
        } else {
          this.burst(ev.tx / FP, toAir ? FLY_HEIGHT + 0.5 : 0.5, ev.ty / FP, 3, 0xfff7c2, 1.5, 0.06, 0.3, 4);
        }
      } else if (ev.e === 'death') {
        if (!seen(ev.x, ev.y)) continue;
        const x = ev.x / FP;
        const z = ev.y / FP;
        if (ev.building) {
          this.burst(x, 0.8, z, 40, 0x9ca3af, 3.5, 0.22, 1.4);
          this.burst(x, 0.8, z, 16, 0x8b5a2b, 3, 0.16, 1.2);
          this.burst(x, 0.5, z, 14, 0xd6d3d1, 0.7, 0.4, 2.2, -0.8);
        } else if (ev.kind in RESOURCES) {
          this.burst(x, 0.8, z, 8, 0x22a447, 1.5, 0.12, 0.8);
        } else if (UNITS[ev.kind]?.air && ev.owner >= 0) {
          this.burst(x, FLY_HEIGHT, z, 24, this.teamColors[ev.owner]?.[0] ?? 0xffffff, 2.5, 0.16, 1.6);
          this.burst(x, FLY_HEIGHT, z, 10, 0x9ca3af, 0.6, 0.35, 1.8, -0.4);
        } else if (ev.owner >= 0) {
          this.burst(x, 0.5, z, 10, this.teamColors[ev.owner]?.[0] ?? 0xffffff, 2.2, 0.1, 0.9);
        }
      } else if (ev.e === 'built') {
        const b = s.byId.get(ev.id);
        if (b && seen(b.x, b.y)) this.burst(b.x / FP, 0.2, b.y / FP, 18, 0xe7d8b5, 1.2, 0.25, 1.1, -0.5);
      } else if (ev.e === 'levelup') {
        const c = s.byId.get(s.players[ev.owner].castleId);
        if (c && seen(c.x, c.y)) this.burst(c.x / FP, 2.0, c.y / FP, 40, 0xfacc15, 2.5, 0.12, 1.6, 1);
      } else if (ev.e === 'trained') {
        const u = s.byId.get(ev.id);
        if (u && seen(u.x, u.y)) this.burst(u.x / FP, 0.3, u.y / FP, 8, 0xffffff, 1, 0.08, 0.6, 1);
      }
    }
  }

  // ---------------------------------------------------------------- frame

  render(vm: ViewModel, dt: number): void {
    this.time += dt;
    const s = vm.state;
    const w = s.map.w;
    this.updateFog(vm, dt);

    // count per kind for capacity
    const counts = new Map<string, number>();
    for (const e of s.entities) if (!e.inside) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    for (const km of this.kinds.values()) for (const p of km.parts) p.count = 0;
    for (const km of this.hats) for (const p of km.parts) p.count = 0;
    if (this.hats.length === 0) {
      this.hats = HAT_MODELS.map((parts) => this.makeKindMesh({ parts }, 256));
    }

    this.anchors = [];
    let rings = 0;
    const alpha = vm.alpha;
    const friendOf = (owner: number) => vm.me >= 0 && areFriends(s, owner, vm.me);

    for (const e of s.entities) {
      if (e.inside) continue;
      const ud = UNITS[e.kind];
      const tile = Math.floor(e.y / FP) * w + Math.floor(e.x / FP);
      const v = vm.fogEnabled ? vm.vis[tile] : 2;
      const friendly = e.owner >= 0 && friendOf(e.owner);
      if (vm.fogEnabled && !friendly) {
        if (ud && v < 2) continue;
        if (!ud && v === 0) continue;
      }
      const km = this.kindMesh(e.kind, counts.get(e.kind) ?? 1);
      if (!km) continue;

      // position (interpolated for units)
      let x = e.x / FP;
      let z = e.y / FP;
      const pv = vm.prev.get(e.id);
      if (ud && pv) {
        x = (pv[0] + (e.x - pv[0]) * alpha) / FP;
        z = (pv[1] + (e.y - pv[1]) * alpha) / FP;
      }
      let st = this.anim.get(e.id);
      if (!st) {
        st = { yaw: ((e.id * 2.39996) % (Math.PI * 2)), x, z, moving: 0, phase: 0, wheel: 0, attackAt: -10, faceX: x, faceZ: z, seen: this.time };
        if (e.size > 0) st.yaw = e.kind in RESOURCES ? (e.id % 4) * (Math.PI / 2) : 0;
        this.anim.set(e.id, st);
      }
      st.seen = this.time;
      const dx = x - st.x;
      const dz = z - st.z;
      const moved = Math.hypot(dx, dz);
      st.x = x;
      st.z = z;
      if (ud) {
        const speedNow = dt > 0 ? moved / dt : 0;
        st.moving += ((speedNow > 0.3 ? 1 : 0) - st.moving) * Math.min(1, dt * 10);
        st.phase += moved * 9;
        st.wheel += moved * 3;
        let wantYaw: number | null = null;
        if (moved > 0.002) wantYaw = Math.atan2(dx, dz);
        if (this.time - st.attackAt < 0.6) wantYaw = Math.atan2(st.faceX - x, st.faceZ - z);
        if (wantYaw !== null) {
          let d = wantYaw - st.yaw;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          st.yaw += d * Math.min(1, dt * 12);
        }
      }

      let y = 0;
      if (ud?.naval) y = -0.08 + Math.sin(this.time * 2 + e.id) * 0.03;
      else if (ud?.air) y = FLY_HEIGHT + Math.sin(this.time * 2.2 + e.id) * 0.12;
      else if (ud) y = Math.abs(Math.sin(st.phase)) * 0.04 * st.moving;
      let sy = 1;
      let scale = km.model.scale ?? 1;
      const bd = BUILDINGS[e.kind];
      if (bd && !e.done) sy = 0.2 + 0.8 * (e.progress / bd.buildTime);
      if (e.kind === 'tree') scale = 0.85 + ((e.id * 7) % 5) * 0.06;
      if (e.kind === 'goldmine') scale = 0.55 + 0.45 * (e.amount / RESOURCES.goldmine.amount);

      tmpQ.setFromAxisAngle(UP, st.yaw);
      tmpS.set(scale, scale * sy, scale);
      tmpV.set(x, y, z);
      tmpM.compose(tmpV, tmpQ, tmpS);

      const ownerLevel = e.owner >= 0 ? s.players[e.owner].level : 1;
      const working = (e.order === 3 || e.order === 5) && e.path.length <= e.pathIdx;
      const attackP = (this.time - st.attackAt) / 0.35;
      const cols = e.owner >= 0 ? this.teamColors[e.owner] : undefined;

      for (const pm of km.parts) {
        const part = pm.part;
        if (bd && part.minLevel && ownerLevel < part.minLevel) continue;
        if (bd && part.maxLevel && ownerLevel > part.maxLevel) continue;
        if (pm.count >= km.capacity) continue;
        let local = pm.local;
        if (part.a) {
          let ang = 0;
          let axis = AX;
          const sw = Math.sin(st.phase) * st.moving;
          switch (part.a) {
            case 'legL': ang = sw * 0.7; break;
            case 'legR': ang = -sw * 0.7; break;
            case 'horseL': ang = Math.sin(st.phase * 1.4) * 0.6 * st.moving; break;
            case 'horseR': ang = -Math.sin(st.phase * 1.4) * 0.6 * st.moving; break;
            case 'armL': ang = -sw * 0.4; break;
            case 'arm':
              if (attackP < 1) ang = -1.5 * Math.sin(attackP * Math.PI);
              else if (working) ang = -Math.abs(Math.sin(this.time * 7 + e.id)) * 1.2;
              else ang = sw * 0.4;
              break;
            case 'wheel': ang = st.wheel; break;
            case 'flag': ang = Math.sin(this.time * 3 + e.id) * 0.3; axis = UP; break;
            case 'wingL': ang = 0.15 + Math.sin(this.time * (ud?.kind === 'dragon' ? 4 : 7) + e.id) * 0.55; axis = AZ; break;
            case 'wingR': ang = -0.15 - Math.sin(this.time * (ud?.kind === 'dragon' ? 4 : 7) + e.id) * 0.55; axis = AZ; break;
            case 'recoil': ang = attackP < 1 ? -0.3 * (1 - attackP) : 0; break;
            case 'throw': ang = attackP < 1 ? 1.3 * Math.sin(Math.min(1, attackP * 2.5) * Math.PI * 0.5) * (1 - attackP * 0.5) : 0; break;
          }
          if (ang !== 0) {
            const pv3 = part.pivot ?? [0, 0, 0];
            tmpM2.makeTranslation(-pv3[0], -pv3[1], -pv3[2]).premultiply(rotM.makeRotationAxis(axis, ang)).premultiply(trM.makeTranslation(pv3[0], pv3[1], pv3[2]));
            local = tmpM2.multiply(pm.local);
          }
        }
        pm.mesh.setMatrixAt(pm.count, outM.multiplyMatrices(tmpM, local));
        if (typeof part.c === 'number') tmpC.setHex(part.c);
        else if (cols) tmpC.copy(part.c === 'team' ? cols[0] : part.c === 'teamDark' ? cols[1] : cols[2]);
        else tmpC.setHex(0xbbbbbb);
        if (bd && !e.done) tmpC.lerp(SCAFFOLD, 0.55);
        pm.mesh.setColorAt(pm.count, tmpC);
        pm.count++;
      }

      // hat
      if (ud && km.model.headTop && e.owner >= 0) {
        const hat = s.players[e.owner].hat;
        const hm = this.hats[hat];
        if (hm && hm.parts.length > 0) {
          const ht = km.model.headTop;
          for (const pm of hm.parts) {
            if (pm.count >= hm.capacity) continue;
            hatM.makeTranslation(ht[0], ht[1], ht[2]).multiply(pm.local);
            pm.mesh.setMatrixAt(pm.count, outM.multiplyMatrices(tmpM, hatM));
            tmpC.setHex(pm.part.c as number);
            pm.mesh.setColorAt(pm.count, tmpC);
            pm.count++;
          }
        }
      }

      // overlay anchor and selection ring
      const topY = ud
        ? ud.air ? y + 1.1 * scale : ud.naval ? 1.3 : e.kind === 'knight' ? 1.55 : ud.armor === 'siege' ? 0.95 : 1.05
        : (BUILDING_HEIGHT[e.kind] ?? 1) * sy + 0.3;
      const pr = this.project(x, topY, z);
      if (pr.on) {
        const ground = this.project(x, 0, z);
        const scale2 = Math.max(0.35, Math.min(2.2, 18 / this.dist));
        if (ud?.air) {
          const body = this.project(x, y + 0.4 * scale, z);
          this.anchors.push({ e, sx: body.x, sy: body.y, scale: scale2 * 1.4, topY: pr.y });
        } else {
          this.anchors.push({ e, sx: ud ? ground.x * 0.5 + pr.x * 0.5 : pr.x, sy: ud ? (ground.y + pr.y) / 2 : pr.y, scale: scale2, topY: pr.y });
        }
      }
      if ((vm.selection.has(e.id) || vm.hover === e.id) && rings < 256) {
        const r = ud ? ud.radius / FP + 0.15 : e.size * 0.62 + 0.1;
        tmpM2.compose(tmpV.set(x, (ud?.naval ? -0.12 : 0.03), z), tmpQ.identity(), tmpS.set(r, 1, r));
        this.ring.setMatrixAt(rings, tmpM2);
        const own = e.owner === vm.me;
        const col = own ? 0x4ade80 : e.owner < 0 ? 0xfacc15 : friendly ? 0x60a5fa : 0xf87171;
        tmpC.setHex(vm.selection.has(e.id) ? col : 0xffffff);
        this.ring.setColorAt(rings, tmpC);
        rings++;
      }
    }

    for (const km of [...this.kinds.values(), ...this.hats]) {
      for (const pm of km.parts) {
        pm.mesh.count = pm.count;
        pm.mesh.instanceMatrix.needsUpdate = true;
        if (pm.mesh.instanceColor) pm.mesh.instanceColor.needsUpdate = true;
      }
    }
    this.ring.count = rings;
    this.ring.instanceMatrix.needsUpdate = true;
    if (this.ring.instanceColor) this.ring.instanceColor.needsUpdate = true;

    // forget animation state of entities gone for a while
    if (Math.floor(this.time) !== Math.floor(this.time - dt)) {
      for (const [id, st] of this.anim) if (this.time - st.seen > 3) this.anim.delete(id);
    }

    this.updateGhost(vm);
    this.updateRally(vm);
    this.updateEffects(dt);
    const wm = this.water.material as THREE.MeshLambertMaterial;
    wm.opacity = 0.8 + Math.sin(this.time * 1.5) * 0.04;
    this.renderer.render(this.scene, this.camera);
  }

  private updateFog(vm: ViewModel, dt: number): void {
    const n = this.fogCur.length;
    let changed = false;
    const k = Math.min(1, dt * 6);
    for (let i = 0; i < n; i++) {
      const target = !vm.fogEnabled ? 1 : vm.vis[i] === 2 ? 1 : vm.vis[i] === 1 ? 0.52 : 0.1;
      const cur = this.fogCur[i];
      if (cur !== target) {
        const nv = Math.abs(target - cur) < 0.01 ? target : cur + (target - cur) * k;
        this.fogCur[i] = nv;
        this.fogData[i * 4] = Math.round(nv * 255);
        changed = true;
      }
    }
    if (changed) this.fogTex.needsUpdate = true;
  }

  private updateGhost(vm: ViewModel): void {
    const p = vm.placing;
    if (!p) {
      this.ghost.visible = false;
      this.ghostEdge.visible = false;
      return;
    }
    const size = BUILDINGS[p.kind]?.size ?? 1;
    const h = BUILDING_HEIGHT[p.kind] ?? 1;
    this.ghost.visible = true;
    this.ghostEdge.visible = true;
    this.ghost.scale.set(size, h / 0.3, size);
    this.ghost.position.set(p.tx + size / 2, h / 2, p.ty + size / 2);
    this.ghostEdge.scale.set(size, h, size);
    this.ghostEdge.position.copy(this.ghost.position);
    (this.ghost.material as THREE.MeshBasicMaterial).color.set(p.ok ? 0x22c55e : 0xef4444);
  }

  private updateRally(vm: ViewModel): void {
    this.rally.visible = false;
    if (vm.selection.size !== 1) return;
    const id = [...vm.selection][0];
    const b = vm.state.byId.get(id);
    if (!b || b.owner !== vm.me || b.rallyX < 0 || !(b.kind in BUILDINGS)) return;
    this.rally.visible = true;
    this.rally.position.set(b.rallyX / FP, 0, b.rallyY / FP);
    const flag = this.rally.getObjectByName('flag') as THREE.Mesh;
    (flag.material as THREE.MeshLambertMaterial).color.copy(this.teamColors[vm.me]?.[0] ?? new THREE.Color(0xffffff));
    flag.rotation.y = Math.sin(this.time * 3) * 0.3;
  }

  private updateEffects(dt: number): void {
    // projectiles
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      const t = (this.time - p.t0) / p.dur;
      if (t >= 1) {
        this.scene.remove(p.mesh);
        this.projPool.push(p.mesh);
        this.projectiles.splice(i, 1);
        if (p.style === 'fire') {
          this.burst(p.to.x, p.to.y, p.to.z, 10, 0xf97316, 2, 0.14, 0.6, -1);
          this.burst(p.to.x, p.to.y, p.to.z, 6, 0xfde047, 1.5, 0.1, 0.5, -1);
        } else if (p.style === 'cannon') {
          this.burst(p.to.x, 0.3, p.to.z, 14, 0x1f2937, 3, 0.14, 0.8);
          this.burst(p.to.x, 0.4, p.to.z, 8, 0xfb923c, 2, 0.16, 0.4, -1);
        } else if (p.splash) this.burst(p.to.x, 0.3, p.to.z, p.style === 'boulder' ? 20 : 12, 0xa8a29e, 2.5, 0.12, 0.8);
        continue;
      }
      const pos = new THREE.Vector3().lerpVectors(p.from, p.to, t);
      pos.y += Math.sin(t * Math.PI) * p.arc;
      const next = new THREE.Vector3().lerpVectors(p.from, p.to, Math.min(1, t + 0.05));
      next.y += Math.sin(Math.min(1, t + 0.05) * Math.PI) * p.arc;
      p.mesh.position.copy(pos);
      p.mesh.lookAt(next);
      if (p.style === 'rock' || p.style === 'boulder') p.mesh.rotation.x += this.time * 5;
      if (p.style === 'fire' && Math.random() < 0.6) this.burst(pos.x, pos.y, pos.z, 1, Math.random() < 0.5 ? 0xf97316 : 0xfde047, 0.3, 0.1, 0.35, -0.5);
    }
    // particles
    let k = 0;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const q = this.particles[i];
      q.life -= dt;
      if (q.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      q.vy -= q.gravity * dt;
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.z += q.vz * dt;
      if (q.y < 0.05 && q.gravity > 0) {
        q.y = 0.05;
        q.vy *= -0.3;
        q.vx *= 0.6;
        q.vz *= 0.6;
      }
      const sz = q.size * Math.min(1, (q.life / q.max) * 2);
      tmpM.compose(tmpV.set(q.x, q.y, q.z), tmpQ.setFromAxisAngle(UP, q.life * 4), tmpS.set(sz, sz, sz));
      this.particleMesh.setMatrixAt(k, tmpM);
      this.particleMesh.setColorAt(k, q.color);
      k++;
    }
    this.particleMesh.count = k;
    this.particleMesh.instanceMatrix.needsUpdate = true;
    if (this.particleMesh.instanceColor) this.particleMesh.instanceColor.needsUpdate = true;
    // click markers
    for (let i = this.markers.length - 1; i >= 0; i--) {
      const m = this.markers[i];
      const t = (this.time - m.t0) / 0.5;
      if (t >= 1) {
        this.scene.remove(m.mesh);
        m.mesh.geometry.dispose();
        this.markers.splice(i, 1);
        continue;
      }
      const sc = 1.4 - t;
      m.mesh.scale.set(sc, sc, sc);
      (m.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - t;
    }
  }

  dispose(): void {
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
