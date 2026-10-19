/**
 * People for the raid game: guards, soldiers, the head of security and office staff.
 *
 * Every character is ONE SkinnedMesh (12 bones, rigid weights, vertex colours) plus, when armed, one weapon
 * mesh on the hand bone and a muzzle flash that is only visible on the frame a shot is fired. So a character
 * costs 1 draw call unarmed, 2 armed, 3 while firing. Rigid skinning keeps animation as simple as the old
 * groups-of-boxes rig (rotate a bone, everything bound to it follows) without one draw call per box.
 *
 * Geometry is shared per kind/variant; the material is per character (same shader program for all) so the hurt
 * flash and visor colour are per character. Camouflage is procedural in the fragment shader, no textures.
 * Hits: invisible box proxies on the bones (`hit.all`), the skinned mesh itself is not raycast.
 */
import * as THREE from "three";

export type CharacterKind = "officer" | "armoredOfficer" | "soldier" | "boss" | "civilian";
export type PoseName = "idle" | "walk" | "run" | "crouch" | "crouchWalk" | "cower" | "typing" | "sipping" | "talking" | "rope";
export type HitZone = "head" | "body" | "armor" | "limb";

/** How many distinct civilians there are; any variant number works, it wraps. */
export const CIVILIAN_VARIANTS = 12;

/** What a character is doing. Keep one object per character and mutate it; `poseCharacter` never allocates. */
export interface PoseState {
  pose: PoseName;
  /** Gait phase in radians (e.g. distance walked * 9). Defaults to time-driven. */
  gait?: number;
  /** Seated (chair): for idle, typing, sipping, talking. */
  sit?: boolean;
  /** Weapon up (armed kinds). */
  aim?: boolean;
  /** Fire kick 0..1, set to 1 on a shot and decay it (~10/s). Shows the muzzle flash above 0.35. */
  recoil?: number;
  /** Reload progress 0..1 (0 = not reloading). */
  reload?: number;
  /** Hit stagger 0..1, decay it. */
  stagger?: number;
  /** Where the hit came from, in the character's frame: 0 = from in front (+z), PI/2 = from its +x side. */
  hitDir?: number;
  /** Death fall progress 0..1 (0 = alive). Falls away from `hitDir`. */
  fall?: number;
  /** Head yaw offset in radians. */
  look?: number;
  /** Weapon slung on the back (automatic for rope). */
  sling?: boolean;
}

export interface Character {
  kind: CharacterKind;
  variant: number;
  /** Add this to the scene; position it and set rotation.y (order is YXZ). Faces +z. */
  root: THREE.Group;
  mesh: THREE.SkinnedMesh;
  bones: THREE.Bone[];
  weapon: THREE.Mesh | null;
  /** Muzzle point (world position for tracers). */
  muzzle: THREE.Object3D | null;
  flash: THREE.Mesh | null;
  slung: boolean;
  hit: {
    head: THREE.Mesh;
    /** Everything but the head: torso, pelvis, limbs. */
    body: THREE.Mesh[];
    /** Raycast these (non-recursive): head + body. */
    all: THREE.Mesh[];
    zoneOf(o: THREE.Object3D): HitZone | null;
  };
  /** 0..1 red hurt flash. */
  setTint(hurt: number): void;
  /** Visor / goggle glow colour (no-op for civilians). */
  setVisor(color: number, intensity?: number): void;
  /** Hide the head (headshot pop). */
  setHeadVisible(v: boolean): void;
  dispose(): void;
}

// Bones. Bind pose: standing, arms down, every bone unrotated, so bone-local = model offset.
const BASE = 0, HIPS = 1, CHEST = 2, HEAD = 3, ARM_L = 4, FORE_L = 5, ARM_R = 6, FORE_R = 7, THIGH_L = 8, SHIN_L = 9, THIGH_R = 10, SHIN_R = 11;
const PARENT = [-1, 0, 1, 2, 2, 4, 2, 6, 1, 8, 1, 10];
// prettier-ignore
const BIND = [0, 0, 0, 0, 0.92, 0, 0, 1, 0, 0, 1.6, 0, 0.29, 1.5, 0, 0.29, 1.22, 0, -0.29, 1.5, 0, -0.29, 1.22, 0, 0.11, 0.92, 0, 0.11, 0.48, 0, -0.11, 0.92, 0, -0.11, 0.48, 0];
const HAND_Y = -0.29; // hand centre below the elbow

const ACCENT = 0xffb81f;
const GOLD = 0xffc94a;

// Box faces: normal, u, v with u x v = normal (CCW from outside).
// prettier-ignore
const FACES = [1,0,0, 0,1,0, 0,0,1,  -1,0,0, 0,0,1, 0,1,0,  0,1,0, 0,0,1, 1,0,0,  0,-1,0, 1,0,0, 0,0,1,  0,0,1, 1,0,0, 0,1,0,  0,0,-1, 0,1,0, 1,0,0];
const SHADE = [0.93, 0.93, 1.05, 0.7, 1, 0.88];
const CU = [-1, 1, 1, -1];
const CV = [-1, -1, 1, 1];
const _c = new THREE.Color();

