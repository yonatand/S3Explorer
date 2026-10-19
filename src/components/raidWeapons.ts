// Weapons for the raid game: stats, first-person models, world pickups and per-frame animation.
// Models are low-poly boxes and cylinders merged per material (few draw calls). Geometry, materials and
// textures are shared across every model and pickup; disposeWeapons() frees them all.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export type WeaponId = "pistol" | "rifle" | "shotgun" | "shield";
export type FireMode = "semi" | "auto" | "pump";
export type AmmoType = "pistol" | "rifle" | "shell";

export interface WeaponStats {
  name: string;
  ammo: AmmoType;
  fireMode: FireMode;
  /** Damage per hit (per pellet for the shotgun). A guard has 100: three pistol body hits, one head hit. */
  damageBody: number;
  damageHead: number;
  pellets: number;
  rpm: number;
  magazine: number;
  reserveMax: number;
  /** Full reload in seconds; for the shotgun the time per shell (interruptible between shells). */
  reloadTime: number;
  reloadPerShell: boolean;
  /** Pump cycle after each shotgun shot, seconds (also the minimum time between shots). */
  pumpTime: number;
  /** Cone half-angle in radians. Moving adds spreadMove, the visual kick adds up to spreadBloom. */
  spreadHip: number;
  spreadCrouch: number;
  spreadMove: number;
  spreadBloom: number;
  /** Camera climb per shot (radians) and how fast it returns (1/s, exponential). */
  recoilPitch: number;
  recoilYaw: number;
  recoilRecovery: number;
  /** Visual kick of the model per shot. */
  kickBack: number;
  kickRise: number;
  /** Damage is full up to falloffStart metres, linear down to falloffMin x at falloffEnd, nothing past range. */
  falloffStart: number;
  falloffEnd: number;
  falloffMin: number;
  range: number;
  moveSpeed: number;
  /** Seconds to lower or raise this weapon when switching. */
  switchTime: number;
  /** Shield only: hit points of the panel, speed while held raised, block arcs (full angle, radians). */
  durability: number;
  raisedSpeed: number;
  blockArc: number;
  blockArcRaised: number;
}

const BASE = {
  pellets: 1, reloadPerShell: false, pumpTime: 0, durability: 0, raisedSpeed: 1, blockArc: 0, blockArcRaised: 0,
};
const DEG = Math.PI / 180;

export const WEAPONS: Record<WeaponId, WeaponStats> = {
  pistol: {
    ...BASE, name: "Pistol", ammo: "pistol", fireMode: "semi", damageBody: 34, damageHead: 100,
    rpm: 360, magazine: 12, reserveMax: 72, reloadTime: 1.3,
    spreadHip: 0.006, spreadCrouch: 0.004, spreadMove: 0.01, spreadBloom: 0.012,
    recoilPitch: 0.03, recoilYaw: 0.008, recoilRecovery: 10, kickBack: 0.05, kickRise: 0.22,
    falloffStart: 20, falloffEnd: 45, falloffMin: 0.6, range: 80, moveSpeed: 1, switchTime: 0.25,
  },
  rifle: {
    ...BASE, name: "Assault rifle", ammo: "rifle", fireMode: "auto", damageBody: 25, damageHead: 110,
    rpm: 660, magazine: 30, reserveMax: 180, reloadTime: 2.1,
    spreadHip: 0.009, spreadCrouch: 0.006, spreadMove: 0.018, spreadBloom: 0.022,
    recoilPitch: 0.018, recoilYaw: 0.01, recoilRecovery: 8, kickBack: 0.03, kickRise: 0.08,
    falloffStart: 30, falloffEnd: 70, falloffMin: 0.65, range: 120, moveSpeed: 0.9, switchTime: 0.4,
  },
  shotgun: {
    ...BASE, name: "Pump shotgun", ammo: "shell", fireMode: "pump", damageBody: 24, damageHead: 100, pellets: 9,
    rpm: 72, magazine: 6, reserveMax: 36, reloadTime: 0.5, reloadPerShell: true, pumpTime: 0.55,
    spreadHip: 0.05, spreadCrouch: 0.04, spreadMove: 0.012, spreadBloom: 0.01,
    recoilPitch: 0.08, recoilYaw: 0.02, recoilRecovery: 4.5, kickBack: 0.09, kickRise: 0.3,
    falloffStart: 7, falloffEnd: 20, falloffMin: 0.35, range: 40, moveSpeed: 0.92, switchTime: 0.45,
  },
  // The shield is held in the left hand with the pistol in the right; firing stats are the pistol's, a bit wilder.
  shield: {
    ...BASE, name: "Riot shield", ammo: "pistol", fireMode: "semi", damageBody: 34, damageHead: 100,
    rpm: 300, magazine: 12, reserveMax: 72, reloadTime: 1.6,
    spreadHip: 0.012, spreadCrouch: 0.008, spreadMove: 0.016, spreadBloom: 0.018,
    recoilPitch: 0.04, recoilYaw: 0.012, recoilRecovery: 9, kickBack: 0.05, kickRise: 0.25,
    falloffStart: 20, falloffEnd: 45, falloffMin: 0.6, range: 80, moveSpeed: 0.78, switchTime: 0.5,
    durability: 600, raisedSpeed: 0.6, blockArc: 70 * DEG, blockArcRaised: 140 * DEG,
  },
};

export const WEAPON_IDS: readonly WeaponId[] = ["pistol", "rifle", "shotgun", "shield"];