class Parts {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  fx: number[] = [];
  bone: number[] = [];
  idx: number[] = [];
  /** Axis-aligned box at model position (x, y, z) bound to `b`. glow: self-lit by its colour; visor: lit by setVisor. */
  box(w: number, h: number, d: number, x: number, y: number, z: number, hex: number, b = 0, glow = 0, visor = 0, camo = 0) {
    _c.setHex(hex);
    const hs = [w / 2, h / 2, d / 2];
    const c = [x, y, z];
    for (let f = 0; f < 6; f++) {
      const o = f * 9;
      const at = this.pos.length / 3;
      for (let k = 0; k < 4; k++) {
        for (let a = 0; a < 3; a++) this.pos.push(c[a] + (FACES[o + a] + FACES[o + 3 + a] * CU[k] + FACES[o + 6 + a] * CV[k]) * hs[a]);
        this.nor.push(FACES[o], FACES[o + 1], FACES[o + 2]);
        this.col.push(_c.r * SHADE[f], _c.g * SHADE[f], _c.b * SHADE[f]);
        this.fx.push(glow, visor, camo);
        this.bone.push(b);
      }
      this.idx.push(at, at + 1, at + 2, at, at + 2, at + 3);
    }
  }
  geometry(skinned: boolean) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    if (skinned) {
      const n = this.bone.length;
      const si = new Uint16Array(n * 4);
      const sw = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        si[i * 4] = this.bone[i];
        sw[i * 4] = 1;
      }
      g.setAttribute("aFx", new THREE.Float32BufferAttribute(this.fx, 3));
      g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(si, 4));
      g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(sw, 4));
    }
    g.setIndex(this.idx);
    return g;
  }
}

interface Look {
  top: number;
  sleeve: number;
  legs: number;
  skin: number;
  shoe: number;
  hand: number;
  w: number;
  camo: number;
}

/** Shared body: legs, pelvis, torso, arms, neck, head. */
function humanoid(p: Parts, o: Look) {
  for (const s of [1, -1]) {
    const L = s > 0;
    const x = 0.11 * s;
    const ax = 0.29 * s;
    p.box(0.18, 0.48, 0.2, x, 0.68, 0, o.legs, L ? THIGH_L : THIGH_R, 0, 0, o.camo);
    p.box(0.17, 0.42, 0.19, x, 0.27, 0, o.legs, L ? SHIN_L : SHIN_R, 0, 0, o.camo);
    p.box(0.19, 0.1, 0.27, x, 0.05, 0.03, o.shoe, L ? SHIN_L : SHIN_R);
    p.box(0.12, 0.32, 0.13, ax, 1.35, 0, o.sleeve, L ? ARM_L : ARM_R, 0, 0, o.camo);
    p.box(0.11, 0.25, 0.12, ax, 1.1, 0, o.sleeve, L ? FORE_L : FORE_R, 0, 0, o.camo);
    p.box(0.1, 0.1, 0.1, ax, 0.93, 0, o.hand, L ? FORE_L : FORE_R);
  }
  p.box(o.w * 0.95, 0.17, 0.24, 0, 0.92, 0, o.legs, HIPS, 0, 0, o.camo);
  p.box(o.w, 0.6, 0.25, 0, 1.28, 0, o.top, CHEST, 0, 0, o.camo);
  p.box(0.12, 0.1, 0.12, 0, 1.61, 0, o.skin, HEAD);
  p.box(0.23, 0.25, 0.23, 0, 1.75, 0, o.skin, HEAD);
}

function eyes(p: Parts) {
  p.box(0.04, 0.03, 0.01, 0.055, 1.77, 0.118, 0x1a1512, HEAD);
  p.box(0.04, 0.03, 0.01, -0.055, 1.77, 0.118, 0x1a1512, HEAD);
}

const SHIRTS = [0xe8ecf2, 0x8fb8de, 0x2f4a6e, 0xc8553d, 0x6a8f5a, 0xd9c38a, 0x7a4e8a, 0x3a3d44, 0xe0a0b0, 0xf0d060];
const TROUSERS = [0x2b2f3a, 0x3d3226, 0x55606e, 0x1d1f24, 0x6b5a45, 0x2e3e5c];
const SKINS = [0xf1c8a8, 0xd9a07a, 0xb57a52, 0x8d5a3a, 0x5e3a24, 0xe6b48f];
const HAIRS = [0x1a1410, 0x3b2516, 0x6b4426, 0xb88a4a, 0x8a8a8a, 0x2a1a12, 0xa0402a];
const JACKETS = [0x2a2e38, 0x4a3b2c, 0x5a6470, 0x23324a];

function civilian(p: Parts, v: number) {
  const shirt = SHIRTS[v % SHIRTS.length];
  const skin = SKINS[(v * 7 + 3) % SKINS.length];
  const hair = HAIRS[(v * 3 + 1) % HAIRS.length];
  const jacket = v % 3 === 2 ? JACKETS[(v >> 1) % JACKETS.length] : 0;
  const w = 0.42 + ((v * 7) % 3) * 0.02;
  humanoid(p, { top: jacket || shirt, sleeve: jacket || shirt, legs: TROUSERS[(v * 5 + 1) % TROUSERS.length], skin, shoe: v % 2 ? 0x1c1a18 : 0x4a3426, hand: skin, w, camo: 0 });
  eyes(p);
  if (jacket) {
    p.box(0.12, 0.5, 0.01, 0, 1.32, 0.13, shirt, CHEST); // shirt between the open lapels
    p.box(w + 0.02, 0.06, 0.27, 0, 1.0, 0, jacket, CHEST); // hem
  } else p.box(0.16, 0.05, 0.01, 0, 1.55, 0.13, shirt === 0xe8ecf2 ? 0xc8ccd4 : 0xe8ecf2, CHEST); // collar
  const style = v % 4;
  p.box(0.25, style === 3 ? 0.03 : 0.08, 0.25, 0, style === 3 ? 1.88 : 1.89, -0.01, hair, HEAD); // top
  if (style !== 3) p.box(0.25, style === 1 ? 0.34 : 0.17, 0.05, 0, style === 1 ? 1.73 : 1.8, -0.115, hair, HEAD); // back
  if (style === 1) for (const s of [1, -1]) p.box(0.03, 0.22, 0.2, 0.125 * s, 1.78, -0.02, hair, HEAD); // long sides
  if (style === 2) p.box(0.11, 0.1, 0.1, 0, 1.9, -0.15, hair, HEAD); // bun
  if (v % 5 === 1 || v % 5 === 3) {
    p.box(0.22, 0.012, 0.012, 0, 1.79, 0.123, 0x101012, HEAD);
    for (const s of [1, -1]) p.box(0.075, 0.055, 0.01, 0.06 * s, 1.77, 0.124, 0x2a3440, HEAD, 0.15);
  }
  if (v % 2 === 0) {
    for (const s of [1, -1]) p.box(0.015, 0.2, 0.01, 0.05 * s, 1.47, 0.132, 0x2c5fa8, CHEST);
    p.box(0.07, 0.09, 0.01, 0, 1.33, 0.135, 0xf2f4f7, CHEST, 0.15);
    p.box(0.07, 0.02, 0.012, 0, 1.36, 0.136, ACCENT, CHEST, 0.6);
  }
}