/** Seconds between shots (the pump cycle for the shotgun). */
export function fireInterval(id: WeaponId): number {
  const s = WEAPONS[id];
  return Math.max(60 / s.rpm, s.pumpTime);
}

/** Damage of one hit (one pellet) at a distance in metres. */
export function damageAt(id: WeaponId, dist: number, head: boolean): number {
  const s = WEAPONS[id];
  if (dist > s.range) return 0;
  // A pellet in the head falls off like a pistol round, so a shotgun headshot kills as surely as a
  // pistol headshot anywhere within the shotgun's range.
  const curve = head && s.pellets > 1 ? WEAPONS.pistol : s;
  const f = dist <= curve.falloffStart ? 1 : dist >= curve.falloffEnd ? curve.falloffMin
    : 1 - ((dist - curve.falloffStart) / (curve.falloffEnd - curve.falloffStart)) * (1 - curve.falloffMin);
  return (head ? s.damageHead : s.damageBody) * f;
}

/** Cone half-angle in radians for the next shot. moving is 0..1; kick is WeaponAnimState.kick. */
export function weaponSpread(id: WeaponId, crouched: boolean, moving: number, kick: number): number {
  const s = WEAPONS[id];
  return (crouched ? s.spreadCrouch : s.spreadHip) + s.spreadMove * moving + s.spreadBloom * Math.min(1, kick);
}

/** Whether a hit from `angle` radians off the player's facing (0 = straight ahead) lands on the shield. */
export function shieldCovers(raised: boolean, angle: number): boolean {
  const s = WEAPONS.shield;
  return Math.abs(angle) <= (raised ? s.blockArcRaised : s.blockArc) / 2;
}

// ---------------------------------------------------------------------------------------------
// Shared materials and textures

const ACCENT = 0xffb81f;
type Mat = "metal" | "polymer" | "accent" | "glow" | "red" | "glass" | "glove" | "sleeve" | "shell" | "brass" | "panel" | "crate";
let mats: Record<Mat, THREE.Material> | null = null;
let flashMat: THREE.MeshBasicMaterial | null = null;
const textures: THREE.Texture[] = [];
const tinted = new Map<string, THREE.Material>();

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  textures.push(t);
  return t;
}

function radial(g: CanvasRenderingContext2D, s: number, stops: [number, string][]) {
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  for (const [o, c] of stops) grad.addColorStop(o, c);
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
}

let glowTex: THREE.Texture | null = null;
const glowTexture = () =>
  (glowTex ??= canvasTex(64, 64, (g) => radial(g, 64, [[0, "rgba(255,255,255,0.9)"], [0.35, "rgba(255,255,255,0.35)"], [1, "rgba(255,255,255,0)"]])));

function shieldTexture() {
  return canvasTex(256, 448, (g) => {
    g.fillStyle = "rgba(150,186,226,0.30)";
    g.fillRect(0, 0, 256, 448);
    g.strokeStyle = "rgba(255,255,255,0.22)";
    g.lineWidth = 4;
    g.strokeRect(10, 10, 236, 428);
    // Viewport: a clearer window at eye height.
    g.clearRect(38, 46, 180, 84);
    g.fillStyle = "rgba(210,235,255,0.06)";
    g.fillRect(38, 46, 180, 84);
    g.strokeStyle = "rgba(230,240,255,0.6)";
    g.lineWidth = 3;
    g.strokeRect(38, 46, 180, 84);
    g.strokeStyle = "rgba(255,255,255,0.08)";
    g.lineWidth = 1;
    for (let i = 0; i < 16; i++) {
      const x = (i * 97) % 240, y = 150 + ((i * 61) % 280);
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + 18 + (i % 5) * 9, y - 6 + (i % 3) * 5);
      g.stroke();
    }
    g.fillStyle = "rgba(255,184,31,0.85)";
    g.fillRect(26, 262, 204, 8);
    g.fillStyle = "rgba(255,255,255,0.92)";
    g.font = "bold 40px Arial, Helvetica, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("SECURITY", 128, 228, 224);
  });
}

function M(): Record<Mat, THREE.Material> {
  if (mats) return mats;
  const std = (color: number, roughness: number, metalness = 0, extra: THREE.MeshStandardMaterialParameters = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
  mats = {
    metal: std(0x3a3e48, 0.35, 0.6),
    polymer: std(0x1a1c22, 0.8),
    accent: std(ACCENT, 0.5, 0.1, { emissive: ACCENT, emissiveIntensity: 0.45 }),
    glow: new THREE.MeshBasicMaterial({ color: ACCENT }),
    red: new THREE.MeshBasicMaterial({ color: 0xff3b30, toneMapped: false }),
    glass: std(0x9fd0ff, 0.05, 0.3, { transparent: true, opacity: 0.18, depthWrite: false }),
    glove: std(0x2b2f38, 0.9),
    sleeve: std(0x1d2433, 0.85),
    shell: std(0xa8261d, 0.6),
    brass: std(0xc9a24a, 0.3, 0.8),
    panel: std(0xffffff, 0.12, 0.05, { map: shieldTexture(), transparent: true, side: THREE.DoubleSide, depthWrite: false }),
    crate: std(0x2f3a2c, 0.8),
  };
  return mats;
}

function flashMaterial() {
  return (flashMat ??= new THREE.MeshBasicMaterial({
    map: canvasTex(64, 64, (g) => {
      radial(g, 64, [[0, "rgba(255,255,240,1)"], [0.25, "rgba(255,210,122,0.9)"], [0.6, "rgba(255,150,40,0.25)"], [1, "rgba(255,120,0,0)"]]);
      g.fillStyle = "rgba(255,230,170,0.85)";
      for (let i = 0; i < 4; i++) {
        g.setTransform(1, 0, 0, 1, 32, 32);
        g.rotate((i * Math.PI) / 2);
        g.beginPath();
        g.moveTo(-3, 0);
        g.lineTo(0, -31);
        g.lineTo(3, 0);
        g.fill();
      }
    }),
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  }));
}

/** A soft additive disc in a colour, shared per colour. */
function glowMat(color: number) {
  const k = "g" + color;
  let m = tinted.get(k);
  if (!m) tinted.set(k, (m = new THREE.MeshBasicMaterial({ color, map: glowTexture(), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false })));
  return m;
}
function stripeMat(color: number) {
  const k = "s" + color;
  let m = tinted.get(k);
  if (!m) tinted.set(k, (m = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.6, roughness: 0.5 })));
  return m;
}

// ---------------------------------------------------------------------------------------------
// Geometry kits: parts are collected per material and merged once, then cached by key.

type Kit = Partial<Record<Mat, THREE.BufferGeometry[]>>;
const tmp = new THREE.Object3D();
function put(k: Kit, m: Mat, g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) {
  tmp.position.set(x, y, z);
  tmp.rotation.set(rx, ry, rz);
  tmp.updateMatrix();
  g.applyMatrix4(tmp.matrix);
  (k[m] ??= []).push(g);
}
const bx = (k: Kit, m: Mat, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) =>
  put(k, m, new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz);
/** A cylinder lying along z. */
const cz = (k: Kit, m: Mat, r: number, len: number, seg: number, x: number, y: number, z: number) =>
  put(k, m, new THREE.CylinderGeometry(r, r, len, seg), x, y, z, Math.PI / 2);

const geoCache = new Map<string, Map<Mat, THREE.BufferGeometry>>();
let flashGeo: THREE.PlaneGeometry | null = null;
let discGeo: THREE.PlaneGeometry | null = null;

/** Meshes (one per material) for the named builders merged together, shifted so `pivot` is the origin. */
function shape(key: string, builders: ((k: Kit) => void)[], pivot?: [number, number, number]): THREE.Group {
  let merged = geoCache.get(key);
  if (!merged) {
    const k: Kit = {};
    for (const b of builders) b(k);
    merged = new Map();
    for (const name in k) {
      const list = k[name as Mat]!;
      const g = list.length === 1 ? list[0] : mergeGeometries(list)!;
      if (g !== list[0]) for (const s of list) s.dispose();
      if (pivot) g.translate(-pivot[0], -pivot[1], -pivot[2]);
      g.computeBoundingSphere();
      merged.set(name as Mat, g);
    }
    geoCache.set(key, merged);
  }
  const grp = new THREE.Group();
  const mm = M();
  merged.forEach((g, m) => {
    const mesh = new THREE.Mesh(g, mm[m]);
    if (m === "panel") mesh.renderOrder = 2;
    grp.add(mesh);
  });
  if (pivot) {
    grp.position.set(pivot[0], pivot[1], pivot[2]);
    grp.userData.x = pivot[0];
    grp.userData.y = pivot[1];
    grp.userData.z = pivot[2];
  }
  return grp;
}

// ---- builders, all in weapon space: origin at the top of the grip, barrel along -z ----

const pistolFrame = (k: Kit) => {
  bx(k, "polymer", 0.034, 0.028, 0.165, 0, -0.004, -0.055);
  bx(k, "polymer", 0.033, 0.115, 0.05, 0, -0.07, 0.022, -0.22);
  bx(k, "polymer", 0.006, 0.006, 0.048, 0, -0.036, -0.04);
  bx(k, "polymer", 0.006, 0.03, 0.006, 0, -0.023, -0.064);
  bx(k, "metal", 0.005, 0.02, 0.006, 0, -0.022, -0.03, 0.3);
  bx(k, "accent", 0.036, 0.004, 0.08, 0, -0.012, -0.09);
};
const pistolSlide = (k: Kit) => {
  bx(k, "metal", 0.036, 0.034, 0.2, 0, 0.028, -0.06);
  for (let i = 0; i < 4; i++) bx(k, "metal", 0.038, 0.026, 0.004, 0, 0.026, 0.008 + i * 0.008);
  bx(k, "metal", 0.03, 0.009, 0.008, 0, 0.049, 0.032);
  bx(k, "metal", 0.012, 0.005, 0.034, 0.008, 0.046, -0.03);
  bx(k, "glow", 0.006, 0.009, 0.006, 0, 0.049, -0.148);
  bx(k, "glow", 0.004, 0.004, 0.002, -0.009, 0.051, 0.0365);
  bx(k, "glow", 0.004, 0.004, 0.002, 0.009, 0.051, 0.0365);
};
const pistolMag = (k: Kit) => {
  bx(k, "polymer", 0.026, 0.1, 0.038, 0, -0.07, 0.024, -0.22);
  bx(k, "accent", 0.036, 0.012, 0.056, 0, -0.13, 0.036, -0.22);
};
const pistolHand = (k: Kit) => {
  bx(k, "glove", 0.046, 0.075, 0.058, 0.002, -0.075, 0.03, -0.22);
  bx(k, "glove", 0.012, 0.02, 0.05, 0.022, -0.04, -0.005, 0, 0.15);
  bx(k, "sleeve", 0.07, 0.075, 0.22, 0.014, -0.15, 0.15, 0.45);
};
const pistolSupport = (k: Kit) => {
  bx(k, "glove", 0.03, 0.065, 0.06, -0.03, -0.078, 0.03, -0.22);
  bx(k, "sleeve", 0.07, 0.075, 0.24, -0.07, -0.155, 0.14, 0.45, -0.45);
};