function guardBody(p: Parts, kind: CharacterKind) {
  if (kind === "soldier") {
    const camo = 0x5b6142;
    humanoid(p, { top: camo, sleeve: camo, legs: camo, skin: 0xb5845e, shoe: 0x2b2418, hand: 0x2a2a24, w: 0.44, camo: 1 });
    eyes(p);
    p.box(0.52, 0.48, 0.34, 0, 1.32, 0, 0x5a5238, CHEST); // plate carrier
    for (const x of [-0.15, 0, 0.15]) p.box(0.11, 0.13, 0.07, x, 1.16, 0.2, 0x4c4630, CHEST); // mag pouches
    p.box(0.08, 0.14, 0.06, 0.18, 1.45, 0.2, 0x3a3628, CHEST); // radio
    p.box(0.46, 0.08, 0.28, 0, 0.98, 0, 0x2e2a20, HIPS); // belt
    p.box(0.1, 0.12, 0.08, -0.2, 0.93, 0.08, 0x4c4630, HIPS); // hip pouch
    p.box(0.31, 0.15, 0.31, 0, 1.9, -0.01, 0x4a4f36, HEAD); // helmet
    p.box(0.33, 0.04, 0.33, 0, 1.83, -0.01, 0x41452f, HEAD); // rim
    p.box(0.32, 0.03, 0.32, 0, 1.88, -0.01, 0x1c1c18, HEAD); // goggle strap
    for (const s of [1, -1]) p.box(0.09, 0.06, 0.04, 0.055 * s, 1.885, 0.165, 0x0c0f0a, HEAD, 0, 1); // goggles up
    for (const s of [1, -1]) p.box(0.2, 0.1, 0.06, 0.11 * s, 0.48, 0.1, 0x3a3a2c, s > 0 ? SHIN_L : SHIN_R); // knee pads
    return;
  }
  const boss = kind === "boss";
  const armored = kind === "armoredOfficer";
  const suit = boss ? 0x1a1c22 : 0x23262e;
  humanoid(p, { top: suit, sleeve: suit, legs: suit, skin: 0xc89878, shoe: 0x0f1014, hand: 0x16171c, w: boss ? 0.48 : 0.44, camo: 0 });
  p.box(0.46, 0.07, 0.27, 0, 1.0, 0, 0x111216, HIPS); // belt
  if (boss) {
    p.box(0.6, 0.56, 0.38, 0, 1.3, 0, 0x2a2620, CHEST); // chest plate
    p.box(0.5, 0.04, 0.02, 0, 1.56, 0.19, GOLD, CHEST, 0.6);
    p.box(0.16, 0.08, 0.02, 0.15, 1.42, 0.195, GOLD, CHEST, 0.9); // badge
    p.box(0.44, 0.1, 0.36, 0, 1.62, -0.02, 0x2a2620, CHEST); // collar
    for (const s of [1, -1]) {
      p.box(0.21, 0.15, 0.21, 0.31 * s, 1.5, 0, 0x2a2620, s > 0 ? ARM_L : ARM_R); // pauldrons
      p.box(0.14, 0.18, 0.15, 0.29 * s, 1.08, 0, 0x2a2620, s > 0 ? FORE_L : FORE_R); // gauntlets
      p.box(0.2, 0.26, 0.06, 0.11 * s, 0.7, 0.11, 0x2a2620, s > 0 ? THIGH_L : THIGH_R); // thigh plates
      p.box(0.2, 0.12, 0.06, 0.11 * s, 0.48, 0.11, 0x2a2620, s > 0 ? SHIN_L : SHIN_R);
    }
    p.box(0.32, 0.18, 0.32, 0, 1.88, -0.01, 0x0f1014, HEAD);
    p.box(0.27, 0.15, 0.03, 0, 1.75, 0.13, 0x0a0a0a, HEAD, 0, 1); // full gold visor
    return;
  }
  if (armored) {
    p.box(0.54, 0.52, 0.36, 0, 1.31, 0, 0x2b2f38, CHEST); // heavy vest
    p.box(0.42, 0.08, 0.32, 0, 1.6, -0.01, 0x2b2f38, CHEST); // collar
    for (const x of [-0.13, 0.13]) p.box(0.12, 0.12, 0.06, x, 1.14, 0.2, 0x22252c, CHEST);
    p.box(0.34, 0.07, 0.02, 0, 1.45, 0.185, ACCENT, CHEST, 0.6);
    for (const s of [1, -1]) {
      p.box(0.16, 0.12, 0.17, 0.29 * s, 1.47, 0, 0x2b2f38, s > 0 ? ARM_L : ARM_R);
      p.box(0.2, 0.1, 0.06, 0.11 * s, 0.48, 0.1, 0x15171c, s > 0 ? SHIN_L : SHIN_R);
    }
    p.box(0.31, 0.16, 0.31, 0, 1.9, -0.01, 0x0f1014, HEAD);
    p.box(0.26, 0.17, 0.03, 0, 1.76, 0.125, 0x0a0a0a, HEAD, 0, 1); // face shield
    return;
  }
  p.box(0.5, 0.48, 0.32, 0, 1.3, 0, 0x343844, CHEST); // vest
  p.box(0.3, 0.1, 0.02, 0, 1.42, 0.165, ACCENT, CHEST, 0.5); // badge strip
  eyes(p);
  p.box(0.3, 0.17, 0.3, 0, 1.87, -0.01, 0x0f1014, HEAD); // helmet
  p.box(0.26, 0.08, 0.03, 0, 1.76, 0.125, 0x0a0a0a, HEAD, 0, 1); // visor
}

// Weapons, in their own frame: barrel +z, up +y, origin at the grip (the hand).
function weaponParts(rifle: boolean) {
  const p = new Parts();
  if (rifle) {
    p.box(0.04, 0.1, 0.05, 0, -0.03, 0, 0x15161b);
    p.box(0.06, 0.1, 0.36, 0, 0.05, 0.08, 0x23251f);
    p.box(0.055, 0.07, 0.22, 0, 0.05, 0.36, 0x3a3a2e);
    p.box(0.025, 0.025, 0.18, 0, 0.055, 0.55, 0x101114);
    p.box(0.05, 0.1, 0.24, 0, 0.02, -0.2, 0x23251f);
    p.box(0.045, 0.16, 0.07, 0, -0.06, 0.15, 0x15161b);
    p.box(0.045, 0.05, 0.11, 0, 0.125, 0.08, 0x101114);
    p.box(0.035, 0.035, 0.01, 0, 0.125, 0.136, 0xff5a3c, 0, 1);
  } else {
    p.box(0.04, 0.11, 0.05, 0, -0.02, -0.01, 0x15161b);
    p.box(0.045, 0.05, 0.22, 0, 0.05, 0.06, 0x2a2d35);
    p.box(0.047, 0.006, 0.16, 0, 0.077, 0.06, ACCENT);
  }
  return p;
}