const rifleBody = (k: Kit) => {
  bx(k, "metal", 0.044, 0.05, 0.2, 0, 0, -0.04);
  bx(k, "metal", 0.046, 0.045, 0.26, 0, 0.045, -0.08);
  bx(k, "polymer", 0.026, 0.01, 0.24, 0, 0.072, -0.08);
  bx(k, "polymer", 0.056, 0.058, 0.24, 0, 0.035, -0.33);
  bx(k, "accent", 0.058, 0.006, 0.16, 0, 0.052, -0.33);
  for (const z of [-0.27, -0.33, -0.39]) bx(k, "metal", 0.058, 0.01, 0.02, 0, 0.022, z);
  cz(k, "metal", 0.011, 0.16, 8, 0, 0.04, -0.52);
  bx(k, "polymer", 0.02, 0.035, 0.02, 0, 0.058, -0.46);
  cz(k, "polymer", 0.017, 0.055, 8, 0, 0.04, -0.62);
  bx(k, "polymer", 0.034, 0.1, 0.045, 0, -0.06, 0.035, -0.3);
  bx(k, "polymer", 0.006, 0.006, 0.06, 0, -0.035, -0.005);
  bx(k, "metal", 0.005, 0.02, 0.006, 0, -0.02, 0.005, 0.3);
  bx(k, "polymer", 0.046, 0.04, 0.06, 0, -0.035, -0.1);
  cz(k, "metal", 0.014, 0.14, 8, 0, 0.03, 0.12);
  bx(k, "polymer", 0.044, 0.075, 0.13, 0, 0.015, 0.2);
  bx(k, "polymer", 0.03, 0.02, 0.1, 0, 0.06, 0.2);
  bx(k, "polymer", 0.04, 0.008, 0.012, 0, 0.06, 0.03);
  // Holographic optic: open hood, tinted glass, glowing ring-and-dot reticle facing the eye.
  bx(k, "polymer", 0.03, 0.016, 0.06, 0, 0.085, -0.06);
  bx(k, "polymer", 0.004, 0.045, 0.06, -0.022, 0.112, -0.06);
  bx(k, "polymer", 0.004, 0.045, 0.06, 0.022, 0.112, -0.06);
  bx(k, "polymer", 0.048, 0.005, 0.06, 0, 0.136, -0.06);
  bx(k, "accent", 0.049, 0.004, 0.01, 0, 0.14, -0.035);
  put(k, "glass", new THREE.PlaneGeometry(0.04, 0.04), 0, 0.112, -0.075);
  put(k, "red", new THREE.RingGeometry(0.0055, 0.0075, 20), 0, 0.112, -0.0745);
  put(k, "red", new THREE.CircleGeometry(0.0015, 8), 0, 0.112, -0.0745);
};
const rifleBolt = (k: Kit) => bx(k, "metal", 0.006, 0.016, 0.034, 0.025, 0.048, -0.04);
const rifleMag = (k: Kit) => {
  bx(k, "polymer", 0.03, 0.08, 0.055, 0, -0.09, -0.105, 0.12);
  bx(k, "polymer", 0.03, 0.07, 0.055, 0, -0.16, -0.087, 0.32);
  bx(k, "accent", 0.034, 0.012, 0.06, 0, -0.198, -0.074, 0.32);
};
const longGunHand = (k: Kit) => {
  bx(k, "glove", 0.05, 0.065, 0.06, 0.002, -0.055, 0.04, -0.3);
  bx(k, "glove", 0.012, 0.02, 0.05, 0.024, -0.02, 0.0, 0, 0.15);
  bx(k, "sleeve", 0.075, 0.075, 0.22, 0.016, -0.13, 0.16, 0.45);
};
const rifleSupport = (k: Kit) => {
  bx(k, "glove", 0.07, 0.05, 0.1, -0.008, 0.0, -0.33);
  bx(k, "sleeve", 0.075, 0.075, 0.3, -0.085, -0.075, -0.2, 0.3, -0.55);
};

const shotgunBody = (k: Kit) => {
  bx(k, "metal", 0.048, 0.07, 0.21, 0, 0.035, -0.05);
  bx(k, "accent", 0.05, 0.006, 0.15, 0, 0.02, -0.05);
  bx(k, "polymer", 0.002, 0.03, 0.06, 0.025, 0.045, -0.05);
  cz(k, "metal", 0.013, 0.5, 10, 0, 0.055, -0.4);
  bx(k, "polymer", 0.01, 0.006, 0.48, 0, 0.07, -0.4);
  cz(k, "metal", 0.011, 0.38, 8, 0, 0.018, -0.34);
  cz(k, "polymer", 0.013, 0.02, 8, 0, 0.018, -0.54);
  bx(k, "polymer", 0.03, 0.05, 0.015, 0, 0.035, -0.5);
  bx(k, "glow", 0.006, 0.006, 0.006, 0, 0.074, -0.635);
  bx(k, "polymer", 0.036, 0.1, 0.048, 0, -0.055, 0.04, -0.35);
  bx(k, "polymer", 0.006, 0.006, 0.06, 0, -0.03, -0.01);
  bx(k, "metal", 0.005, 0.02, 0.006, 0, -0.016, 0.0, 0.3);
  bx(k, "polymer", 0.045, 0.075, 0.24, 0, 0.012, 0.2, -0.08);
};
const PUMP: [number, number, number] = [0, 0.018, -0.3];
const shotgunPump = (k: Kit) => {
  cz(k, "polymer", 0.022, 0.14, 10, 0, 0.018, -0.3);
  for (const z of [-0.255, -0.285, -0.315, -0.345]) cz(k, "metal", 0.0225, 0.006, 10, 0, 0.018, z);
  cz(k, "accent", 0.023, 0.006, 10, 0, 0.018, -0.372);
  bx(k, "glove", 0.065, 0.045, 0.1, -0.006, -0.002, -0.3);
  bx(k, "sleeve", 0.075, 0.075, 0.3, -0.085, -0.075, -0.17, 0.3, -0.55);
};
const SHELL: [number, number, number] = [0, -0.01, -0.05];
const shotgunShell = (k: Kit) => {
  cz(k, "shell", 0.0095, 0.045, 8, 0, -0.01, -0.05);
  cz(k, "brass", 0.0098, 0.012, 8, 0, -0.01, -0.0215);
};

const SR = 0.62, SA = 0.3; // shield panel curvature radius and half-angle
const shieldBody = (k: Kit) => {
  const panel = new THREE.CylinderGeometry(SR, SR, 0.6, 10, 1, true, Math.PI - SA, SA * 2);
  put(k, "panel", panel, 0, 0, SR);
  const ex = SR * Math.sin(SA), ez = SR - SR * Math.cos(SA);
  bx(k, "polymer", 0.014, 0.6, 0.014, ex, 0, ez);
  bx(k, "polymer", 0.014, 0.6, 0.014, -ex, 0, ez);
  for (let i = 0; i < 4; i++) {
    const a = -SA + (i + 0.5) * (SA / 2), w = 2 * SR * Math.sin(SA / 4) + 0.004;
    for (const y of [0.3, -0.3]) bx(k, "polymer", w, 0.014, 0.014, SR * Math.sin(a), y, SR - SR * Math.cos(a), 0, -a);
  }
  bx(k, "polymer", 0.14, 0.02, 0.03, 0, -0.09, 0.025);
  bx(k, "polymer", 0.03, 0.11, 0.03, 0, -0.09, 0.05);
};
const shieldHand = (k: Kit) => {
  bx(k, "glove", 0.055, 0.07, 0.055, 0, -0.09, 0.06);
  bx(k, "sleeve", 0.075, 0.075, 0.26, -0.03, -0.15, 0.18, 0.3);
};

// ---------------------------------------------------------------------------------------------
// First-person models

export interface WeaponModel {
  id: WeaponId;
  /** Add to the camera. animateWeapon positions everything inside it. */
  node: THREE.Group;
  /** Where shots and tracers start; attach the muzzle light here. */
  muzzle: THREE.Object3D;
  flash: THREE.Mesh;
  /** gun (the held weapon), plus slide / bolt / mag / pump / shell / shield where the weapon has them. */
  parts: { [name: string]: THREE.Object3D };
}

/** How big each weapon sits on screen (tuned in the game's full-window view at 74 degrees). */
const VIEW_SCALE: Record<WeaponId, number> = { pistol: 0.92, rifle: 0.78, shotgun: 0.8, shield: 0.9 };
/**
 * Aiming down the sights: where the gun sits so its sight line (height above the gun's origin, and the
 * eye's distance to the rear of the sight) lies exactly on the view's centre, which is where shots go.
 * Pistol: the rear notch and the front post; rifle: the red-dot reticle; shotgun: the bead.
 */
const SIGHT: Record<WeaponId, { y: number; z: number; eye: number }> = {
  pistol: { y: 0.05, z: 0.0365, eye: 0.3 },
  rifle: { y: 0.112, z: -0.0745, eye: 0.15 },
  shotgun: { y: 0.074, z: -0.05, eye: 0.32 },
  shield: { y: 0.05, z: 0.0365, eye: 0.3 },
};
export const ADS_AT: Record<WeaponId, [number, number, number]> = Object.fromEntries(
  (Object.keys(SIGHT) as WeaponId[]).map((id) => [id, [0, -SIGHT[id].y * VIEW_SCALE[id], -SIGHT[id].eye - SIGHT[id].z * VIEW_SCALE[id]]]),
) as Record<WeaponId, [number, number, number]>;

function finish(id: WeaponId, gun: THREE.Group, muzzleAt: [number, number, number], parts: WeaponModel["parts"]): WeaponModel {
  const muzzle = new THREE.Object3D();
  muzzle.position.set(...muzzleAt);
  const flash = new THREE.Mesh((flashGeo ??= new THREE.PlaneGeometry(0.17, 0.17)), flashMaterial());
  flash.visible = false;
  flash.renderOrder = 3;
  muzzle.add(flash);
  gun.add(muzzle);
  const node = new THREE.Group();
  node.add(gun);
  gun.scale.setScalar(VIEW_SCALE[id]);
  parts.gun = gun;
  return { id, node, muzzle, flash, parts };
}