// Shared resources.
const bodyGeos = new Map<string, THREE.BufferGeometry>();
const weaponGeos = new Map<boolean, THREE.BufferGeometry>();
const proxyGeos = new Map<string, THREE.BoxGeometry>();
let weaponMat: THREE.MeshStandardMaterial | null = null;
let flashMat: THREE.MeshBasicMaterial | null = null;
let flashGeo: THREE.BufferGeometry | null = null;
let proxyMat: THREE.MeshBasicMaterial | null = null;
const noRaycast = () => {};

function bodyGeometry(kind: CharacterKind, v: number) {
  const key = kind === "civilian" ? `c${v}` : kind;
  let g = bodyGeos.get(key);
  if (!g) {
    const p = new Parts();
    if (kind === "civilian") civilian(p, v);
    else guardBody(p, kind);
    g = p.geometry(true);
    bodyGeos.set(key, g);
  }
  return g;
}

const VERT_HEAD = /* glsl */ `#include <common>
attribute vec3 aFx;
varying vec3 vFx;
varying vec3 vBind;`;
const FRAG_HEAD = /* glsl */ `#include <common>
varying vec3 vFx;
varying vec3 vBind;
uniform vec3 uVisor;
float rpH(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
float rpN(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(rpH(i), rpH(i + vec3(1,0,0)), f.x), mix(rpH(i + vec3(0,1,0)), rpH(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(rpH(i + vec3(0,0,1)), rpH(i + vec3(1,0,1)), f.x), mix(rpH(i + vec3(0,1,1)), rpH(i + vec3(1,1,1)), f.x), f.y), f.z);
}`;
const FRAG_CAMO = /* glsl */ `#include <color_fragment>
if (vFx.z > 0.5) {
  float n = rpN(vBind * 7.0) * 0.65 + rpN(vBind * 17.0) * 0.35;
  vec3 camo = n < 0.36 ? vec3(0.05, 0.06, 0.035) : n < 0.5 ? vec3(0.11, 0.12, 0.065) : n < 0.64 ? vec3(0.2, 0.17, 0.1) : vec3(0.035, 0.03, 0.022);
  diffuseColor.rgb = camo;
}`;
const FRAG_GLOW = /* glsl */ `#include <emissivemap_fragment>
totalEmissiveRadiance += diffuseColor.rgb * vFx.x * 1.6 + uVisor * vFx.y;`;

function bodyMaterial(visor: { value: THREE.Color }) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.12 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uVisor = visor;
    sh.vertexShader = sh.vertexShader.replace("#include <common>", VERT_HEAD).replace("#include <begin_vertex>", "#include <begin_vertex>\nvFx = aFx;\nvBind = position;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", FRAG_HEAD)
      .replace("#include <color_fragment>", FRAG_CAMO)
      .replace("#include <emissivemap_fragment>", FRAG_GLOW);
  };
  m.customProgramCacheKey = () => "raidPeople1";
  return m;
}

function proxy(w: number, h: number, d: number, x: number, y: number, z: number, zone: HitZone, parent: THREE.Object3D) {
  const key = `${w},${h},${d}`;
  let g = proxyGeos.get(key);
  if (!g) proxyGeos.set(key, (g = new THREE.BoxGeometry(w, h, d)));
  proxyMat ??= new THREE.MeshBasicMaterial({ visible: false });
  const m = new THREE.Mesh(g, proxyMat);
  m.position.set(x, y, z);
  m.visible = false; // never drawn; raycasters still hit invisible meshes
  m.userData.raidZone = zone;
  parent.add(m);
  return m;
}

const VISOR: Record<CharacterKind, [number, number]> = {
  officer: [0x6cc4ff, 2],
  armoredOfficer: [0x6cc4ff, 1.6],
  soldier: [0x7fe08a, 0.5],
  boss: [GOLD, 2],
  civilian: [0, 0],
};