function pistolGun(twoHands: boolean) {
  const gun = new THREE.Group();
  const slide = shape("pistol.slide", [pistolSlide], [0, 0.028, 0]);
  const mag = shape("pistol.mag", [pistolMag], [0, -0.02, 0.02]);
  gun.add(shape(twoHands ? "pistol.body2" : "pistol.body1", twoHands ? [pistolFrame, pistolHand, pistolSupport] : [pistolFrame, pistolHand]), slide, mag);
  return { gun, slide, mag };
}

export function makePistolModel(): WeaponModel {
  const { gun, slide, mag } = pistolGun(true);
  return finish("pistol", gun, [0, 0.028, -0.17], { slide, mag });
}

export function makeRifleModel(): WeaponModel {
  const gun = new THREE.Group();
  const bolt = shape("rifle.bolt", [rifleBolt], [0.025, 0.048, -0.04]);
  const mag = shape("rifle.mag", [rifleMag], [0, -0.05, -0.1]);
  gun.add(shape("rifle.body", [rifleBody, longGunHand, rifleSupport]), bolt, mag);
  return finish("rifle", gun, [0, 0.04, -0.655], { bolt, mag });
}

export function makeShotgunModel(): WeaponModel {
  const gun = new THREE.Group();
  const pump = shape("shotgun.pump", [shotgunPump], PUMP);
  const shell = shape("shotgun.shell", [shotgunShell], SHELL);
  shell.visible = false;
  gun.add(shape("shotgun.body", [shotgunBody, longGunHand]), pump, shell);
  return finish("shotgun", gun, [0, 0.055, -0.66], { pump, shell });
}

/** Riot shield in the left hand, pistol in the right, visible past the shield's edge. */
export function makeShieldModel(): WeaponModel {
  const { gun, slide, mag } = pistolGun(false);
  const shield = shape("shield.body", [shieldBody, shieldHand]);
  const m = finish("shield", gun, [0, 0.028, -0.17], { slide, mag, shield });
  shield.scale.setScalar(VIEW_SCALE.shield);
  m.node.add(shield);
  return m;
}

export function makeWeaponModel(id: WeaponId): WeaponModel {
  return id === "rifle" ? makeRifleModel() : id === "shotgun" ? makeShotgunModel() : id === "shield" ? makeShieldModel() : makePistolModel();
}

// ---------------------------------------------------------------------------------------------
// Animation

export interface WeaponAnimState {
  /** Inputs, set by the game each frame. */
  walk: number; // walk phase, the same value that drives the camera bob
  moving: number; // 0..1
  crouch: number; // 0..1
  lower: number; // 0..1 extra lowering (keypad, dialogue)
  lookX: number; // mouse movement this frame in pixels; consumed (zeroed) by animateWeapon
  lookY: number;
  raised: boolean; // false lowers the weapon for a switch; read `raise` to know when it is down
  reload: number; // -1 when not reloading, else progress 0..1 (per shell for the shotgun)
  empty: boolean; // pistol slide locks back
  shieldUp: boolean;
  /** Aiming down the sights, 0..1 (the game eases it). Puts the sight on the view's centre. */
  ads: number;
  /** Outputs and internal springs. */
  time: number;
  raise: number;
  kick: number;
  shotAge: number;
  shots: number;
  pump: number;
  shield: number;
  shieldJolt: number;
  reloadPose: number;
  swayX: number;
  swayY: number;
  /** Add these to the camera pitch/yaw: per-shot climb that recovers on its own. */
  viewPitch: number;
  viewYaw: number;
}

export function createWeaponState(): WeaponAnimState {
  return {
    walk: 0, moving: 0, crouch: 0, lower: 0, lookX: 0, lookY: 0, raised: true, reload: -1, empty: false, shieldUp: false, ads: 0,
    time: 0, raise: 0, kick: 0, shotAge: 9, shots: 0, pump: 1, shield: 0, shieldJolt: 0, reloadPose: 0, swayX: 0, swayY: 0,
    viewPitch: 0, viewYaw: 0,
  };
}

/** Call once per shot: kicks the model, shows the flash, climbs the view, starts the pump. */
export function addRecoil(s: WeaponAnimState, id: WeaponId): void {
  const st = WEAPONS[id];
  s.kick = Math.min(1.6, s.kick + 1);
  s.shotAge = 0;
  s.shots++;
  s.viewPitch += st.recoilPitch;
  s.viewYaw += st.recoilYaw * Math.sin(s.shots * 12.9898);
  if (st.fireMode === "pump") s.pump = 0;
}

/** Racks the shotgun pump (after the last shell of a reload, say). */
export function rackPump(s: WeaponAnimState): void {
  s.pump = 0;
}

/** The shield took a hit: jolts it back. */
export function hitShield(s: WeaponAnimState, strength = 1): void {
  s.shieldJolt = Math.min(1.5, s.shieldJolt + strength);
}