/** Builds a character. `variant` picks the civilian look (wraps at CIVILIAN_VARIANTS); ignored for the others. */
export function makeCharacter(kind: CharacterKind, variant = 0): Character {
  const v = ((variant % CIVILIAN_VARIANTS) + CIVILIAN_VARIANTS) % CIVILIAN_VARIANTS;
  const root = new THREE.Group();
  root.rotation.order = "YXZ";
  const visor = { value: new THREE.Color() };
  const mat = bodyMaterial(visor);
  const mesh = new THREE.SkinnedMesh(bodyGeometry(kind, v), mat);
  mesh.raycast = noRaycast;
  mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.5);
  root.add(mesh);
  const bones: THREE.Bone[] = [];
  for (let i = 0; i < PARENT.length; i++) {
    const b = new THREE.Bone();
    const p = PARENT[i];
    b.position.set(BIND[i * 3] - (p < 0 ? 0 : BIND[p * 3]), BIND[i * 3 + 1] - (p < 0 ? 0 : BIND[p * 3 + 1]), BIND[i * 3 + 2] - (p < 0 ? 0 : BIND[p * 3 + 2]));
    (p < 0 ? mesh : bones[p]).add(b);
    bones.push(b);
  }
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  mesh.bind(skeleton);

  let weapon: THREE.Mesh | null = null;
  let muzzle: THREE.Object3D | null = null;
  let flash: THREE.Mesh | null = null;
  if (kind !== "civilian") {
    const rifle = kind === "soldier";
    let wg = weaponGeos.get(rifle);
    if (!wg) weaponGeos.set(rifle, (wg = weaponParts(rifle).geometry(false)));
    weaponMat ??= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.55 });
    weapon = new THREE.Mesh(wg, weaponMat);
    weapon.raycast = noRaycast;
    weapon.rotation.order = "ZYX";
    holdWeapon(weapon, bones, false);
    muzzle = new THREE.Object3D();
    muzzle.position.set(0, rifle ? 0.055 : 0.05, rifle ? 0.66 : 0.19);
    weapon.add(muzzle);
    if (!flashGeo) {
      const s = 0.1;
      flashGeo = new THREE.BufferGeometry();
      // prettier-ignore
      flashGeo.setAttribute("position", new THREE.Float32BufferAttribute([-s,-s,0, s,-s,0, s,s,0, -s,s,0, 0,-s,-s*1.6, 0,-s,s*1.6, 0,s,s*1.6, 0,s,-s*1.6], 3));
      flashGeo.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    }
    flashMat ??= new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true });
    flash = new THREE.Mesh(flashGeo, flashMat);
    flash.raycast = noRaycast;
    flash.visible = false;
    flash.position.z = 0.1;
    muzzle.add(flash);
  }

  const armor: HitZone = kind === "civilian" || kind === "officer" ? "body" : "armor";
  const head = proxy(0.3, 0.36, 0.31, 0, 0.18, 0.01, "head", bones[HEAD]);
  const body = [proxy(0.52, 0.64, 0.36, 0, 0.28, 0, armor, bones[CHEST]), proxy(0.42, 0.22, 0.26, 0, 0, 0, "body", bones[HIPS])];
  for (const [arm, fore, th, sh] of [
    [ARM_L, FORE_L, THIGH_L, SHIN_L],
    [ARM_R, FORE_R, THIGH_R, SHIN_R],
  ]) {
    body.push(
      proxy(0.15, 0.3, 0.15, 0, -0.14, 0, "limb", bones[arm]),
      proxy(0.14, 0.34, 0.14, 0, -0.17, 0, "limb", bones[fore]),
      proxy(0.2, 0.46, 0.22, 0, -0.22, 0, "limb", bones[th]),
      proxy(0.2, 0.48, 0.26, 0, -0.24, 0.02, "limb", bones[sh]),
    );
  }

  const c: Character = {
    kind,
    variant: v,
    root,
    mesh,
    bones,
    weapon,
    muzzle,
    flash,
    slung: false,
    hit: { head, body, all: [head, ...body], zoneOf: (o) => (o.userData.raidZone as HitZone | undefined) ?? null },
    setTint: (h) => {
      mat.emissive.setRGB(0.55 * h, 0.04 * h, 0.03 * h);
    },
    setVisor: (color, intensity = 2) => {
      visor.value.setHex(color).multiplyScalar(intensity);
    },
    setHeadVisible: (on) => {
      bones[HEAD].scale.setScalar(on ? 1 : 0.0001);
    },
    dispose: () => {
      root.removeFromParent();
      mat.dispose();
      skeleton.dispose();
    },
  };
  const [vc, vi] = VISOR[kind];
  c.setVisor(vc, vi);
  if (kind === "boss") root.scale.setScalar(1.2);
  poseCharacter(c, { pose: "idle" }, 0);
  return c;
}

/** Puts the weapon in the right hand or slung across the back. */
function holdWeapon(w: THREE.Mesh, bones: THREE.Bone[], slung: boolean) {
  if (slung) {
    bones[CHEST].add(w);
    w.position.set(0.05, 0.3, -0.2);
    w.rotation.set(-Math.PI / 2, 0, 0.7);
  } else {
    bones[FORE_R].add(w);
    w.position.set(0, HAND_Y, 0.0);
    w.rotation.set(Math.PI / 2, 0, 0);
  }
}

const _axis = new THREE.Vector3();
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/** Poses every bone for this frame. Allocation-free; call once per visible character per frame. */
export function poseCharacter(c: Character, s: PoseState, t: number) {
  const b = c.bones;
  for (let i = 0; i < b.length; i++) b[i].rotation.set(0, 0, 0);
  const base = b[BASE], hips = b[HIPS], chest = b[CHEST], head = b[HEAD];
  const aL = b[ARM_L], fL = b[FORE_L], aR = b[ARM_R], fR = b[FORE_R], tL = b[THIGH_L], sL = b[SHIN_L], tR = b[THIGH_R], sR = b[SHIN_R];
  base.position.y = 0;
  hips.position.y = 0.92;
  const p = s.pose;
  const rifle = c.kind === "soldier";
  const wantSling = p === "rope" || !!s.sling;
  if (c.weapon && wantSling !== c.slung) {
    c.slung = wantSling;
    holdWeapon(c.weapon, b, wantSling);
  }
  let free = true; // arms are posed by the overlay below (armed and not busy)
  aL.rotation.z = 0.07;
  aR.rotation.z = -0.07;

  if (p === "walk" || p === "run" || p === "crouchWalk") {
    const run = p === "run";
    const g = s.gait ?? t * (run ? 13 : p === "walk" ? 9 : 7);
    const a = run ? 0.95 : p === "walk" ? 0.55 : 0.4;
    const sn = Math.sin(g);
    const cs = Math.cos(g);
    const crouch = p === "crouchWalk" ? 1 : 0;
    tL.rotation.x = sn * a - crouch;
    tR.rotation.x = -sn * a - crouch;
    sL.rotation.x = a * 1.3 * Math.max(0, -cs) + 0.1 + crouch * 1.5;
    sR.rotation.x = a * 1.3 * Math.max(0, cs) + 0.1 + crouch * 1.5;
    aL.rotation.x = -sn * a * 0.7;
    aR.rotation.x = sn * a * 0.7;
    fL.rotation.x = fR.rotation.x = run ? -1.1 : -0.25;
    hips.position.y = 0.92 - crouch * 0.27 + Math.abs(cs) * (run ? 0.05 : 0.025) - (run ? 0.05 : 0.02);
    chest.rotation.x = run ? 0.22 : 0.04 + crouch * 0.3;
    chest.rotation.y = sn * a * 0.12;
  } else if (p === "crouch") {
    hips.position.y = 0.64;
    tL.rotation.x = -1.0;
    sL.rotation.x = 1.6;
    tR.rotation.x = -0.35;
    sR.rotation.x = 1.75;
    chest.rotation.x = 0.28 + Math.sin(t * 1.7) * 0.015;
  } else if (p === "cower") {
    free = false;
    hips.position.y = 0.5;
    tL.rotation.x = tR.rotation.x = -1.3;
    sL.rotation.x = sR.rotation.x = 2.0;
    tL.rotation.z = 0.15;
    tR.rotation.z = -0.15;
    chest.rotation.x = 0.4;
    const shake = Math.sin(t * 31) * 0.03;
    aL.rotation.x = -2.6 + shake;
    aR.rotation.x = -2.6 - shake;
    aL.rotation.z = 0.35;
    aR.rotation.z = -0.35;
    fL.rotation.x = fR.rotation.x = -1.3;
    head.rotation.x = 0.45;
  } else if (p === "rope") {
    free = false;
    const k = Math.sin(t * 3) * 0.12;
    aL.rotation.x = -2.95 + k;
    aR.rotation.x = -2.85 - k;
    aL.rotation.z = -0.2;
    aR.rotation.z = 0.2;
    fL.rotation.x = fR.rotation.x = -0.15;
    tL.rotation.x = -0.6;
    sL.rotation.x = 1.0;
    tR.rotation.x = -0.2;
    sR.rotation.x = 0.45;
    tR.rotation.z = 0.12;
    head.rotation.x = 0.25;
  } else {
    // idle, typing, sipping, talking (standing or seated)
    chest.rotation.x = Math.sin(t * 1.7) * 0.015;
    if (p === "typing") {
      free = false;
      chest.rotation.x += 0.1;
      aL.rotation.x = aR.rotation.x = -0.45;
      aL.rotation.z = -0.12;
      aR.rotation.z = 0.12;
      fL.rotation.x = -0.95 + Math.sin(t * 15) * 0.06;
      fR.rotation.x = -0.95 + Math.sin(t * 15 + 1.7) * 0.06;
      head.rotation.x = 0.12;
    } else if (p === "sipping") {
      free = false;
      const ph = t % 6;
      const k = smooth(ph / 0.5) * (1 - smooth((ph - 1.4) / 0.5));
      aR.rotation.x = -0.15 - k * 0.45;
      aR.rotation.z = -0.07 + k * 0.4;
      fR.rotation.x = -0.5 - k * 1.85;
      head.rotation.x = -0.22 * k;
    } else if (p === "talking") {
      free = false;
      aL.rotation.x = -0.4 + Math.sin(t * 2.6) * 0.25;
      fL.rotation.x = -1.0 + Math.sin(t * 3.1) * 0.4;
      aL.rotation.z = 0.15 + Math.sin(t * 1.9) * 0.1;
      aR.rotation.x = -0.2 + Math.sin(t * 2.1 + 1) * 0.15;
      fR.rotation.x = -0.6 + Math.sin(t * 2.7 + 2) * 0.35;
      head.rotation.x = Math.sin(t * 2.2) * 0.08;
      head.rotation.y = Math.sin(t * 0.8) * 0.2;
      chest.rotation.y = Math.sin(t * 0.9) * 0.08;
    }
    if (s.sit) {
      hips.position.y = 0.5;
      tL.rotation.x = tR.rotation.x = -1.5;
      sL.rotation.x = sR.rotation.x = 1.5;
    }
  }

  const armed = c.weapon !== null && !c.slung;
  const lean = chest.rotation.x;
  if (armed && free) {
    const r = s.reload ?? 0;
    if (r > 0) {
      const down = Math.sin(Math.min(1, r / 0.7) * Math.PI);
      aR.rotation.set(-0.55 - lean, 0, 0.35);
      fR.rotation.x = -1.2;
      aL.rotation.set(0.1 - down * 0.25 - (1 - down) * 0.9, 0, -0.1 - (1 - down) * 0.3);
      fL.rotation.x = -0.4 - (1 - down) * 0.8 + (r > 0.75 ? Math.sin((r - 0.75) * 25) * 0.2 : 0);
      head.rotation.x = 0.3;
    } else if (s.aim) {
      if (rifle) {
        aR.rotation.set(-1.05 - lean, 0, 0.3);
        fR.rotation.x = -0.52;
        aL.rotation.set(-1.25 - lean, 0, -0.62);
        fL.rotation.x = -0.45;
      } else {
        aR.rotation.set(-Math.PI / 2 - lean, 0, 0.12);
        fR.rotation.x = 0;
        aL.rotation.set(-1.35 - lean, 0, -0.5);
        fL.rotation.x = -0.35;
      }
      head.rotation.x = -lean * 0.8;
    } else if (rifle) {
      aR.rotation.set(-0.35, 0, 0.25);
      fR.rotation.x = -0.9;
      aL.rotation.set(-0.75, 0, -0.45);
      fL.rotation.x = -0.85;
    } else {
      aR.rotation.x = -0.45;
      fR.rotation.x = -0.55;
    }
  }
  const rc = armed ? (s.recoil ?? 0) : 0;
  if (rc > 0) {
    aR.rotation.x -= rc * 0.18;
    fR.rotation.x -= rc * 0.06;
    if (rifle) aL.rotation.x -= rc * 0.2;
    chest.rotation.x -= rc * 0.06;
  }
  if (c.flash) {
    c.flash.visible = rc > 0.35;
    if (rc > 0.35) {
      c.flash.scale.setScalar(0.5 + rc * 0.5);
      c.flash.rotation.z = t * 37;
    }
  }
  head.rotation.y += s.look ?? 0;

  const d = s.hitDir ?? 0;
  const back = Math.cos(d);
  const side = Math.sin(d);
  const st = s.stagger ?? 0;
  if (st > 0) {
    chest.rotation.x -= back * st * 0.45;
    chest.rotation.z += side * st * 0.4;
    head.rotation.x -= back * st * 0.3;
    head.rotation.z += side * st * 0.3;
    aL.rotation.z += st * 0.5;
    aR.rotation.z -= st * 0.5;
    hips.position.y -= st * 0.04;
  }
  const f = s.fall ?? 0;
  if (f > 0) {
    const e = Math.min(1, f) ** 2;
    const buckle = Math.sin(Math.min(1, f) * Math.PI);
    base.quaternion.setFromAxisAngle(_axis.set(-back, 0, side), e * 1.52);
    base.position.y = e * 0.12;
    tL.rotation.x -= buckle * 0.5;
    tR.rotation.x -= buckle * 0.4;
    sL.rotation.x += buckle * 0.9;
    sR.rotation.x += buckle * 0.7;
    aL.rotation.z += f * 1.1;
    aR.rotation.z -= f * 1.1;
    aL.rotation.x -= f * 0.4;
    aR.rotation.x -= f * 0.4;
    head.rotation.x -= back * f * 0.3;
    if (c.flash) c.flash.visible = false;
  }
}

/** Frees the geometry and materials shared by all characters. Call after disposing every character. */
export function disposePeople() {
  for (const g of bodyGeos.values()) g.dispose();
  for (const g of weaponGeos.values()) g.dispose();
  for (const g of proxyGeos.values()) g.dispose();
  bodyGeos.clear();
  weaponGeos.clear();
  proxyGeos.clear();
  flashGeo?.dispose();
  weaponMat?.dispose();
  flashMat?.dispose();
  proxyMat?.dispose();
  flashGeo = null;
  weaponMat = null;
  flashMat = null;
  proxyMat = null;
}