const HOLD: Record<WeaponId, [number, number, number]> = {
  pistol: [0.19, -0.17, -0.38],
  rifle: [0.17, -0.18, -0.34],
  shotgun: [0.17, -0.18, -0.38],
  shield: [0.22, -0.18, -0.4],
};
const approach = (v: number, to: number, step: number) => (v < to ? Math.min(to, v + step) : Math.max(to, v - step));
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** Poses the model for this frame. Allocation-free; mutates only the state's springs and the model's transforms. */
export function animateWeapon(m: WeaponModel, s: WeaponAnimState, dt: number): void {
  const st = WEAPONS[m.id];
  const p = m.parts;
  s.time += dt;
  s.shotAge += dt;
  s.kick -= s.kick * Math.min(1, dt * 12);
  const rec = Math.min(1, dt * st.recoilRecovery);
  s.viewPitch -= s.viewPitch * rec;
  s.viewYaw -= s.viewYaw * rec;
  if (s.pump < 1) s.pump = st.pumpTime > 0 ? Math.min(1, s.pump + dt / st.pumpTime) : 1;
  s.raise = approach(s.raise, s.raised ? 1 : 0, dt / st.switchTime);
  s.shield = approach(s.shield, s.shieldUp ? 1 : 0, dt * 5);
  s.shieldJolt -= s.shieldJolt * Math.min(1, dt * 10);
  s.reloadPose = approach(s.reloadPose, s.reload >= 0 ? 1 : 0, dt * 6);
  const follow = Math.min(1, dt * 10);
  s.swayX += (clamp(-s.lookX * 0.0005, -0.035, 0.035) - s.swayX) * follow;
  s.swayY += (clamp(s.lookY * 0.0005, -0.035, 0.035) - s.swayY) * follow;
  s.lookX = s.lookY = 0;

  // Whole view model: idle breathing, walk bob, look sway, crouch, raise/lower.
  const mv = s.moving, cr = s.crouch;
  const bobX = Math.sin(s.walk * 5) * 0.012 * mv;
  const bobY = -Math.abs(Math.cos(s.walk * 5)) * 0.01 * mv;
  const breathe = Math.sin(s.time * 1.6) * 0.0025 * (1 - mv);
  const down = 1 - smooth(s.raise);
  const a = smooth(s.ads);
  m.node.position.set(bobX + s.swayX - cr * 0.02, bobY + breathe + s.swayY + cr * 0.01 - down * 0.25 - s.lower * 0.12, 0);
  m.node.rotation.set(-down * 0.8 - s.lower * 0.6 - s.swayY * 1.2, s.swayX * 1.5, cr * 0.07 + s.lower * 0.4 + bobX * 1.5 + Math.sin(s.time * 0.9) * 0.004);
  if (a > 0) {
    // On the sights the bob, sway and crouch tilt go away (the raise/lower for a switch stays).
    m.node.position.x *= 1 - a;
    m.node.position.y = m.node.position.y * (1 - a) - down * 0.25 * a;
    m.node.rotation.x = m.node.rotation.x * (1 - a) - down * 0.8 * a;
    m.node.rotation.y *= 1 - a;
    m.node.rotation.z *= 1 - a;
  }

  // The gun: hold position, recoil, reload tilt.
  const h = HOLD[m.id];
  let gx = h[0], gy = h[1], gz = h[2], rx = 0, rz = 0;
  if (p.shield) {
    const b = smooth(s.shield), j = s.shieldJolt;
    p.shield.position.set(-0.21 + b * 0.18, -0.1 + b * 0.04, -0.5 + b * 0.08 + j * 0.04);
    p.shield.rotation.set(j * 0.06, 0.35 * (1 - b), 0);
    gx += b * 0.03;
    gy -= b * 0.02;
    gz -= b * 0.04;
  }
  if (a > 0 && !p.shield) {
    const at = ADS_AT[m.id];
    gx += (at[0] - gx) * a;
    gy += (at[1] - gy) * a;
    gz += (at[2] - gz) * a;
  }
  const k = 1 - a * 0.55; // a steadier hold on the sights
  gz += s.kick * st.kickBack * k;
  gy += s.kick * 0.008 * k;
  rx += s.kick * st.kickRise * k * (1 - a * 0.5);
  const rp = smooth(s.reloadPose);
  if (st.reloadPerShell) {
    rz -= rp * 0.55;
    rx += rp * 0.22;
    gy += rp * 0.03;
  } else {
    rz += rp * 0.45;
    rx += rp * 0.2;
    gx -= rp * 0.04;
    gy += rp * 0.02;
  }
  const r = s.reload;
  if (p.pump) {
    const q = s.pump < 1 ? Math.sin(Math.PI * s.pump) : 0;
    p.pump.position.z = p.pump.userData.z + q * 0.075;
    rx += q * 0.06;
  }
  m.parts.gun.position.set(gx, gy, gz);
  m.parts.gun.rotation.set(rx, 0, rz);

  // Magazine out and a fresh one in.
  const mag = p.mag;
  if (mag) {
    let off = 0;
    if (r >= 0.15 && r < 0.45) off = smooth((r - 0.15) / 0.3) * 0.3;
    else if (r >= 0.45 && r < 0.75) off = (1 - smooth((r - 0.45) / 0.3)) * 0.22;
    mag.position.y = mag.userData.y - off;
    mag.visible = off < 0.27;
  }
  // Slide or bolt cycles on each shot, locks back when empty, gets released at the end of a reload.
  const sl = p.slide ?? p.bolt;
  if (sl) {
    let back = Math.max(0, 1 - s.shotAge / 0.07);
    if (s.empty && p.slide && r < 0.8) back = 1;
    if (r >= 0.75 && r < 0.92) back = Math.max(back, Math.sin((Math.PI * (r - 0.75)) / 0.17));
    sl.position.z = sl.userData.z + back * (p.slide ? 0.032 : 0.045);
  }
  // Shotgun: a shell comes up from below and is pushed into the loading port.
  const sh = p.shell;
  if (sh) {
    sh.visible = r >= 0 && r < 0.85;
    if (sh.visible) {
      const a = smooth(r / 0.55), push = r > 0.55 ? (r - 0.55) / 0.3 : 0;
      sh.position.set(SHELL[0] + (1 - a) * 0.05, SHELL[1] - (1 - a) * 0.12, SHELL[2] + (1 - a) * 0.06 - push * 0.045);
      sh.rotation.z = (1 - a) * 1.2;
    }
  }
  // Muzzle flash: a quick bloom, rotated differently each shot.
  const f = 1 - s.shotAge / 0.05;
  m.flash.visible = f > 0 && s.shots > 0;
  if (m.flash.visible) {
    m.flash.scale.setScalar((0.6 + 0.5 * f + (s.shots % 3) * 0.15) * (m.id === "shotgun" ? 1.5 : 1));
    m.flash.rotation.z = s.shots * 2.39996;
  }
}

// ---------------------------------------------------------------------------------------------
// World pickups

const PICKUP_COLOR: Record<AmmoType, number> = { pistol: 0x6cc4ff, rifle: ACCENT, shell: 0xff6b57 };

function glowDisc(color: number, size: number) {
  const d = new THREE.Mesh((discGeo ??= new THREE.PlaneGeometry(1, 1)), glowMat(color));
  d.rotation.x = -Math.PI / 2;
  d.scale.setScalar(size);
  d.position.y = 0.005;
  d.renderOrder = 1;
  d.userData.s = size;
  return d;
}

/** A weapon lying on its side over a soft glow; real size, about 4 draw calls. Animate with animatePickup. */
export function makeWeaponPickup(id: WeaponId): THREE.Group {
  const item =
    id === "rifle" ? shape("pickup.rifle", [rifleBody, rifleBolt, rifleMag])
    : id === "shotgun" ? shape("pickup.shotgun", [shotgunBody, (k) => { cz(k, "polymer", 0.022, 0.14, 10, 0, 0.018, -0.3); cz(k, "accent", 0.023, 0.006, 10, 0, 0.018, -0.372); }])
    : id === "shield" ? shape("pickup.shield", [shieldBody])
    : shape("pickup.pistol", [pistolFrame, pistolSlide, pistolMag]);
  const holder = new THREE.Group();
  if (id === "shield") {
    item.rotation.x = -Math.PI / 2;
    item.scale.setScalar(1.4);
  } else {
    item.rotation.z = Math.PI / 2;
    item.scale.setScalar(id === "pistol" ? 1.3 : 1);
  }
  holder.add(item);
  holder.position.y = holder.userData.y = 0.12;
  const node = new THREE.Group();
  node.add(holder, glowDisc(PICKUP_COLOR[WEAPONS[id].ammo], id === "pistol" ? 0.55 : 0.95));
  return node;
}

/** A small ammo crate with a coloured band (blue pistol, amber rifle, red shells); about 4 draw calls. */
export function makeAmmoBox(id: WeaponId): THREE.Group {
  const ammo = WEAPONS[id].ammo;
  const color = PICKUP_COLOR[ammo];
  const box = shape("ammo.box", [(k) => {
    bx(k, "crate", 0.18, 0.09, 0.12, 0, 0.045, 0);
    bx(k, "crate", 0.186, 0.018, 0.126, 0, 0.094, 0);
    bx(k, "metal", 0.06, 0.012, 0.016, 0, 0.108, 0);
    bx(k, "metal", 0.02, 0.03, 0.006, 0.075, 0.07, 0.062);
  }]);
  const band = new THREE.Mesh((ammoBand ??= new THREE.BoxGeometry(0.184, 0.02, 0.124)), stripeMat(color));
  band.position.y = 0.05;
  const holder = new THREE.Group();
  holder.add(box, band);
  holder.position.y = holder.userData.y = 0.02;
  const node = new THREE.Group();
  node.add(holder, glowDisc(color, 0.5));
  return node;
}
let ammoBand: THREE.BoxGeometry | null = null;

/** Gentle bob and spin for a pickup made above; `phase` desynchronises neighbours. */
export function animatePickup(node: THREE.Object3D, time: number, phase = 0): void {
  const holder = node.children[0];
  holder.rotation.y = time * 0.8 + phase;
  holder.position.y = holder.userData.y + Math.sin(time * 2 + phase) * 0.015;
  const disc = node.children[1];
  disc.scale.setScalar(disc.userData.s * (1 + Math.sin(time * 2.4 + phase) * 0.08));
}

// ---------------------------------------------------------------------------------------------

/** Frees every shared geometry, material and texture. Models made earlier must not be rendered afterwards. */
export function disposeWeapons(): void {
  geoCache.forEach((mm) => mm.forEach((g) => g.dispose()));
  geoCache.clear();
  if (mats) for (const k in mats) mats[k as Mat].dispose();
  mats = null;
  flashMat?.dispose();
  flashMat = null;
  tinted.forEach((m) => m.dispose());
  tinted.clear();
  for (const t of textures) t.dispose();
  textures.length = 0;
  glowTex = null;
  flashGeo?.dispose();
  discGeo?.dispose();
  ammoBand?.dispose();
  flashGeo = discGeo = ammoBand = null;
}
