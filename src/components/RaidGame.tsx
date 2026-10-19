import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { toast } from "../store/toasts";
import { createRaidSound } from "./raidSound";
import { RaidLoadingScreen } from "./RaidLoading";
import { CHEAT_WINDOW_MS, GOD_MODE_CODE, cheatMatcher } from "./raidCheat";
import { CIVILIAN_VARIANTS, disposePeople, makeCharacter, poseCharacter, type Character, type CharacterKind, type PoseState } from "./raidPeople";
import {
  WEAPONS,
  WEAPON_IDS,
  addRecoil,
  animatePickup,
  animateWeapon,
  createWeaponState,
  damageAt,
  disposeWeapons,
  fireInterval,
  hitShield,
  makeAmmoBox,
  makeWeaponModel,
  makeWeaponPickup,
  rackPump,
  shieldCovers,
  weaponSpread,
  type AmmoType,
  type WeaponId,
  type WeaponModel,
} from "./raidWeapons";

// A second hidden game on the start screen (started by typing "secret", see TransferBackdrop):
// a first-person raid on a five-floor glass headquarters at night. Every floor has its own look and
// a job to do before its elevator opens; cameras sweep, tripwires cross the corridors, keypad doors
// hide what you need and guards walk their rounds. You start with a pistol and find a rifle, a shotgun
// and a riot shield on the way up; from the executive floor the army joins the guards. On the top floor
// the secrets go up from a rack, the building locks down, and the elevator takes you to the roof, where
// you hold out against the army until the extraction helicopter lands.
// Built on Three.js, loaded with this file only when the word is typed. Everything is made in code:
// no image, no model, no sound file.

const BEST_KEY = "s3x.raidBest";

// One map per floor (40 x 28 cells of 2 m), one character per cell. Built and checked by a script:
// every objective is reachable, every door code can be found before its door, every elevator opens
// onto the floor.
//   #  wall: solid on the outside, a glass partition inside      X  solid interior wall
//   W  window      .  floor      P  the elevator you arrive by (the way to the roof on the top floor)
//   U  the elevator up           d  workstation (adjacent ones form pods)     e  executive desk
//   M  meeting table   Q  reception counter   o  sofa   c  coffee table   j  kitchen counter
//   t  security gate   V  video wall   k  server rack   p  plant
//   G  patrolling guard   H  guard on a post   B  head of security
//   T  terminal (the floor's job)   Y  terminal with a door code   N  sticky note with a door code
//   D  security door with a keypad (the n-th code source, in reading order, opens the n-th door)
//   C  security camera on the wall next to it    =  laser tripwire    F  fuse cabinet
//   K  keycard   R  the rack with the secrets   S  server-room wall   L  keycard door
//   I  intel (optional)   +  medkit    A  ammo locker
//   g  patrolling guard on Normal and Hard only           E  army soldier on patrol
//   J  officer in plates on a post, carrying a shotgun    q  riot officer on a post, carrying the shield
// Weapons are not lying around: they come off the people who carry them (see dropLoot).
// The roof (ROOF_MAP) has its own few: W parapet, X stair or lift housing and the water tank, v air
// conditioning units and vents (low cover), y a stair door the army comes out of, Z where the troop
// helicopter drops its soldiers by rope.
//   O  column   f  filing cabinets   h  shelving   n  printer   b  whiteboard   a  water cooler   z  toilet stall
const FLOORS = [
  [
    "#WWWWWWW#WWW################WWWW#WWWWWW#",
    "W........ff.Xp......U.....pX#f...f#.nn.W",
    "W.T..dd.....X..............X#fT...#....W",
    "W....dd.....D..O........O..X#.....#I..hW",
    "W.......b...X....H.........X#...d.#....W",
    "W##.#####.##X..............X###.####.##W",
    "Wh....#j....XttttttttttttttX#.........aW",
    "#h....#j.Gh.X.............CX#.b..G.....#",
    "Wh..f.#j..h.....XXXXXXXX...............W",
    "W##.#####.##.......H........#####.#####W",
    "W.........a#.p...QQQQQQN..p.#a....jjjjj#",
    "W.ooo.c....#.........g......#......g...#",
    "W..c...+c....O............O....c...c...#",
    "W.ooo......#......p..p...H..#..........#",
    "######.#####C...............#####.######",
    "#....G....p#....p......p...C#.........pW",
    "#p.........#......oooo......#pG........W",
    "###.####.###.O............O.###.####.##W",
    "#.....#.........oo....oo..........#....W",
    "#zz.z.#h.hh#.p............p.#nn..f#hhh.W",
    "W####.########.##########.########.####W",
    "#.......G.......O.......O.......O......#",
    "Wp..................G.................pW",
    "W###.#####.#######.#####.#####.#####.##W",
    "W.....a#....f.#b....f#.....#.....#...+.W",
    "W......#.dd...#......#..g..#.....#.....W",
    "W.P....#.dd...#.nn...#kkkk.#zz.z.#.hhh.W",
    "#####WWW#WWWWWWW#WWWW#############WWWWW#",
  ],
  [
    "#####WWW#WWWWWWW#WWWWW#######WWW#WWWWWW#",
    "W.U...#.........ap#.C#......#b....#jjjjW",
    "W.....#.dd.dd.dd..#..#......#.....#....W",
    "W.....#.dd.dd.dd.....#.MMMM.#.MMM.#.c..W",
    "W##.##............#..#......#.....#....W",
    "#...G............O#..#.....I#.....#...aW",
    "#.dd.dd.dd.dd.dd..#..###.######.####.##W",
    "#.dd.dd.dd.dd.dd..#......G.............#",
    "#.........G...g.b..............H.......W",
    "#.dd.dd.dd.dd.dd.O#..###.#####.#####.##W",
    "#.dd.dd.dd.dd.dd..#..#a....#.....#.....W",
    "#f...............f#..#nn..f#zz.z.#hh.h.W",
    "####.#####.#####.##..####.#####.#####.#W",
    "#....O...................g.O...........#",
    "#...........O.....................O...C#",
    "#XXXXXXX######.####..###.#####.####.####",
    "#kkkkk.X..#.....a.#..#p.........O#.....#",
    "#......X..#.ooo...#..#.dd.dd.dd..#.dd..#",
    "#kkkk..D..#..c....#....dd.dd.dd.......Y#",
    "#......X..#..........#.....G.....#..g..#",
    "#.T....X..=.+....p#..#.dd.dd.dd..#.....W",
    "#....A.X.J###.#####..#.dd.dd.dd......h.#",
    "#XXXXXXX..#.......#..#p.........p#f...hW",
    "W......#..#...G..h#..####.####.#####.##W",
    "W.........#......h...#..c...#...p#.p...W",
    "W......#..........#.........#....#..+..W",
    "Wzz.z..#C.#hhh.nf.#..#jjjj..#ooo.#...P.W",
    "#########WWWWWWW#WWWWWWW#WWWWWWW#WWWWWW#",
  ],
  [
    "########################################",
    "#...kk.#..VVVVVVVVVVVVVVVVVVVV..#....U.#",
    "#......#C.....O..........O......#..hh..#",
    "#F..hh.#.......................f#......#",
    "#.....f....ddddd.dddddd.ddddd...#.....f#",
    "#......#...............................#",
    "###.####.O....................O.#..G...#",
    "#h.....#...ddddd.dddddd.ddddd...#......#",
    "#h.k...#q......................H#......#",
    "#..k.G.#........................#h.....#",
    "#..k...#.O.ddddd.dddddd.ddddd.O.#h....F#",
    "#I.k................N...........#......#",
    "#.....h#......O....G.....O.......hh....#",
    "#......XXXXX.XXXXXXXXXXXXXX.XXXXX......#",
    "#XX.XXXXXXXX=XXXXXXXXXXXXXX.XXXXXXXX.XX#",
    "#......O............a.........O........#",
    "#.........G......O....g...............C#",
    "WXXXX=XXXXXXXXX.XXXXXXXX=XXXXXXXX.XXXXXW",
    "W........X...................X.....hhh.W",
    "Wp.....+.X.kkkkkk..kkkkkkkk..X.+.......W",
    "W...dd...X...................X.........W",
    "#f.......X........G..........X...fff...#",
    "Wf.......=.kkkkkk..kkkkkkkk..D.........W",
    "Wf..g..b.X...................X......A..W",
    "W........X...................X...fff..FW",
    "W......a.X.kkkkkk..kkkkkkkk..X.........W",
    "W.P.ff...X.........C.........X.f.....hhW",
    "#WWWWWWW#WWWWWW########W#WWWWWWW#WWWWWW#",
  ],
  [
    "#WWWWWWW#WW##################WWW#WWWWWW#",
    "Wf.......pXfjjjj....U..#.....Xph.......W",
    "W.........X............#MMMM.X.......I.W",
    "W...e.....XG..O..O...........X....e....W",
    "Wh................H..E.#H....D........hW",
    "Whc.......X............######X......c.hW",
    "W.oo....h.X.###.########.###.X.....ooo.W",
    "#.........X.#p............p#.X.........#",
    "#XXXXXXXXXX.#.......B......#.XXXXXXXXXX#",
    "#C....G.....#..............#.#XXX.XXXXX#",
    "#......jjj.....MMMMMMMMMM....#.h.A.h.h.#",
    "#.....E.....#..............#...h...h.h.#",
    "#.ooo...b...#..............#.#.h...h.h.#",
    "#..c........#p............p#.#...G.....#",
    "#.ooo.......#######.########.######.####",
    "#..........H........G........#.p......C#",
    "#....Ooo.O...dd.dd....dd.dd.....MMMMO..#",
    "#a...........dd.dd.O..dd.dX.X#.......+.#",
    "#.+.............g.....p...X=X#........p#",
    "WXXXXX.XXXX...............X.XXXXX.XXXXXW",
    "W.........X..XXXXXXDXXXXXXX.XX.........W",
    "#...eN....X..Xp..........pX.XX.........#",
    "Wh........X..X............X=XXp...e...hW",
    "Wh........X..X.......QQQ..X.XX........hW",
    "W..c......X..X..Y.........X.XX....E.c..W",
    "W.ooo.....X..X..............XX.....ooo.W",
    "W.......hpX..X.a...P......X.XX.f.......W",
    "#WWWWWWW#WWWW##############WWWWW#WWWWWW#",
  ],
  [
    "####WWWW#WWWWWWW#W#####W#WWWWWWW#WWWWWW#",
    "#P..................C..................W",
    "#.....................................+W",
    "#####.#####..kkkkkk..kkkkkk..kkkkkkkkk.W",
    "#b.......f#.....=......................W",
    "#..dd.dd..#..kkkkkk..kkkkkk..kkkkkkkkk.W",
    "#..dd.dd..#.....=......................W",
    "#...N........kkkkkk..kkkkkk..kkkkkkkkk.#",
    "#.........#.........G.....E............W",
    "#.H..A..I.#..kkkkkk..kkkkkk..kkkkkkkkk.W",
    "#.........#.....................=......W",
    "####.######..kkkkkk..kkkkkk..kkkkkkkkk.W",
    "#XXXXXXXXXXp...........................W",
    "#f........X..kkkkkk..kkkkkk..kkkkkkkkk.W",
    "#f...dd...X.................G..........#",
    "#.........X.a.......#.O......H......O..W",
    "#..K......D........p#...SSSSSLSSSSS....W",
    "#.....g...X.h..O........S.........S..O.#",
    "#.........XCh.......#...S.kkk.kkk.S....#",
    "#.......h.X.h..G....#...S.........S....#",
    "#XXXXXXXXXX.....fff.#...S....R....S.O.C#",
    "#ffff..G..#..ff.....#.O.S.........S....#",
    "#..............O........S.kkk.kkk.S..E.#",
    "#####.##.##.+.......#...S.........S..O.#",
    "#.....#...#...E..h..#.H.SSSSSSSSSSS....W",
    "#.....#...#......h..#.........E.....G..W",
    "#zz.z.#.hh#hhh....n.#..................W",
    "#WWWWWWW#WWWWWWW#WWWWWWW#WWWWWWW#WWWWWW#",
  ],
];
const ROOF_MAP = [
  "WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW",
  "W..............XXXX....................W",
  "W..............XXXX..............XXX...W",
  "W..............XXXX...........+..XXX...W",
  "W......vv.......y................XXX...W",
  "W.......+..............................W",
  "W...v....................vv............W",
  "W...+..........................+.......W",
  "W................v............v........W",
  "W...........v+......................vv.W",
  "W...........v.............vv...........W",
  "WXXX...................................W",
  "WXXX................+..................W",
  "WXP.....v...........v..................W",
  "WXXX....v...........v...............Z..W",
  "WXXX...........vv......................W",
  "W...............+......................W",
  "W...........v..........................W",
  "W...........v.............vv...........W",
  "W.........................+.........vv.W",
  "W...v............v.....................W",
  "W...+..................................W",
  "W......vv................vv............W",
  "W.....................y...+............W",
  "W....................XXXX......v.......W",
  "W....................XXXX..............W",
  "W....................XXXX..............W",
  "WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW",
];
/** Cells around the helipad's centre on the roof. */
const PAD = { x: 29.5, y: 14.5 };
const MAP_W = 40;
const MAP_H = 28;
const LAST = FLOORS.length - 1;

type FloorKind = "stone" | "carpet" | "dark" | "wood" | "raised";
type SolidKind = "marble" | "panel" | "concrete" | "stone" | "metal";
/** What makes each floor recognisable: height, light, materials. */
interface Theme {
  name: string;
  h: number; // ceiling height in metres
  lamp: number;
  lampPower: number;
  sky: number;
  ground: number;
  hemi: number;
  exposure: number;
  fog: number;
  fogNear: number;
  fogFar: number;
  wall: [string, string, string]; // panel, seam, accent line
  solid: SolidKind;
  floor: FloorKind;
  ceiling: number;
  strip: number;
  stripPower: number;
  frame: number; // partition posts and rails
  desk: number;
  table: number;
  tile: number; // the dropped ceiling over corridors and small rooms
}
const THEMES: Theme[] = [
  { name: "Lobby", h: 6, lamp: 0xffd2a0, lampPower: 46, sky: 0xffe2c4, ground: 0x2a2016, hemi: 0.55, exposure: 1.1, fog: 0x0b0a10, fogNear: 34, fogFar: 170, wall: ["#ebe5da", "#d6cdbd", "#c99a55"], solid: "marble", floor: "stone", ceiling: 0x2b2620, strip: 0xffe9cc, stripPower: 1.3, frame: 0xb59160, desk: 0xf2efe8, table: 0xf2efe8, tile: 0xe8e2d6 },
  { name: "Open office", h: 3.2, lamp: 0xeaf2ff, lampPower: 24, sky: 0xdfe9ff, ground: 0x1c2028, hemi: 0.5, exposure: 1.05, fog: 0x080b14, fogNear: 26, fogFar: 150, wall: ["#e6e9ee", "#cdd2da", "#4fd6aa"], solid: "panel", floor: "carpet", ceiling: 0x1d2026, strip: 0xf0f6ff, stripPower: 1.3, frame: 0xaab0bb, desk: 0xf4f4f2, table: 0xf4f4f2, tile: 0xdfe2e6 },
  { name: "Operations", h: 3.6, lamp: 0x6f8cff, lampPower: 14, sky: 0x4a5f9a, ground: 0x0a0c14, hemi: 0.32, exposure: 1.0, fog: 0x05070f, fogNear: 18, fogFar: 110, wall: ["#262c39", "#1b202b", "#3fa0ff"], solid: "concrete", floor: "dark", ceiling: 0x0c0e14, strip: 0x7aa2ff, stripPower: 0.6, frame: 0x2f3746, desk: 0x2c313c, table: 0x2c313c, tile: 0x1a1e27 },
  { name: "Executive floor", h: 3.2, lamp: 0xffc48a, lampPower: 22, sky: 0xffd2a8, ground: 0x1a1210, hemi: 0.38, exposure: 1.0, fog: 0x0a0808, fogNear: 24, fogFar: 140, wall: ["#3b3633", "#2d2926", "#c9a46a"], solid: "stone", floor: "wood", ceiling: 0x15110e, strip: 0xffd9a8, stripPower: 0.8, frame: 0x6b5233, desk: 0x6b4a2f, table: 0x5a3d26, tile: 0x2a211b },
  { name: "Server floor", h: 3.0, lamp: 0xbfe6ff, lampPower: 16, sky: 0x9fd0ff, ground: 0x0a1018, hemi: 0.36, exposure: 1.0, fog: 0x0b1622, fogNear: 5, fogFar: 46, wall: ["#2a323c", "#20262e", "#4fd6ff"], solid: "metal", floor: "raised", ceiling: 0x1c232c, strip: 0xd8f0ff, stripPower: 1.0, frame: 0x3d4652, desk: 0x2c313c, table: 0x2c313c, tile: 0x2a3038 },
];
const ROOF_THEME: Theme = { ...THEMES[LAST], name: "Roof", h: 3.2 };

// armour: how many of the officers wear plates (times the floor's share); extra: the "g" guards come;
// burst: rounds in a soldier's burst; hold: seconds on the roof before the helicopter lands.
const DIFFICULTIES = [
  { name: "Easy", health: 150, accuracy: 0.6, damage: 0.45, score: 0.8, armour: 0.5, extra: false, burst: 2, hold: 75 },
  { name: "Normal", health: 100, accuracy: 0.95, damage: 0.7, score: 1, armour: 1, extra: true, burst: 3, hold: 90 },
  { name: "Hard", health: 80, accuracy: 1.2, damage: 1, score: 1.3, armour: 1.3, extra: true, burst: 3, hold: 100 },
];
/** Share of the officers on each floor who wear plates (Normal). */
const ARMOUR_SHARE = [0, 0.2, 0.3, 0.4, 0.5];

/** The people who shoot back. armour multiplies a hit on the plates, head scales a head hit (a helmet). */
type EnemyType = "officer" | "armored" | "soldier" | "boss";
interface EnemyStats {
  health: number;
  armour: number;
  head: number;
  aim: number;
  mag: number;
  burst: number; // rounds per trigger pull (soldiers: the difficulty's burst)
  gap: number; // seconds between rounds in a burst
  every: [number, number]; // seconds between trigger pulls
  damage: [number, number]; // per round that hits
  reload: number;
  speed: number; // cells per second
  flank: number; // chance of being the one who goes round
}
const ENEMY: Record<EnemyType, EnemyStats> = {
  officer: { health: 100, armour: 1, head: 1, aim: 1, mag: 12, burst: 1, gap: 0, every: [0.9, 1.6], damage: [6, 11], reload: 1.8, speed: 1.3, flank: 0.25 },
  armored: { health: 110, armour: 0.55, head: 1, aim: 1.05, mag: 12, burst: 1, gap: 0, every: [0.85, 1.5], damage: [6, 11], reload: 2, speed: 1.2, flank: 0.25 },
  soldier: { health: 150, armour: 0.5, head: 0.7, aim: 1.15, mag: 30, burst: 3, gap: 0.09, every: [0.8, 1.3], damage: [5, 9], reload: 2.2, speed: 1.45, flank: 0.5 },
  boss: { health: 560, armour: 0.55, head: 0.8, aim: 1.2, mag: 40, burst: 5, gap: 0.08, every: [0.7, 1.1], damage: [7, 12], reload: 2.4, speed: 1.5, flank: 0.5 },
};

/** The handler on the radio. */
const INTRO = [
  "You're in the garage lift. Comms check... I hear you.",
  "Five floors. The secrets sit on one rack in the server room, top floor.",
  "Every floor locks its elevator behind something. Break it and ride up.",
  "Cameras sweep, tripwires cross the corridors, guards walk their rounds. Quiet is faster.",
];
const ARRIVE = [
  "Lobby. Hack both security terminals to drop the cameras and open the gates, or find the staff door code.",
  "Open office. The access codes are in the server closet. Its door code is on the IT terminal.",
  "Operations. Three fuses feed the laser grid on the lift. Tripwires in the corridors: jump them.",
  "Executive floor. The head of security carries the badge for the lift. He won't go quietly.",
  "Server floor. The keycard is in the security office; its code is somewhere in the NOC. Then the rack.",
];
/** A line that starts with this is the head of security on the guards' channel, not your handler. */
const KESSLER = "KESSLER: ";

/** World units (metres) per map cell. */
const U = 2;
const EYE = 1.65;
const CAR_H = 2.9; // the elevator car's ceiling
const DROP_H = 2.9; // dropped ceilings over corridors and small rooms (light panels sit flush in them)

const WALK = 3.0; // cells per second
const SPRINT = 1.6;
const TURN_SPEED = 2.2; // radians per second (arrow keys)
const MOUSE_TURN = 0.0022;
const PITCH_LIMIT = 1.2;
const PLAYER_RADIUS = 0.22; // cells
const JUMP_SPEED = 3.33; // m/s: about 0.5 m high and 0.6 s in the air
const GRAVITY = 11.1;
const WIRE_HEIGHT = 0.3; // a tripwire's height; your feet must be above it
const FLOOR_HEAL = 25;
const MEDKIT_HEAL = 35;
const CHECKPOINT_HEALTH = 70;
const MAX_DEATHS = 3;
const CROUCH_DROP = 0.62; // metres the eye comes down
const CROUCH_SPEED = 0.5;
/** What you can duck behind: bullets at standing height pass over you. */
const LOW_COVER = "deMQojtcfnv";
const PATROL_SPEED = 0.75;
const GUARD_SEES = 10;
const GUARD_KEEPS = 3;
const ALERT_RADIUS = 6;
const HEARS_SHOT = 8;
const CHASE_SECONDS = 8;
const GRACE_SECONDS = 1.6;
const AI_FAR = 22; // calm guards further than this think four times a second
const CAM_RANGE = 6; // cells
const CAM_FOV = 0.36; // half-angle, radians
const CAM_NOTICE = 0.5; // seconds in view before the alarm
const REACH = 0.7;
const USE_REACH = 1.15;
const HOLD_SECONDS = 1.5;
const READ_SECONDS = 1.0;
const DOWNLOAD_SECONDS = 14;
const BACKUP_SECONDS = 32;
const UPLOAD_SECONDS = 8;
const STAY_RANGE = 2.5;
const REINFORCE_EVERY = 3.5;
const REINFORCE_MAX = 3;
const CALL_SECONDS = 6; // the elevator takes this long to come when the alarm is up
const FINALE_SECONDS = 60;
const FINALE_WAVES = [2, 18, 34];
const WAVE_SIZE = 3;
const FLASH_FUSE = 1.4;
const MAX_DROPS = 14;
const PARTITION = 0.05;
const DOOR_SECONDS = 0.6;
const RIDE_SECONDS = 2.2;
const ROOF_STAIR_WAVES = [5, 19, 33, 50, 64, 79];
const ROOF_ALIVE = 8;
const HEADSHOT_SECONDS = 0.7;
const MAX_PIXEL_RATIO = 1.25;
/** Point lights that follow you between the floor's light positions; a fixed number keeps every shader the same. */
const LIGHT_POOL = 4;

const ACCENT = 0xffb81f;
const CORAL = 0xff6b57;
const MINT = 0x4fd6aa;
const GOLD = 0xffc94a;
const ALARM = 0xff3324;
const NIGHT = 0x070912;

const SOLID_CH = "#XWSVdeMQojkpTYFRcPUOfhnbazv";
const WALLISH = "#XWSV";

type Spot = { x: number; y: number };
interface Guard {
  kind: "patrol" | "post" | "boss" | "hunter";
  type: EnemyType;
  stats: EnemyStats;
  x: number;
  y: number;
  /** Height above the floor (a soldier on a rope). */
  z: number;
  ch: Character;
  ps: PoseState;
  node: THREE.Object3D;
  health: number;
  maxHealth: number;
  mag: number;
  burstLeft: number;
  burstT: number;
  reloading: number;
  role: "push" | "flank";
  flankFor: number;
  lastX: number;
  lastY: number;
  lastSeen: number; // seconds since he last saw you
  flashT: number;
  rope: number; // > 0 sliding down from the troop helicopter
  stage: number; // the boss: 0, 1 after the flashbang, 2 after the squad
  seenOnce: boolean;
  crouch: number; // seconds left ducked behind low cover
  /** The weapon he drops when he falls, if you do not have it yet. */
  carries: WeaponId | null;
  /** A riot officer's shield on his arm: it stops rounds. */
  shield: THREE.Mesh | null;
  alert: boolean;
  sees: boolean;
  suspicion: number;
  chase: number;
  heading: number;
  postAngle: number;
  look: number;
  route: number[];
  routeAt: number;
  path: number[];
  wait: number;
  cover: Spot | null;
  coverFor: number;
  stagger: number;
  reload: number;
  hurt: number;
  dying: number; // 0 alive, > 0 falling, -1 down
  walk: number;
  strafe: number;
  strafeFor: number;
  skip: number;
}
/** Office staff: they ignore you until shooting or an alarm, then run and cower. */
interface Civ extends Spot {
  ch: Character;
  ps: PoseState;
  node: THREE.Object3D;
  sit: boolean;
  act: "type" | "sip" | "talk" | "work";
  yaw: number;
  t: number;
  state: "calm" | "flee" | "cower" | "down";
  fleeFor: number;
  witness: number; // > 0: saw you shoot and is deciding to call security; -1 done
  dying: number;
}
/** A place a light shines from; the nearest few get one of the pooled point lights. */
interface LightSpot {
  pos: THREE.Vector3;
  color: THREE.Color;
  base: number;
  intensity: number;
  distance: number;
  decay: number;
  lamp: boolean; // a ceiling lamp (turns red in the lockdown)
}
interface Station extends Spot {
  kind: "T" | "F" | "Y";
  done: boolean;
  door: number; // for Y: the door whose code it shows
  screen: THREE.Mesh | null;
  lamp: THREE.Mesh | null;
}
interface Note extends Spot {
  door: number;
  read: boolean;
}
interface Door extends Spot {
  cell: number;
  code: string;
  known: boolean;
  open: boolean;
  t: number;
  leaves: THREE.Mesh[];
  lamp: THREE.MeshBasicMaterial;
  wrong: number;
}
interface Cam {
  mx: number; // the mount on the wall, in cells
  my: number;
  sx: number; // where it looks from, just off the wall
  sy: number;
  base: number;
  yaw: number;
  amp: number;
  speed: number;
  phase: number;
  t: number;
  head: THREE.Group;
  cone: THREE.Mesh;
  led: THREE.Mesh;
  seen: number;
  sees: boolean;
  dead: boolean;
}
interface Wire extends Spot {
  alongX: boolean;
  beam: THREE.Mesh;
  flash: number;
}
interface Car extends Spot {
  cell: number;
  dir: [number, number];
  up: boolean;
  roof: boolean;
  node: THREE.Group;
  doors: THREE.Mesh[];
  open: number;
  arrow: THREE.MeshBasicMaterial;
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  shown: string;
  call: number;
  walls: number[];
  closed: number[];
}
type PickupKind = "medkit" | "intel" | "ammo" | "locker" | "rifle" | "shotgun" | "shield";
interface Pickup {
  kind: PickupKind;
  at: Spot;
  node: THREE.Object3D;
  taken: boolean;
  spot: LightSpot | null;
  ammo: AmmoType | null;
  lift: number; // medkits and intel float this high; the rest sit on the floor or their crate
  phase: number;
}
interface Run {
  at: Spot;
  t: number;
  total: number;
  spawned: number;
  spawnClock: number;
  label: string;
  finish(): void;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const smooth = (t: number) => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};
const hash = (x: number, y: number) => ((x * 73856093) ^ (y * 19349663)) >>> 0;
const N4: [number, number][] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];
// An elevator car's walls in its own cell frame (u across, v from the back wall to the doors at v = 1).
const CAR_WALLS = [0, 0, 1, 0.05, 0, 0, 0.05, 1, 0.95, 0, 1, 1, 0, 0.95, 0.225, 1, 0.775, 0.95, 1, 1];
const CAR_DOOR = [0.225, 0.93, 0.775, 0.97];

// ---- textures, drawn once per game (and the floor's own ones per floor) ----
/** While set, textures are drawn later, a few per frame, so loading never freezes the page. */
let textureQueue: (() => void)[] | null = null;
function canvasTexture(w: number, h: number, draw: (c: CanvasRenderingContext2D, w: number, h: number) => void, srgb = true): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const t = new THREE.CanvasTexture(canvas);
  if (textureQueue)
    textureQueue.push(() => {
      draw(canvas.getContext("2d")!, w, h);
      t.needsUpdate = true;
    });
  else draw(canvas.getContext("2d")!, w, h);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
function speckle(c: CanvasRenderingContext2D, w: number, h: number, colors: string[], alpha: number, count: number, size = 2) {
  for (let i = 0; i < count; i++) {
    c.fillStyle = colors[i % colors.length];
    c.globalAlpha = alpha * Math.random();
    c.fillRect(Math.random() * w, Math.random() * h, size, size);
  }
  c.globalAlpha = 1;
}
function veins(c: CanvasRenderingContext2D, w: number, h: number, color: string, count: number) {
  c.strokeStyle = color;
  c.lineWidth = 1.2;
  for (let i = 0; i < count; i++) {
    c.globalAlpha = rand(0.15, 0.4);
    c.beginPath();
    let x = Math.random() * w;
    let y = Math.random() * h;
    c.moveTo(x, y);
    for (let k = 0; k < 6; k++) {
      x += rand(-40, 40);
      y += rand(10, 50);
      c.lineTo(x, y);
    }
    c.stroke();
  }
  c.globalAlpha = 1;
}
function drawFloor(kind: FloorKind) {
  return (c: CanvasRenderingContext2D, w: number, h: number) => {
    if (kind === "stone") {
      c.fillStyle = "#cdbfa8";
      c.fillRect(0, 0, w, h);
      veins(c, w, h, "#f4ecdc", 6);
      veins(c, w, h, "#a99a82", 3);
      c.fillStyle = "#b0a28a";
      for (const p of [0, 128]) {
        c.fillRect(0, p, w, 2);
        c.fillRect(p, 0, 2, h);
      }
    } else if (kind === "carpet") {
      c.fillStyle = "#596070";
      c.fillRect(0, 0, w, h);
      speckle(c, w, h, ["#6a7182", "#4a505d", "#7a8192"], 0.6, 900, 3);
      c.fillStyle = "#4b515e";
      for (const p of [0, 128]) {
        c.fillRect(0, p, w, 1);
        c.fillRect(p, 0, 1, h);
      }
    } else if (kind === "dark") {
      c.fillStyle = "#151920";
      c.fillRect(0, 0, w, h);
      speckle(c, w, h, ["#1c212a", "#10131a"], 0.7, 900, 3);
      c.fillStyle = "#0a0c10";
      for (const p of [0, 128]) {
        c.fillRect(0, p, w, 2);
        c.fillRect(p, 0, 2, h);
      }
      c.fillStyle = "#1d3a6b";
      c.fillRect(0, 64, w, 1);
    } else if (kind === "wood") {
      for (let y = 0; y < h; y += 32) {
        const tone = rand(-12, 12);
        c.fillStyle = `rgb(${110 + tone}, ${74 + tone * 0.7}, ${46 + tone * 0.5})`;
        c.fillRect(0, y, w, 32);
        c.strokeStyle = "rgba(40, 24, 12, 0.25)";
        c.lineWidth = 1;
        for (let k = 0; k < 4; k++) {
          c.beginPath();
          c.moveTo(0, y + rand(4, 28));
          c.bezierCurveTo(w * 0.3, y + rand(4, 28), w * 0.6, y + rand(4, 28), w, y + rand(4, 28));
          c.stroke();
        }
        c.fillStyle = "#2d1d12";
        c.fillRect(0, y, w, 1.5);
        c.fillRect((y * 37) % w, y, 1.5, 32);
      }
    } else {
      c.fillStyle = "#3b414a";
      c.fillRect(0, 0, w, h);
      c.fillStyle = "#2b3037";
      for (const [ox, oy] of [[0, 0], [128, 0], [0, 128], [128, 128]]) {
        for (let y = 20; y < 108; y += 9) for (let x = 20; x < 108; x += 9) c.fillRect(ox + x, oy + y, 3, 3);
      }
      c.fillStyle = "#22262c";
      for (const p of [0, 128]) {
        c.fillRect(0, p, w, 3);
        c.fillRect(p, 0, 3, h);
      }
    }
  };
}
function drawWall([panel, seam, accent]: [string, string, string]) {
  return (c: CanvasRenderingContext2D) => {
    c.fillStyle = panel;
    c.fillRect(0, 0, 256, 256);
    c.fillStyle = seam;
    c.fillRect(0, 0, 2, 256);
    c.fillRect(127, 0, 2, 256);
    c.fillRect(0, 214, 256, 42);
    c.fillStyle = accent;
    c.fillRect(0, 212, 256, 2);
  };
}
function drawSolid(kind: SolidKind, wall: [string, string, string]) {
  return (c: CanvasRenderingContext2D, w: number, h: number) => {
    if (kind === "marble") {
      c.fillStyle = "#e9e3d8";
      c.fillRect(0, 0, w, h);
      veins(c, w, h, "#b9ad9b", 7);
      veins(c, w, h, "#d8ccb6", 5);
      c.fillStyle = "#d3c9b8";
      c.fillRect(0, 0, w, 1);
      c.fillRect(0, 0, 1, h);
    } else if (kind === "panel") drawWall(wall)(c);
    else if (kind === "concrete") {
      c.fillStyle = "#2a2f37";
      c.fillRect(0, 0, w, h);
      speckle(c, w, h, ["#353b45", "#20242b"], 0.8, 1800, 3);
      c.fillStyle = "#1b1f25";
      for (const y of [0, 85, 170]) c.fillRect(0, y, w, 2);
      c.fillStyle = "#3fa0ff";
      c.fillRect(0, 230, w, 2);
    } else if (kind === "stone") {
      c.fillStyle = "#2f2b29";
      c.fillRect(0, 0, w, h);
      veins(c, w, h, "#4e4743", 8);
      veins(c, w, h, "#1d1a19", 4);
      c.fillStyle = "#c9a46a";
      c.fillRect(0, 222, w, 2);
    } else {
      c.fillStyle = "#28303a";
      c.fillRect(0, 0, w, h);
      for (let x = 0; x < w; x += 32) {
        c.fillStyle = "#323b47";
        c.fillRect(x, 0, 14, h);
        c.fillStyle = "#1e242c";
        c.fillRect(x + 14, 0, 2, h);
      }
    }
  };
}
function drawCeiling(index: number) {
  return (c: CanvasRenderingContext2D) => {
    c.fillStyle = "#000";
    c.fillRect(0, 0, 256, 256);
    c.fillStyle = "#fff";
    if (index === 0) {
      for (const x of [40, 152]) for (const y of [40, 152]) c.fillRect(x, y, 64, 64);
    } else if (index === 1) c.fillRect(24, 120, 208, 16);
    else if (index === 2) c.fillRect(0, 124, 256, 6);
    else if (index === 3) {
      for (const [x, y] of [[64, 64], [192, 192]]) {
        c.beginPath();
        c.arc(x, y, 14, 0, Math.PI * 2);
        c.fill();
      }
    } else {
      c.fillRect(0, 60, 256, 6);
      c.fillRect(0, 190, 256, 6);
    }
  };
}
/** An analytics dashboard: KPI tiles, a line chart, a bar chart. Drawn at any width. */
function drawDashboard(c: CanvasRenderingContext2D, w: number, h: number) {
  const s = w / 256;
  c.fillStyle = "#0a0f1e";
  c.fillRect(0, 0, w, h);
  c.fillStyle = "#131b31";
  c.fillRect(0, 0, w, 14 * s);
  c.fillStyle = "#ffb81f";
  c.fillRect(6 * s, 4 * s, 6 * s, 6 * s);
  c.fillStyle = "#3a4562";
  c.fillRect(16 * s, 5.5 * s, 42 * s, 3 * s);
  ["#4fd6aa", "#ffb81f", "#6cc4ff"].forEach((color, i) => {
    const x = (6 + i * 58) * s;
    c.fillStyle = "#121a2f";
    c.fillRect(x, 20 * s, 52 * s, 30 * s);
    c.fillStyle = "#3a4562";
    c.fillRect(x + 5 * s, 25 * s, 22 * s, 3 * s);
    c.fillStyle = color;
    c.fillRect(x + 5 * s, 33 * s, rand(18, 40) * s, 10 * s);
  });
  const top = 56 * s;
  const bottom = h - 6 * s;
  const left = 6 * s;
  const right = 176 * s;
  c.fillStyle = "#0f172b";
  c.fillRect(left, top, right - left, bottom - top);
  c.fillStyle = "#1b2542";
  for (let y = top + 10 * s; y < bottom; y += 14 * s) c.fillRect(left, y, right - left, Math.max(1, s));
  const pts: [number, number][] = [];
  let v = 0.5;
  for (let x = left + 4 * s; x <= right - 4 * s; x += 8 * s) {
    v = Math.min(0.9, Math.max(0.1, v + rand(-0.18, 0.18)));
    pts.push([x, bottom - 6 * s - v * (bottom - top - 16 * s)]);
  }
  c.beginPath();
  c.moveTo(pts[0][0], bottom);
  for (const [x, y] of pts) c.lineTo(x, y);
  c.lineTo(pts[pts.length - 1][0], bottom);
  c.closePath();
  c.fillStyle = "rgba(79, 214, 170, 0.18)";
  c.fill();
  c.beginPath();
  pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
  c.strokeStyle = "#4fd6aa";
  c.lineWidth = 2 * s;
  c.stroke();
  const bx = 182 * s;
  c.fillStyle = "#0f172b";
  c.fillRect(bx, 20 * s, w - bx - 6 * s, bottom - 20 * s);
  for (let i = 0; i < 6; i++) {
    const bh = rand(0.2, 0.9) * (bottom - 34 * s);
    c.fillStyle = i % 2 ? "#ffb81f" : "#6cc4ff";
    c.fillRect(bx + (6 + i * 10) * s, bottom - 6 * s - bh, 6 * s, bh);
  }
}
/** An editor full of code. */
function drawCode(c: CanvasRenderingContext2D, w: number, h: number) {
  const s = w / 256;
  c.fillStyle = "#0d1117";
  c.fillRect(0, 0, w, h);
  c.fillStyle = "#161b22";
  c.fillRect(0, 0, w, 12 * s);
  c.fillStyle = "#0d1117";
  c.fillRect(4 * s, 2 * s, 50 * s, 10 * s);
  c.fillStyle = "#ffb81f";
  c.fillRect(4 * s, 10.5 * s, 50 * s, 1.5 * s);
  const palette = ["#ff7b72", "#79c0ff", "#d2a8ff", "#a5d6ff", "#8b949e", "#ffa657", "#7ee787"];
  let indent = 0;
  for (let y = 18 * s; y < h - 6 * s; y += 8 * s) {
    c.fillStyle = "#30363d";
    c.fillRect(4 * s, y, 8 * s, 3 * s);
    indent = Math.max(0, Math.min(4, indent + (Math.random() < 0.3 ? 1 : Math.random() < 0.35 ? -1 : 0)));
    let x = (20 + indent * 10) * s;
    const n = 1 + Math.floor(Math.random() * 4);
    for (let k = 0; k < n && x < w - 10 * s; k++) {
      const len = rand(8, 38) * s;
      c.fillStyle = palette[Math.floor(Math.random() * palette.length)];
      c.fillRect(x, y, len, 3 * s);
      x += len + 4 * s;
    }
  }
}
/** The security desk: four camera feeds. */
function drawSecurity(c: CanvasRenderingContext2D, w: number, h: number) {
  const s = w / 256;
  c.fillStyle = "#0a0d14";
  c.fillRect(0, 0, w, h);
  c.fillStyle = "#2a1013";
  c.fillRect(0, 0, w, 14 * s);
  c.fillStyle = "#ff6b57";
  c.fillRect(0, 13 * s, w, 1.5 * s);
  c.beginPath();
  c.arc(9 * s, 7 * s, 3 * s, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = "#f2f2f3";
  c.font = `600 ${8 * s}px sans-serif`;
  c.textBaseline = "middle";
  c.fillText("SECURITY · LIVE", 16 * s, 7.5 * s);
  const gw = (w - 18 * s) / 2;
  const gh = (h - 26 * s) / 2;
  for (let i = 0; i < 4; i++) {
    const x = 6 * s + (i % 2) * (gw + 6 * s);
    const y = 20 * s + Math.floor(i / 2) * (gh + 6 * s);
    const g = c.createLinearGradient(0, y, 0, y + gh);
    g.addColorStop(0, "#1c2533");
    g.addColorStop(1, "#0e131c");
    c.fillStyle = g;
    c.fillRect(x, y, gw, gh);
    c.fillStyle = "#2a3446";
    c.fillRect(x + rand(0.15, 0.6) * gw, y + gh * 0.45, gw * 0.25, gh * 0.55);
    c.fillStyle = "#c9d3e0";
    c.font = `600 ${6 * s}px monospace`;
    c.fillText(`CAM 0${i + 1}`, x + 4 * s, y + 7 * s);
    c.fillStyle = "#ff6b57";
    c.fillRect(x + gw - 8 * s, y + 4 * s, 4 * s, 4 * s);
  }
}
/** The operations map: a dotted world with routes. */
function drawOpsMap(c: CanvasRenderingContext2D, w: number, h: number) {
  c.fillStyle = "#06101f";
  c.fillRect(0, 0, w, h);
  c.fillStyle = "#0e2240";
  for (let x = 0; x < w; x += w / 16) c.fillRect(x, 0, 1, h);
  for (let y = 0; y < h; y += h / 9) c.fillRect(0, y, w, 1);
  const blobs = [[0.22, 0.35, 0.12, 0.2], [0.3, 0.7, 0.07, 0.18], [0.5, 0.32, 0.08, 0.13], [0.53, 0.62, 0.08, 0.2], [0.72, 0.35, 0.16, 0.2], [0.82, 0.72, 0.07, 0.1]];
  c.fillStyle = "#3fa0ff";
  for (let y = 4; y < h; y += 7) {
    for (let x = 4; x < w; x += 7) {
      if (blobs.some(([bx, by, rx, ry]) => ((x / w - bx) / rx) ** 2 + ((y / h - by) / ry) ** 2 < 1)) c.fillRect(x, y, 3, 3);
    }
  }
  c.strokeStyle = "#ffb81f";
  c.lineWidth = 2;
  for (let i = 0; i < 5; i++) {
    const [ax, ay] = blobs[i];
    const [bx, by] = blobs[(i + 2) % blobs.length];
    c.beginPath();
    c.moveTo(ax * w, ay * h);
    c.quadraticCurveTo(((ax + bx) / 2) * w, Math.min(ay, by) * h - 40, bx * w, by * h);
    c.stroke();
  }
  c.fillStyle = "#ff6b57";
  for (const [x, y] of blobs) {
    c.beginPath();
    c.arc(x * w, y * h, 5, 0, Math.PI * 2);
    c.fill();
  }
}
/** A terminal's screen. */
function drawKiosk(c: CanvasRenderingContext2D, w: number, h: number, title: string, status: string, color: string, done: boolean) {
  const s = w / 192;
  c.fillStyle = done ? "#06231c" : "#0b1020";
  c.fillRect(0, 0, w, h);
  c.fillStyle = color;
  c.fillRect(0, 0, w, 6 * s);
  c.fillStyle = "#c9d3e0";
  c.font = `700 ${12 * s}px sans-serif`;
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText(title, w / 2, 22 * s);
  c.strokeStyle = color;
  c.lineWidth = 4 * s;
  c.beginPath();
  c.arc(w / 2, 52 * s, 10 * s, Math.PI, done ? Math.PI * 1.7 : Math.PI * 2);
  c.stroke();
  c.fillStyle = color;
  c.fillRect(w / 2 - 15 * s, 52 * s, 30 * s, 22 * s);
  c.font = `800 ${14 * s}px sans-serif`;
  c.fillText(status, w / 2, 94 * s);
  c.fillStyle = "#2a3446";
  c.fillRect(20 * s, 110 * s, w - 40 * s, 4 * s);
  c.fillStyle = color;
  c.fillRect(20 * s, 110 * s, done ? w - 40 * s : 30 * s, 4 * s);
}
function makeTextures(queue: (() => void)[]) {
  textureQueue = queue;
  const server = canvasTexture(128, 256, (c) => {
    c.fillStyle = "#0e1016";
    c.fillRect(0, 0, 128, 256);
    for (let i = 0; i < 14; i++) {
      c.fillStyle = "#171a22";
      c.fillRect(10, 8 + i * 17, 108, 13);
      for (let j = 0; j < 6; j++) {
        c.fillStyle = Math.random() < 0.15 ? "#ff6b57" : Math.random() < 0.6 ? "#4fd6aa" : "#ffb81f";
        if (Math.random() < 0.8) c.fillRect(84 + j * 5, 13 + i * 17, 3, 3);
      }
    }
  });
  const rack = canvasTexture(128, 256, (c) => {
    c.fillStyle = "#0b0c11";
    c.fillRect(0, 0, 128, 256);
    for (let i = 0; i < 11; i++) {
      c.fillStyle = "#191c25";
      c.fillRect(8, 8 + i * 21, 112, 16);
      for (let j = 0; j < 8; j++) {
        c.fillStyle = j % 3 ? "#ffb81f" : "#4fd6aa";
        c.fillRect(70 + j * 6, 14 + i * 21, 3, 3);
      }
    }
    c.fillStyle = "#ffb81f";
    c.font = "bold 18px sans-serif";
    c.textAlign = "center";
    c.fillText("SECRETS", 64, 246);
  });
  // Server racks in rows: cyan and red status lights, vents.
  const rackRow = canvasTexture(128, 256, (c) => {
    c.fillStyle = "#0c0f14";
    c.fillRect(0, 0, 128, 256);
    for (let i = 0; i < 16; i++) {
      c.fillStyle = i % 4 === 0 ? "#141922" : "#181d27";
      c.fillRect(6, 6 + i * 15.5, 116, 12);
      c.fillStyle = "#0a0c10";
      for (let k = 0; k < 7; k++) c.fillRect(12 + k * 6, 9 + i * 15.5, 3, 6);
      for (let j = 0; j < 5; j++) {
        if (Math.random() < 0.75) {
          c.fillStyle = Math.random() < 0.18 ? "#ff3b30" : "#4fe0ff";
          c.fillRect(84 + j * 7, 11 + i * 15.5, 3, 3);
        }
      }
    }
  });
  const screens = [drawDashboard, drawCode, drawSecurity].map((d) => canvasTexture(256, 144, d));
  const wallScreens = [drawDashboard, drawSecurity].map((d) => canvasTexture(512, 288, d));
  const opsMap = canvasTexture(512, 288, drawOpsMap);
  const kiosk = canvasTexture(192, 128, (c, w, h) => drawKiosk(c, w, h, "SECURITY TERMINAL", "LOCKED", "#ff6b57", false));
  const kioskDone = canvasTexture(192, 128, (c, w, h) => drawKiosk(c, w, h, "SECURITY TERMINAL", "ACCESS GRANTED", "#4fd6aa", true));
  const codeKiosk = canvasTexture(192, 128, (c, w, h) => drawKiosk(c, w, h, "IT HELPDESK", "DOOR CODES", "#6cc4ff", false));
  const logo = canvasTexture(1024, 256, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.strokeStyle = "#c99a55";
    c.lineWidth = 14;
    c.beginPath();
    c.arc(128, 128, 82, 0, Math.PI * 2);
    c.stroke();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      c.beginPath();
      c.moveTo(128 + Math.cos(a) * 26, 128 + Math.sin(a) * 26);
      c.lineTo(128 + Math.cos(a) * 62, 128 + Math.sin(a) * 62);
      c.stroke();
    }
    c.fillStyle = "#2b2722";
    c.font = "700 112px sans-serif";
    c.textBaseline = "middle";
    c.fillText("VAULTLINE", 250, 112);
    c.fillStyle = "#8a7a62";
    c.font = "600 34px sans-serif";
    c.fillText("D A T A   H O L D I N G S", 256, 196);
  });
  const brushed = canvasTexture(128, 256, (c) => {
    c.fillStyle = "#aeb4bd";
    c.fillRect(0, 0, 128, 256);
    for (let i = 0; i < 260; i++) {
      c.fillStyle = Math.random() < 0.5 ? "#c4c9d1" : "#9aa1ab";
      c.globalAlpha = rand(0.2, 0.6);
      c.fillRect(Math.random() * 128, 0, 1, 256);
    }
    c.globalAlpha = 1;
  });
  const hazard = canvasTexture(128, 256, (c) => {
    c.fillStyle = "#3a3f47";
    c.fillRect(0, 0, 128, 256);
    for (let i = 0; i < 120; i++) {
      c.fillStyle = Math.random() < 0.5 ? "#454b54" : "#30343b";
      c.fillRect(0, Math.random() * 256, 128, 1);
    }
    for (const y0 of [24, 212]) {
      c.save();
      c.beginPath();
      c.rect(0, y0, 128, 20);
      c.clip();
      for (let x = -40; x < 160; x += 20) {
        c.fillStyle = "#ffb81f";
        c.beginPath();
        c.moveTo(x, y0 + 20);
        c.lineTo(x + 10, y0 + 20);
        c.lineTo(x + 30, y0);
        c.lineTo(x + 20, y0);
        c.fill();
      }
      c.restore();
    }
    c.fillStyle = "#1c1f24";
    c.fillRect(0, 0, 3, 256);
  });
  const mesh = canvasTexture(64, 64, (c) => {
    c.fillStyle = "#3a404c";
    c.fillRect(0, 0, 64, 64);
    c.fillStyle = "#16191f";
    for (let i = 0; i < 64; i += 4) {
      c.fillRect(i, 0, 1, 64);
      c.fillRect(0, i, 64, 1);
    }
  });
  mesh.repeat.set(6, 8);
  const note = canvasTexture(64, 64, (c) => {
    c.fillStyle = "#ffd84a";
    c.fillRect(0, 0, 64, 64);
    c.strokeStyle = "#1d3a8a";
    c.lineWidth = 3;
    for (const y of [18, 32, 46]) {
      c.beginPath();
      c.moveTo(10, y);
      for (let x = 10; x < 54; x += 6) c.lineTo(x, y + rand(-3, 3));
      c.stroke();
    }
  });
  const whiteboard = canvasTexture(256, 160, (c) => {
    c.fillStyle = "#f6f7f8";
    c.fillRect(0, 0, 256, 160);
    c.lineWidth = 3;
    for (const color of ["#2f5d8a", "#c0392b", "#2e8b57"]) {
      c.strokeStyle = color;
      c.beginPath();
      let x = rand(20, 80);
      let y = rand(20, 140);
      c.moveTo(x, y);
      for (let i = 0; i < 5; i++) c.lineTo((x += rand(15, 40)), (y = rand(20, 140)));
      c.stroke();
    }
    c.strokeStyle = "#2f5d8a";
    c.strokeRect(150, 24, 80, 40);
    c.strokeRect(150, 90, 80, 40);
  });
  const helipad = canvasTexture(512, 512, (c) => {
    c.fillStyle = "#24272d";
    c.fillRect(0, 0, 512, 512);
    speckle(c, 512, 512, ["#2c3036", "#1d2025"], 0.8, 900, 5);
    c.strokeStyle = "#ffb81f";
    c.lineWidth = 22;
    c.beginPath();
    c.arc(256, 256, 200, 0, Math.PI * 2);
    c.stroke();
    c.fillStyle = "#f2f2f3";
    c.fillRect(176, 136, 40, 240);
    c.fillRect(296, 136, 40, 240);
    c.fillRect(216, 236, 80, 40);
  });
  const roof = canvasTexture(256, 256, (c) => {
    c.fillStyle = "#43464c";
    c.fillRect(0, 0, 256, 256);
    speckle(c, 256, 256, ["#50545a", "#363940", "#5b5f66"], 0.9, 1500, 3);
  });
  const mist = canvasTexture(256, 256, (c) => {
    c.clearRect(0, 0, 256, 256);
    for (let i = 0; i < 26; i++) {
      const x = Math.random() * 256;
      const y = Math.random() * 256;
      const r = rand(30, 90);
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, "rgba(200, 230, 255, 0.22)");
      g.addColorStop(1, "rgba(200, 230, 255, 0)");
      c.fillStyle = g;
      c.fillRect(x - r, y - r, r * 2, r * 2);
    }
  });
  mist.repeat.set(5, 4);
  // Lit windows for the city outside, a few patterns to share between towers.
  const towers = [0, 1, 2].map(() =>
    canvasTexture(64, 128, (c) => {
      c.fillStyle = "#0b0e1a";
      c.fillRect(0, 0, 64, 128);
      for (let y = 2; y < 128; y += 6) {
        for (let x = 3; x < 64; x += 7) {
          if (Math.random() < 0.35) {
            c.fillStyle = Math.random() < 0.8 ? "#ffd99a" : "#9fd4ff";
            c.globalAlpha = rand(0.35, 1);
            c.fillRect(x, y, 4, 3);
          }
        }
      }
      c.globalAlpha = 1;
    }),
  );
  const sky = canvasTexture(4, 256, (c) => {
    const g = c.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, "#04050c");
    g.addColorStop(0.55, "#0c1030");
    g.addColorStop(0.8, "#2a1d3c");
    g.addColorStop(1, "#43273a");
    c.fillStyle = g;
    c.fillRect(0, 0, 4, 256);
  });
  const all = [whiteboard, server, rack, rackRow, opsMap, kiosk, kioskDone, codeKiosk, logo, brushed, hazard, mesh, note, helipad, roof, mist, sky, ...screens, ...wallScreens, ...towers];
  textureQueue = null;
  return { whiteboard, server, rack, rackRow, screens, wallScreens, opsMap, kiosk, kioskDone, codeKiosk, logo, brushed, hazard, mesh, note, helipad, roof, mist, towers, sky, all };
}

/**
 * A helicopter, low poly: a cabin built of panels (so it can be seen from inside, where the camera rides
 * out), an open door on its right (+x), two pilots, spinning rotors, navigation lights and a searchlight
 * beam. The troop carrier is olive; the extraction bird is dark with the accent stripe. Nose toward +z.
 */
function makeHelicopter(troop: boolean) {
  const body = new THREE.MeshStandardMaterial({ color: troop ? 0x2f3628 : 0x1d2433, roughness: 0.5, metalness: 0.45 });
  const stripe = new THREE.MeshStandardMaterial({ color: troop ? 0x1a1d16 : ACCENT, emissive: troop ? 0x000000 : ACCENT, emissiveIntensity: 0.3 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x8fc8ff, roughness: 0.05, metalness: 0.6, transparent: true, opacity: 0.45, depthWrite: false });
  const dark = new THREE.MeshStandardMaterial({ color: 0x0c0e12, roughness: 0.6 });
  const inner = new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.8 });
  const seat = new THREE.MeshStandardMaterial({ color: 0x5a4a32, roughness: 0.9 });
  const red = new THREE.MeshBasicMaterial({ color: 0xff3b30 });
  const green = new THREE.MeshBasicMaterial({ color: 0x3bff7a });
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const lamp = new THREE.MeshBasicMaterial({ color: 0xff5040, toneMapped: false });
  const beamMat = new THREE.MeshBasicMaterial({ color: 0xfff3d0, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const geos: THREE.BufferGeometry[] = [];
  const b = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D) => {
    const g = new THREE.BoxGeometry(w, h, d);
    geos.push(g);
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  };
  const node = new THREE.Group();
  // The cabin: belly, floor, roof, back wall, left wall with windows, the front of the right side.
  b(2.0, 0.42, 3.3, body, 0, 0.55, 0, node);
  b(1.9, 0.06, 3.2, inner, 0, 0.79, 0, node);
  b(2.04, 0.12, 3.3, body, 0, 2.38, 0, node);
  b(2.0, 1.6, 0.08, body, 0, 1.56, -1.62, node);
  b(0.08, 0.5, 3.3, body, -1.0, 1.0, 0, node);
  b(0.08, 0.35, 3.3, body, -1.0, 2.15, 0, node);
  for (const z of [-1.2, 0, 1.2]) b(0.08, 0.75, 0.5, body, -1.0, 1.62, z + 0.35, node);
  b(0.04, 0.72, 3.0, glass, -1.0, 1.62, 0, node);
  b(0.08, 1.6, 0.55, body, 1.0, 1.56, 1.38, node);
  b(0.1, 1.45, 1.1, body, 1.07, 1.5, -1.25, node); // the door, slid back
  for (const x of [-1.04, 1.04]) b(0.03, 0.12, 3.32, stripe, x, 0.86, 0, node);
  // Inside: a bench along the left wall, a red night lamp.
  b(0.5, 0.08, 2.4, seat, -0.68, 1.2, -0.2, node);
  b(0.1, 0.55, 2.4, seat, -0.9, 1.5, -0.2, node);
  for (const z of [-1.2, 0.8]) b(0.06, 0.4, 0.06, inner, -0.6, 1.0, z, node);
  b(0.3, 0.03, 0.1, lamp, 0, 2.3, -0.6, node);
  // The nose and cockpit with its two pilots.
  b(1.7, 0.8, 1.3, body, 0, 1.15, 2.25, node);
  b(1.66, 0.85, 1.25, glass, 0, 1.97, 2.2, node);
  b(1.7, 0.1, 1.3, body, 0, 2.42, 2.2, node);
  for (const x of [-0.42, 0.42]) {
    b(0.42, 0.5, 0.36, troop ? stripe : dark, x, 1.55, 2.0, node);
    b(0.26, 0.27, 0.28, dark, x, 1.98, 2.0, node);
    b(0.2, 0.08, 0.04, lamp, x, 1.98, 2.15, node);
  }
  // Tail, skids, mast.
  b(0.4, 0.4, 4.6, body, 0, 1.9, -3.8, node);
  b(0.08, 1.1, 0.7, body, 0, 2.4, -5.9, node);
  b(1.2, 0.06, 0.5, body, 0, 1.95, -5.7, node);
  for (const x of [-0.85, 0.85]) {
    b(0.08, 0.08, 3.4, dark, x, 0.06, 0.3, node);
    for (const z of [-0.8, 1.2]) b(0.06, 0.62, 0.06, dark, x * 0.92, 0.38, z, node);
  }
  b(0.16, 0.45, 0.16, dark, 0, 2.6, 0, node);
  const rotor = new THREE.Group();
  rotor.position.set(0, 2.85, 0);
  node.add(rotor);
  b(10.5, 0.04, 0.26, dark, 0, 0, 0, rotor);
  b(0.26, 0.04, 10.5, dark, 0, 0, 0, rotor);
  const tail = new THREE.Group();
  tail.position.set(0.12, 2.45, -5.9);
  node.add(tail);
  b(0.03, 1.5, 0.12, dark, 0, 0, 0, tail);
  b(0.03, 0.12, 1.5, dark, 0, 0, 0, tail);
  b(0.08, 0.08, 0.08, red, -1.06, 1.6, 0.5, node);
  b(0.08, 0.08, 0.08, green, 1.06, 1.6, 0.5, node);
  const strobe = b(0.1, 0.1, 0.1, white, 0, 2.95, -6.1, node);
  // Where the searchlight hangs, under the nose; the beam is a soft cone that lookAt aims.
  const mount = new THREE.Object3D();
  mount.position.set(0, 0.6, 2.6);
  node.add(mount);
  const coneGeo = new THREE.ConeGeometry(3, 14, 24, 1, true);
  coneGeo.translate(0, -7, 0);
  coneGeo.rotateX(-Math.PI / 2);
  geos.push(coneGeo);
  const beam = new THREE.Mesh(coneGeo, beamMat);
  beam.position.copy(mount.position);
  node.add(beam);
  const dispose = () => {
    for (const g of geos) g.dispose();
    for (const m of [body, stripe, glass, dark, inner, seat, red, green, white, lamp, beamMat]) m.dispose();
  };
  return { node, rotor, tail, mount, beam, strobe, dispose };
}

/** Builds and runs the game in the host; returns what tears it all down. */
function runRaid(
  host: HTMLDivElement,
  hud: HTMLDivElement,
  onExit: () => void,
  report: (step: string, progress: number, built: number) => void,
  onReady: () => void,
  onError: (e: Error) => void,
): () => void {
  document.documentElement.classList.add("playing-game");
  const texJobs: (() => void)[] = [];
  const tex = makeTextures(texJobs);
  const sound = createRaidSound();

  // ---- renderer, scene, camera ----
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  /**
   * At most this many pixels are drawn (about 2560 x 1440): a high-density big screen would otherwise
   * draw 2-3 times that every frame for detail no one sees at 60 frames a second.
   */
  const PIXEL_BUDGET = 3.7e6;
  const ratioCap = () => Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO, Math.sqrt(PIXEL_BUDGET / Math.max(1, window.innerWidth * window.innerHeight)));
  renderer.setPixelRatio(ratioCap()); // lowered further when frames run long
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  host.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = tex.sky;
  const fog = new THREE.Fog(NIGHT, 26, 170);
  scene.fog = fog;
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envMap: THREE.Texture | null = null;
  scene.environmentIntensity = 0.35;
  const hemi = new THREE.HemisphereLight(0xbfd2ff, 0x1a1c24, 0.35);
  scene.add(hemi);
  const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.03, 400);
  camera.rotation.order = "YXZ";
  scene.add(camera);
  // Your weapons: one model each, all in front of the camera, only the one in hand shown. One muzzle light
  // moves to whichever is out, so the number of lights (and every compiled shader) never changes.
  const guns = {} as Record<WeaponId, WeaponModel>;
  for (const id of WEAPON_IDS) {
    guns[id] = makeWeaponModel(id);
    guns[id].node.visible = id === "pistol";
    camera.add(guns[id].node);
  }
  // The muzzle light hangs on the camera, never on a weapon: a hidden weapon would hide its light, and a
  // light coming or going recompiles every shader.
  const muzzleLight = new THREE.PointLight(0xffc24a, 0, 8, 2);
  camera.add(muzzleLight);
  const anim = createWeaponState();

  // Shared geometry and materials, made once and disposed at the end.
  const geoCache = new Map<string, THREE.BoxGeometry>();
  const box = (w: number, h: number, d: number) => {
    const k = `${w},${h},${d}`;
    let g = geoCache.get(k);
    if (!g) geoCache.set(k, (g = new THREE.BoxGeometry(w, h, d)));
    return g;
  };
  const arrowShape = new THREE.Shape();
  arrowShape.moveTo(0, 0.05);
  arrowShape.lineTo(0.045, -0.03);
  arrowShape.lineTo(-0.045, -0.03);
  arrowShape.closePath();
  const unitCone = new THREE.ConeGeometry(1, 1, 20, 1, true);
  unitCone.translate(0, -0.5, 0);
  unitCone.rotateX(Math.PI / 2); // apex at the camera, opening along -z
  const shapes = {
    screen: new THREE.PlaneGeometry(0.52, 0.29),
    laptopScreen: new THREE.PlaneGeometry(0.29, 0.18),
    wallScreen: new THREE.PlaneGeometry(1.5, 0.84),
    videoWall: new THREE.PlaneGeometry(0.94, 0.56),
    kioskScreen: new THREE.PlaneGeometry(0.54, 0.36),
    indicator: new THREE.PlaneGeometry(0.44, 0.15),
    logo: new THREE.PlaneGeometry(7, 1.75),
    note: new THREE.PlaneGeometry(0.16, 0.16),
    pole: new THREE.CylinderGeometry(0.025, 0.025, 0.36, 6),
    lampBase: new THREE.CylinderGeometry(0.07, 0.08, 0.02, 10),
    mug: new THREE.CylinderGeometry(0.042, 0.036, 0.1, 10),
    potSmall: new THREE.CylinderGeometry(0.07, 0.055, 0.12, 8),
    leavesSmall: new THREE.IcosahedronGeometry(0.12, 0),
    pot: new THREE.CylinderGeometry(0.26, 0.2, 0.55, 10),
    leaves: new THREE.IcosahedronGeometry(0.46, 0),
    leavesTop: new THREE.IcosahedronGeometry(0.3, 0),
    card: new THREE.BoxGeometry(0.34, 0.22, 0.02),
    flash: new THREE.PlaneGeometry(0.3, 0.3),
    spark: new THREE.SphereGeometry(0.05, 6, 6),
    casing: new THREE.BoxGeometry(0.012, 0.012, 0.03),
    arrow: new THREE.ShapeGeometry(arrowShape),
    cone: unitCone,
    helipad: new THREE.CircleGeometry(7, 48),
    bottle: new THREE.CylinderGeometry(0.14, 0.14, 0.45, 12),
    mist: new THREE.PlaneGeometry(MAP_W * U, MAP_H * U),
    puff: new THREE.IcosahedronGeometry(1, 2),
  };
  const glow = (color: number) => new THREE.MeshBasicMaterial({ color, toneMapped: false });
  const std = (color: number, roughness = 0.5, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
  const mats = {
    server: new THREE.MeshStandardMaterial({ map: tex.server, emissiveMap: tex.server, emissive: 0xffffff, emissiveIntensity: 0.9, roughness: 0.5 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x9fd4ff, transparent: true, opacity: 0.16, roughness: 0.05, metalness: 0.3, depthWrite: false, side: THREE.DoubleSide }),
    partition: new THREE.MeshStandardMaterial({ color: 0x8fb8d8, transparent: true, opacity: 0.2, roughness: 0.05, metalness: 0.4, depthWrite: false }),
    frost: new THREE.MeshStandardMaterial({ color: 0xe8eef5, transparent: true, opacity: 0.42, roughness: 0.9, depthWrite: false }),
    metal: std(0xaab0bb, 0.3, 0.85),
    frame: std(0x14161c, 0.4, 0.7),
    steel: new THREE.MeshStandardMaterial({ map: tex.brushed, roughness: 0.35, metalness: 0.85 }),
    carDoor: new THREE.MeshStandardMaterial({ map: tex.brushed, color: 0xdfe3ea, roughness: 0.28, metalness: 0.9 }),
    carFloor: std(0x23262c, 0.5, 0.3),
    ledCool: glow(0x6cc4ff),
    ledWarm: glow(0xfff0d8),
    door: new THREE.MeshStandardMaterial({ color: 0xff6b57, transparent: true, opacity: 0.35, emissive: CORAL, emissiveIntensity: 0.4, depthWrite: false }),
    chair: std(0x1d2028, 0.85),
    chairMesh: new THREE.MeshStandardMaterial({ map: tex.mesh, roughness: 0.8, transparent: true, opacity: 0.88 }),
    leather: std(0x2a1c16, 0.45),
    caster: std(0x0d0e11, 0.6),
    keyboard: std(0x1c1f26, 0.5),
    laptop: std(0xb8bcc4, 0.35, 0.7),
    mug: std(0xf3f1ec, 0.4),
    monitor: std(0x111318, 0.3, 0.4),
    screens: tex.screens.map((t) => new THREE.MeshBasicMaterial({ map: t })),
    wallScreens: [...tex.wallScreens, tex.opsMap].map((t) => new THREE.MeshBasicMaterial({ map: t })),
    logo: new THREE.MeshBasicMaterial({ map: tex.logo, transparent: true }),
    kioskBody: std(0xd4d8e0, 0.35, 0.5),
    kiosk: new THREE.MeshBasicMaterial({ map: tex.kiosk }),
    kioskDone: new THREE.MeshBasicMaterial({ map: tex.kioskDone }),
    codeKiosk: new THREE.MeshBasicMaterial({ map: tex.codeKiosk }),
    cabinet: std(0x262a33, 0.45, 0.65),
    cabinetDoor: std(0x313642, 0.5, 0.6),
    filing: std(0x8c939e, 0.4, 0.6),
    cardboard: std(0xb48a5a, 0.9),
    binder: std(0x2f5d8a, 0.6),
    printer: std(0xe6e8ec, 0.4),
    printerTop: std(0x3a3f47, 0.5),
    whiteboard: new THREE.MeshStandardMaterial({ map: tex.whiteboard, roughness: 0.25 }),
    bottle: new THREE.MeshStandardMaterial({ color: 0x7fc4ff, transparent: true, opacity: 0.55, roughness: 0.1 }),
    stall: std(0x9aa3ad, 0.5, 0.2),
    porcelain: std(0xf4f4f2, 0.15),
    panel: glow(0xeef3ff),
    lampOff: glow(CORAL),
    lampOn: glow(MINT),
    pot: std(0xe9e7e2, 0.6),
    leaves: new THREE.MeshStandardMaterial({ color: 0x2f7d4f, roughness: 0.8, flatShading: true }),
    laser: glow(0xff2a1a),
    rack: new THREE.MeshStandardMaterial({ map: tex.rack, emissiveMap: tex.rack, emissive: 0xffffff, emissiveIntensity: 1, roughness: 0.4 }),
    rackRow: new THREE.MeshStandardMaterial({ map: tex.rackRow, emissiveMap: tex.rackRow, emissive: 0xffffff, emissiveIntensity: 1.1, roughness: 0.45, metalness: 0.3 }),
    tray: std(0x8a8f98, 0.4, 0.8),
    cables: std(0x14161a, 0.7),
    card: new THREE.MeshStandardMaterial({ color: ACCENT, emissive: ACCENT, emissiveIntensity: 1.2 }),
    medkit: new THREE.MeshStandardMaterial({ color: 0xf2f4f7, roughness: 0.4, emissive: 0x1a3a30, emissiveIntensity: 0.6 }),
    cross: glow(MINT),
    intel: new THREE.MeshStandardMaterial({ color: 0xd2452f, roughness: 0.6, emissive: 0x3a0d08, emissiveIntensity: 0.8 }),
    brass: std(0xd9a53f, 0.3, 0.9),
    fabric: std(0x3c4a55, 0.9),
    cushion: std(0x4a5a66, 0.95),
    pillow: std(0xc99a55, 0.9),
    counter: std(0xf3f0ea, 0.2, 0.1),
    counterTop: std(0x23262c, 0.15, 0.3),
    cabinetWhite: std(0xefefec, 0.4),
    gateLamp: glow(CORAL),
    flap: new THREE.MeshStandardMaterial({ color: 0xbfe0ff, transparent: true, opacity: 0.35, roughness: 0.05, depthWrite: false }),
    secDoor: new THREE.MeshStandardMaterial({ map: tex.hazard, roughness: 0.4, metalness: 0.7 }),
    keypad: std(0x1a1d24, 0.5, 0.4),
    note: new THREE.MeshBasicMaterial({ map: tex.note, side: THREE.DoubleSide }),
    camBody: std(0xd9dde3, 0.4, 0.3),
    camLed: glow(0xff3b30),
    camLedOff: std(0x222222, 0.6),
    coneIdle: new THREE.MeshBasicMaterial({ color: 0x9fd4ff, transparent: true, opacity: 0.05, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    coneHot: new THREE.MeshBasicMaterial({ color: 0xff4433, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    mist: new THREE.MeshBasicMaterial({ map: tex.mist, transparent: true, opacity: 0.4, depthWrite: false }),
    roof: new THREE.MeshStandardMaterial({ map: tex.roof, roughness: 0.95 }),
    helipad: new THREE.MeshStandardMaterial({ map: tex.helipad, roughness: 0.8 }),
    parapet: std(0x3a3d42, 0.8),
    towers: tex.towers.map((t) => new THREE.MeshBasicMaterial({ map: t })),
    spark: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    casing: std(0xffffff, 0.35, 0.8),
    housing: std(0x4a4e56, 0.85),
    tank: std(0x8d949c, 0.45, 0.6),
    sock: std(0xff7a2a, 0.8),
    rope: new THREE.MeshStandardMaterial({ color: 0xd8c8a0, emissive: 0x6a5838, emissiveIntensity: 0.7, roughness: 0.9 }),
    grenade: std(0x2d3328, 0.6, 0.4),
    riot: new THREE.MeshStandardMaterial({ color: 0xbfd6ea, transparent: true, opacity: 0.45, roughness: 0.15, metalness: 0.3, depthWrite: false, side: THREE.DoubleSide }),
    beacon: glow(0xff2a1a),
    fx: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
    smoke: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.36, depthWrite: false }),
    debris: std(0xffffff, 0.8),
    street: glow(0xffa64a),
  };
  tex.roof.repeat.set(16, 12);
  tex.brushed.repeat.set(3, 1);

  // ---- the city outside, built once; it sinks as you go up ----
  const city = new THREE.Group();
  scene.add(city);
  const cx = (MAP_W * U) / 2;
  const cz = (MAP_H * U) / 2;
  for (let i = 0; i < 180; i++) {
    const angle = rand(0, Math.PI * 2);
    const dist = rand(80, 230);
    const w = rand(10, 26);
    const h = rand(30, 130);
    const tower = new THREE.Mesh(box(w, h, w), mats.towers[i % 3]);
    tower.position.set(cx + Math.cos(angle) * dist, h / 2 - 70, cz + Math.sin(angle) * dist);
    city.add(tower);
  }
  for (const t of tex.towers) t.repeat.set(2, 6);
  for (const tower of city.children) {
    tower.updateMatrix();
    tower.matrixAutoUpdate = false;
  }
  // Red aircraft lights on the taller towers, and the street lights far below: one draw call each.
  {
    const beacons = new THREE.InstancedMesh(box(0.8, 0.8, 0.8), mats.beacon, 60);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 60; i++) {
      const tower = city.children[(i * 3) % city.children.length] as THREE.Mesh;
      const g = tower.geometry as THREE.BoxGeometry;
      m.makeTranslation(tower.position.x, tower.position.y + g.parameters.height / 2 + 0.6, tower.position.z);
      beacons.setMatrixAt(i, m);
    }
    city.add(beacons);
    const lamps = new THREE.InstancedMesh(box(2.4, 0.4, 2.4), mats.street, 240);
    for (let i = 0; i < 240; i++) {
      const road = i % 2 ? 1 : 0;
      const along = rand(-300, 300);
      const lane = (Math.floor(rand(-6, 6)) + 0.5) * 70;
      m.makeTranslation(cx + (road ? along : lane), -69.6, cz + (road ? lane : along));
      lamps.setMatrixAt(i, m);
    }
    city.add(lamps);
  }
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), new THREE.MeshBasicMaterial({ color: 0x0a0b12 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(cx, -70, cz);
  city.add(ground);
  const floorBase = (index: number) => THEMES.slice(0, index).reduce((sum, t) => sum + t.h + 0.6, 0);

  // ---- one floor at a time ----
  let floorIndex = 0;
  let theme = THEMES[0];
  let map: string[] = FLOORS[0];
  let level = new THREE.Group();
  scene.add(level);
  const blockers: THREE.Object3D[] = []; // what a bullet stops at
  const perFloorDisposables: { dispose(): void }[] = [];
  let guards: Guard[] = [];
  let civs: Civ[] = [];
  let seats: { m: THREE.Matrix4; kind: "desk" | "exec" | "meeting" | "reception" | "sofa" }[] = [];
  let stations: Station[] = [];
  let notes: Note[] = [];
  let doors: Door[] = [];
  let cams: Cam[] = [];
  let wires: Wire[] = [];
  let cars: Car[] = [];
  let pickups: Pickup[] = [];
  let flaps: THREE.Mesh[] = [];
  let levelLights: LightSpot[] = [];
  let keycardSpot: LightSpot | null = null;
  let floorMats: Record<"wall" | "solid" | "floor" | "ceiling" | "frame" | "desk" | "table" | "tile", THREE.MeshStandardMaterial> | null = null;
  const camBodies = new Map<THREE.Object3D, Cam>();
  const carByCell = new Map<number, Car>();
  const doorByCell = new Map<number, Door>();
  let keycardNode: THREE.Object3D | null = null;
  let keyDoorNode: THREE.Object3D | null = null;
  let badgeNode: THREE.Object3D | null = null;
  let lasers: THREE.Object3D | null = null;
  let keycardAt: Spot | null = null;
  let badgeAt: Spot | null = null;
  let rackAt: Spot | null = null;
  let boss: Guard | null = null;
  let hasKey = false;
  let keyDoorOpen = false;
  let gatesOpen = false;
  let camsOff = false;
  let floorDone = false;
  let alarm = false;
  let spottedOnce = false;
  let holdAt: Station | null = null;
  let hold = 0;
  let run: Run | null = null;
  let backupT = 0;
  let finale = 0;
  let finaleWave = 0;
  let floorClock = 0;
  const codes: string[][] = FLOORS.map(() => []);
  type Heli = ReturnType<typeof makeHelicopter>;
  let helis: Heli[] = [];
  // The roof: a stand until the extraction helicopter lands.
  let onRoof = false;
  let roofClock = 0;
  let roofHold = 90;
  let roofWave = 0;
  let troop: { h: Heli; state: "wait" | "in" | "drop" | "out" | "gone"; t: number; dropped: number } | null = null;
  let extract: { h: Heli; state: "wait" | "in" | "landed"; t: number } | null = null;
  let roofSpot: THREE.SpotLight | null = null;
  let stairDoors: { x: number; y: number; node: THREE.Object3D; open: number }[] = [];
  let windsock: THREE.Object3D | null = null;
  let ropeNode: THREE.Mesh | null = null;
  /** The five floors' window bands on the tower's outside (the roof level only), for the ending. */
  let facade: { mat: THREE.MeshBasicMaterial; y: number; h: number }[] = [];
  /** Cells nothing walks through for now (the landed helicopter). */
  const heldCells = new Set<number>();

  // What blocks walking, per cell, as rectangles in cell coordinates (x0, y0, x1, y1, ...).
  const FULL = [0, 0, 1, 1];
  const NONE: number[] = [];
  const SMALL = [0.28, 0.28, 0.72, 0.72];
  const MID = [0.18, 0.18, 0.82, 0.82];
  const arms = new Uint8Array(MAP_W * MAP_H); // glass partitions: N 1, E 2, S 4, W 8
  const rects: number[][] = new Array(MAP_W * MAP_H).fill(NONE);
  const flow = new Int16Array(MAP_W * MAP_H);
  let flowFrom = -1;

  const player = { x: 1.5, y: 1.5, z: 0, vz: 0, land: 0, yaw: 0, pitch: 0, health: 100, hurt: 0, walk: 0, px: 1.5, py: 1.5, crouch: 0, blind: 0, moving: 0 };
  // What you carry. The shield is held with the pistol, so it fires (and reloads) the pistol's magazine.
  const START_RESERVE: Record<AmmoType, number> = { pistol: 48, rifle: 0, shell: 0 };
  const inv = {
    owned: { pistol: true, rifle: false, shotgun: false, shield: false } as Record<WeaponId, boolean>,
    mag: { pistol: WEAPONS.pistol.magazine, rifle: 0, shotgun: 0 } as Record<Exclude<WeaponId, "shield">, number>,
    reserve: { ...START_RESERVE },
    shield: 0,
  };
  type Inventory = typeof inv;
  const copyInv = (from: Inventory, to: Inventory) => {
    Object.assign(to.owned, from.owned);
    Object.assign(to.mag, from.mag);
    Object.assign(to.reserve, from.reserve);
    to.shield = from.shield;
  };
  /** What you had when you arrived on the floor: a restart gives it back. */
  const saved: Inventory = { owned: { ...inv.owned }, mag: { ...inv.mag }, reserve: { ...inv.reserve }, shield: 0 };
  const magKey = (id: WeaponId) => (id === "shield" ? "pistol" : id);
  let weapon: WeaponId = "pistol";
  let lastWeapon: WeaponId = "pistol";
  let wantWeapon: WeaponId | null = null;
  let fireCooldown = 0;
  let reloadT = -1; // seconds into the reload (into the current shell for the shotgun), -1 when not reloading
  let reloadPumps = false;
  let trigger = false;
  let triggerFresh = false;
  let shieldRaised = false;
  let wheelT = 0;
  let difficulty = 1;
  let maxHealth = DIFFICULTIES[1].health;
  let kills = 0;
  let headshots = 0;
  let shots = 0;
  let hits = 0;
  let alarms = 0;
  let intel = 0;
  let deaths = 0;
  let civiliansHit = 0;
  let elapsed = 0;
  // God mode (the `iddqd` cheat code): a run that ever had it on never records a best score.
  let god = false;
  let godUsed = false;
  // Development builds only: the test tools (start floor, F9/F10/F11). A run that used them saves no best score.
  let testUsed = false;

  const inside = (x: number, y: number) => x > 0 && y > 0 && x < MAP_W - 1 && y < MAP_H - 1;
  const cellAt = (x: number, y: number): string => (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H ? "#" : map[y][x]);
  const rectsAt = (x: number, y: number): number[] => {
    if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) return FULL;
    const i = y * MAP_W + x;
    const ch = map[y][x];
    if (ch === "L") return keyDoorOpen ? NONE : FULL;
    if (ch === "D") return doorByCell.get(i)?.open ? NONE : FULL;
    if (ch === "t") return gatesOpen ? rects[i] : FULL;
    const car = carByCell.get(i);
    if (car) return car.open > 0.9 ? car.walls : car.closed;
    if (heldCells.size && heldCells.has(i)) return FULL;
    return rects[i];
  };
  const walkCell = (x: number, y: number) => rectsAt(x, y).length === 0;
  /** Whether a square of half-size r around (x, y) is clear of everything solid. */
  const fits = (x: number, y: number, r: number) => {
    for (let cy = Math.floor(y - r); cy <= Math.floor(y + r); cy++) {
      for (let cx = Math.floor(x - r); cx <= Math.floor(x + r); cx++) {
        const list = rectsAt(cx, cy);
        for (let i = 0; i < list.length; i += 4) {
          if (x + r > cx + list[i] && x - r < cx + list[i + 2] && y + r > cy + list[i + 1] && y - r < cy + list[i + 3]) return false;
        }
      }
    }
    return true;
  };
  /** Moves in small steps, so a long frame can never carry anyone through a thin wall. */
  const move = (p: { x: number; y: number }, dx: number, dy: number, r: number) => {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 0.15));
    for (let i = 0; i < n; i++) {
      if (fits(p.x + dx / n, p.y, r)) p.x += dx / n;
      if (fits(p.x, p.y + dy / n, r)) p.y += dy / n;
    }
  };
  const inArms = (m: number, fx: number, fy: number, t: number) => {
    const midX = Math.abs(fx - 0.5) < t;
    const midY = Math.abs(fy - 0.5) < t;
    return (midX && midY) || (!!(m & 1) && midX && fy < 0.5) || (!!(m & 4) && midX && fy > 0.5) || (!!(m & 2) && midY && fx > 0.5) || (!!(m & 8) && midY && fx < 0.5);
  };
  /** Blocks sight: solid walls, frosted partitions, closed doors, racks, elevator shafts. */
  const opaque = (x: number, y: number): boolean => {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    const ch = cellAt(cx, cy);
    if ("XSVkPUzh".includes(ch)) return true;
    if (ch === "O") return Math.abs(x - cx - 0.5) < 0.22 && Math.abs(y - cy - 0.5) < 0.22;
    if (ch === "D") return !doorByCell.get(cy * MAP_W + cx)?.open;
    if (ch !== "#") return false;
    const m = inside(cx, cy) ? arms[cy * MAP_W + cx] : 0;
    return !m || inArms(m, x - cx, y - cy, 0.22);
  };
  const seesFrom = (fx: number, fy: number, x: number, y: number): boolean => {
    const steps = Math.ceil(Math.hypot(x - fx, y - fy) * 4);
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const sx = fx + (x - fx) * t;
      const sy = fy + (y - fy) * t;
      if (Math.floor(sx) === tx && Math.floor(sy) === ty) continue; // the target's own cell (an open elevator)
      if (opaque(sx, sy)) return false;
    }
    return true;
  };
  /** Steps from every walkable cell to yours, refreshed when you change cell. */
  const updateFlow = () => {
    const start = Math.floor(player.y) * MAP_W + Math.floor(player.x);
    if (start === flowFrom) return;
    flowFrom = start;
    flow.fill(-1);
    flow[start] = 0;
    let tail = 0;
    bfsQueue[tail++] = start;
    for (let q = 0; q < tail; q++) {
      const i = bfsQueue[q];
      const x = i % MAP_W;
      const y = (i - x) / MAP_W;
      for (let k = 0; k < 4; k++) {
        const dx = N4[k][0];
        const dy = N4[k][1];
        const n = (y + dy) * MAP_W + x + dx;
        if (walkCell(x + dx, y + dy) && flow[n] < 0) {
          flow[n] = flow[i] + 1;
          bfsQueue[tail++] = n;
        }
      }
    }
  };
  const bfsQueue = new Int32Array(MAP_W * MAP_H);
  const distBuf = new Int16Array(MAP_W * MAP_H);
  /** Steps from one cell to every other, for patrol routes. */
  /** Steps from one cell to every other, into a shared buffer (read it before the next call). */
  const distances = (from: number) => {
    const d = distBuf.fill(-1);
    d[from] = 0;
    let tail = 0;
    bfsQueue[tail++] = from;
    for (let q = 0; q < tail; q++) {
      const i = bfsQueue[q];
      const x = i % MAP_W;
      const y = (i - x) / MAP_W;
      for (let k = 0; k < 4; k++) {
        const dx = N4[k][0];
        const dy = N4[k][1];
        const n = (y + dy) * MAP_W + x + dx;
        if (walkCell(x + dx, y + dy) && d[n] < 0) {
          d[n] = d[i] + 1;
          bfsQueue[tail++] = n;
        }
      }
    }
    return d;
  };
  /** The cells from one cell to another (not including the start), or [] when there is no way. */
  const pathTo = (from: number, to: number): number[] => {
    if (from === to) return [];
    const d = distances(to);
    if (d[from] < 0) return [];
    const out: number[] = [];
    let at = from;
    while (at !== to && out.length < 400) {
      const x = at % MAP_W;
      const y = (at - x) / MAP_W;
      let best = -1;
      for (const [dx, dy] of N4) {
        const n = (y + dy) * MAP_W + x + dx;
        if (n >= 0 && n < d.length && d[n] >= 0 && d[n] < d[at] && walkCell(x + dx, y + dy)) best = n;
      }
      if (best < 0) break;
      out.push(best);
      at = best;
    }
    return out;
  };
  const cellOf = (p: Spot) => Math.floor(p.y) * MAP_W + Math.floor(p.x);

  // Orientation in a cell: a frame with its front (v = 1) toward f.
  const fromLocal = (f: [number, number], u: number, v: number): [number, number] =>
    f[1] === 1 ? [u, v] : f[1] === -1 ? [1 - u, 1 - v] : f[0] === 1 ? [v, 1 - u] : [1 - v, u];
  const orientRects = (list: number[], f: [number, number]) => {
    const out: number[] = [];
    for (let i = 0; i < list.length; i += 4) {
      const [ax, ay] = fromLocal(f, list[i], list[i + 1]);
      const [bx, by] = fromLocal(f, list[i + 2], list[i + 3]);
      out.push(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by));
    }
    return out;
  };
  const carLocal = (car: Car, px: number, py: number): [number, number] => {
    const rx = px - Math.floor(car.x);
    const ry = py - Math.floor(car.y);
    const [dx, dy] = car.dir;
    if (dy === 1) return [rx, ry];
    if (dy === -1) return [1 - rx, 1 - ry];
    if (dx === 1) return [1 - ry, rx];
    return [ry, 1 - rx];
  };
  const carYaw = (car: Car) => Math.atan2(car.dir[1], car.dir[0]);
  const inCar = (car: Car) => {
    if (Math.floor(player.x) !== Math.floor(car.x) || Math.floor(player.y) !== Math.floor(car.y)) return false;
    const [u, v] = carLocal(car, player.x, player.y);
    return v <= 0.62 && u > 0.15 && u < 0.85;
  };
  /** The side an elevator opens to: open, with a wall opposite (same rule as the map check). */
  const carDir = (x: number, y: number): [number, number] => {
    for (const [dx, dy] of N4) {
      const n = cellAt(x + dx, y + dy);
      if (!SOLID_CH.includes(n) && !"tDL".includes(n) && WALLISH.includes(cellAt(x - dx, y - dy))) return [dx, dy];
    }
    return [0, 1];
  };

  const computeRects = () => {
    const wallAt = (x: number, y: number) => WALLISH.includes(cellAt(x, y)) || cellAt(x, y) === "D";
    const a = 0.5 - PARTITION;
    const b = 0.5 + PARTITION;
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const i = y * MAP_W + x;
        const ch = map[y][x];
        let m = 0;
        if (ch === "#" && inside(x, y)) {
          if (wallAt(x, y - 1)) m |= 1;
          if (wallAt(x + 1, y)) m |= 2;
          if (wallAt(x, y + 1)) m |= 4;
          if (wallAt(x - 1, y)) m |= 8;
          if (!m) m = 15;
        }
        arms[i] = m;
        if (m) {
          const r = [a, a, b, b];
          if (m & 1) r.push(a, 0, b, b);
          if (m & 2) r.push(a, a, 1, b);
          if (m & 4) r.push(a, a, b, 1);
          if (m & 8) r.push(0, a, b, b);
          rects[i] = r;
        } else if (ch === "k") {
          rects[i] = cellAt(x - 1, y) === "k" || cellAt(x + 1, y) === "k" ? [0, 0.2, 1, 0.8] : cellAt(x, y - 1) === "k" || cellAt(x, y + 1) === "k" ? [0.2, 0, 0.8, 1] : MID;
        } else if (ch === "j") rects[i] = orientRects([0, 0, 1, 0.45], frontAway(x, y));
        else if (ch === "t") {
          const alongX = "t#XW".includes(cellAt(x - 1, y)) || "t#XW".includes(cellAt(x + 1, y));
          const r = alongX ? [0, 0.17, 0.14, 0.83] : [0.17, 0, 0.83, 0.14];
          const next = alongX ? cellAt(x + 1, y) : cellAt(x, y + 1);
          if (next !== "t") r.push(...(alongX ? [0.86, 0.17, 1, 0.83] : [0.17, 0.86, 0.83, 1]));
          rects[i] = r;
        } else if (ch === "f" || ch === "h") rects[i] = orientRects([0, 0, 1, ch === "f" ? 0.45 : 0.4], frontAway(x, y));
        else if (ch === "O") rects[i] = [0.33, 0.33, 0.67, 0.67];
        else rects[i] = "#XWSVdeMQoPUzv".includes(ch) ? FULL : "TYa".includes(ch) ? SMALL : "FRcpnb".includes(ch) ? MID : NONE;
      }
    }
  };
  /** The front of something that stands with its back to a wall. */
  const frontAway = (x: number, y: number): [number, number] => {
    for (const [dx, dy] of N4) if (WALLISH.includes(cellAt(x + dx, y + dy))) return [-dx, -dy];
    return [0, 1];
  };

  // ---- building a floor: shared parts as one InstancedMesh per geometry and material ----
  type Batch = { geo: THREE.BufferGeometry; mat: THREE.Material; list: THREE.Matrix4[]; block: boolean };
  let batches = new Map<string, Batch>();
  const put = (geo: THREE.BufferGeometry, mat: THREE.Material, m: THREE.Matrix4, block = false) => {
    const key = geo.uuid + mat.uuid;
    let b = batches.get(key);
    if (!b) batches.set(key, (b = { geo, mat, list: [], block }));
    b.list.push(m);
  };
  /** All the parts that share a material, baked into one geometry: one draw call per material. */
  const mergeParts = (parts: [THREE.BufferGeometry, THREE.Matrix4][]) => {
    let verts = 0;
    let count = 0;
    for (const [g] of parts) {
      verts += g.attributes.position.count;
      count += g.index ? g.index.count : g.attributes.position.count;
    }
    const pos = new Float32Array(verts * 3);
    const nor = new Float32Array(verts * 3);
    const uv = new Float32Array(verts * 2);
    const index = verts > 65535 ? new Uint32Array(count) : new Uint16Array(count);
    const v = new THREE.Vector3();
    const nm = new THREE.Matrix3();
    let vo = 0;
    let io = 0;
    for (const [g, m] of parts) {
      nm.getNormalMatrix(m);
      const ps = g.attributes.position;
      const ns = g.attributes.normal;
      const us = g.attributes.uv;
      for (let k = 0; k < ps.count; k++) {
        const i3 = (vo + k) * 3;
        v.fromBufferAttribute(ps, k).applyMatrix4(m);
        pos[i3] = v.x;
        pos[i3 + 1] = v.y;
        pos[i3 + 2] = v.z;
        v.fromBufferAttribute(ns, k).applyMatrix3(nm).normalize();
        nor[i3] = v.x;
        nor[i3 + 1] = v.y;
        nor[i3 + 2] = v.z;
        if (us) {
          uv[(vo + k) * 2] = us.getX(k);
          uv[(vo + k) * 2 + 1] = us.getY(k);
        }
      }
      if (g.index) for (let k = 0; k < g.index.count; k++) index[io++] = g.index.getX(k) + vo;
      else for (let k = 0; k < ps.count; k++) index[io++] = vo + k;
      vo += ps.count;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
    out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    out.setIndex(new THREE.BufferAttribute(index, 1));
    out.computeBoundingSphere();
    return out;
  };
  /**
   * Turns the collected parts into one mesh per material, yielding now and then so loading stays smooth.
   * What stops a bullet is merged a second time, by area (8 by 8 cells) and never drawn: a shot then tests
   * only the few areas its ray crosses instead of every triangle on the floor.
   */
  const HIT_CHUNK = 8;
  const hitMat = new THREE.MeshBasicMaterial({ visible: false });
  function* flushSteps(): Generator<[string, number], void, unknown> {
    const groups = new Map<string, { mat: THREE.Material; parts: [THREE.BufferGeometry, THREE.Matrix4][] }>();
    const chunks = new Map<number, [THREE.BufferGeometry, THREE.Matrix4][]>();
    for (const b of batches.values()) {
      const key = b.mat.uuid;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { mat: b.mat, parts: [] }));
      for (const m of b.list) {
        g.parts.push([b.geo, m]);
        if (!b.block) continue;
        const k = Math.floor(m.elements[14] / U / HIT_CHUNK) * 16 + Math.floor(m.elements[12] / U / HIT_CHUNK);
        let c = chunks.get(k);
        if (!c) chunks.set(k, (c = []));
        c.push([b.geo, m]);
      }
    }
    batches = new Map();
    let i = 0;
    for (const g of groups.values()) {
      const geo = mergeParts(g.parts);
      perFloorDisposables.push(geo);
      const mesh = new THREE.Mesh(geo, g.mat);
      mesh.matrixAutoUpdate = false; // merged in world space: it never moves
      level.add(mesh);
      if (++i % 3 === 0) yield ["Putting it together", 0.86 + (0.04 * i) / groups.size];
    }
    for (const parts of chunks.values()) {
      const geo = mergeParts(parts);
      geo.computeBoundingBox();
      perFloorDisposables.push(geo);
      const mesh = new THREE.Mesh(geo, hitMat);
      mesh.updateMatrixWorld();
      blockers.push(mesh);
      yield ["Putting it together", 0.9];
    }
  }
  const tmpV = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  const tmpE = new THREE.Euler(0, 0, 0, "YXZ");
  const ONE = new THREE.Vector3(1, 1, 1);
  const cellBase = (x: number, y: number, angle: number) => new THREE.Matrix4().makeRotationY(angle).setPosition((x + 0.5) * U, 0, (y + 0.5) * U);
  const local = (base: THREE.Matrix4, x: number, y: number, z: number, ry = 0, rx = 0) =>
    base.clone().multiply(new THREE.Matrix4().compose(tmpV.set(x, y, z), tmpQ.setFromEuler(tmpE.set(rx, ry, 0, "YXZ")), ONE));
  const placed = (geometry: THREE.BufferGeometry, material: THREE.Material, m: THREE.Matrix4, parent: THREE.Object3D = level) => {
    const mesh = new THREE.Mesh(geometry, material);
    m.decompose(mesh.position, mesh.quaternion, mesh.scale);
    parent.add(mesh);
    return mesh;
  };
  const angleOf = (f: [number, number]) => Math.atan2(f[0], f[1]);
  /** Which way a thing in this cell should face: toward the most open side. */
  const openDir = (x: number, y: number): [number, number] => {
    let best: [number, number] = [0, 1];
    let bestRoom = -1;
    for (const [dx, dy] of N4) {
      let n = 0;
      while (n < 6 && walkCell(x + dx * (n + 1), y + dy * (n + 1))) n++;
      if (n > bestRoom) {
        bestRoom = n;
        best = [dx, dy];
      }
    }
    return best;
  };

  /** An office chair facing -z: five spokes with casters, gas lift, seat, armrests, mesh or leather back. */
  const addChair = (c: THREE.Matrix4, exec: boolean) => {
    for (let k = 0; k < 5; k++) {
      const spoke = local(c, 0, 0.07, 0, (k * Math.PI * 2) / 5);
      put(box(0.035, 0.03, 0.3), mats.frame, local(spoke, 0, 0, -0.15));
      put(box(0.045, 0.05, 0.045), mats.caster, local(spoke, 0, -0.04, -0.29));
    }
    put(shapes.pole, mats.metal, local(c, 0, 0.25, 0));
    const seat = exec ? mats.leather : mats.chair;
    put(box(0.48, 0.07, 0.46), seat, local(c, 0, 0.45, 0), true);
    for (const side of [-1, 1]) {
      put(box(0.03, 0.18, 0.03), mats.frame, local(c, side * 0.25, 0.57, 0.04));
      put(box(0.06, 0.025, 0.24), seat, local(c, side * 0.25, 0.67, 0.02));
    }
    const back = local(c, 0, 0.5, 0.22, 0, 0.12);
    if (exec) put(box(0.5, 0.82, 0.09), mats.leather, local(back, 0, 0.43, 0), true);
    else {
      for (const side of [-1, 1]) put(box(0.03, 0.58, 0.03), mats.frame, local(back, side * 0.22, 0.31, 0));
      put(box(0.47, 0.035, 0.035), mats.frame, local(back, 0, 0.6, 0));
      put(box(0.42, 0.54, 0.008), mats.chairMesh, local(back, 0, 0.31, 0), true);
    }
  };
  const addMonitor = (m: THREE.Matrix4, screen: THREE.Material) => {
    put(box(0.55, 0.33, 0.022), mats.monitor, m, true);
    put(shapes.screen, screen, local(m, 0, 0.005, 0.0115));
  };
  const addDeskLamp = (d: THREE.Matrix4, x: number, z: number) => {
    put(shapes.lampBase, mats.frame, local(d, x, 0.76, z));
    put(box(0.015, 0.42, 0.015), mats.frame, local(d, x, 0.97, z, 0, 0.25));
    put(box(0.16, 0.04, 0.08), mats.frame, local(d, x, 1.17, z + 0.1));
    put(box(0.14, 0.005, 0.06), mats.ledWarm, local(d, x, 1.148, z + 0.1));
  };

  /**
   * Builds a floor in small steps (each yield is a point where the loader may wait for the next frame),
   * into a new group that replaces the shown one only at the end; onSwap runs in that same frame.
   */
  function* floorSteps(index: number, placePlayer: boolean, onSwap?: () => void): Generator<[string, number], void, unknown> {
    const old = beginLevel();
    floorIndex = index;
    theme = THEMES[index];
    map = FLOORS[index];
    const h = theme.h;
    computeRects();

    // The floor's own look.
    const wallTex = canvasTexture(256, 256, drawWall(theme.wall));
    const solidTex = canvasTexture(256, 256, drawSolid(theme.solid, theme.wall));
    const floorTex = canvasTexture(256, 256, drawFloor(theme.floor));
    const ceilTex = canvasTexture(256, 256, drawCeiling(index), false);
    floorTex.repeat.set(MAP_W, MAP_H);
    ceilTex.repeat.set(MAP_W, MAP_H);
    const roughness: Record<FloorKind, number> = { stone: 0.18, carpet: 0.95, dark: 0.35, wood: 0.45, raised: 0.55 };
    const fm = {
      wall: new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.7 }),
      solid: new THREE.MeshStandardMaterial({ map: solidTex, roughness: theme.solid === "marble" ? 0.22 : 0.7, metalness: theme.solid === "metal" ? 0.5 : 0 }),
      floor: new THREE.MeshStandardMaterial({ map: floorTex, roughness: roughness[theme.floor], metalness: theme.floor === "raised" ? 0.3 : 0.1 }),
      ceiling: new THREE.MeshStandardMaterial({ color: theme.ceiling, emissiveMap: ceilTex, emissive: theme.strip, emissiveIntensity: theme.stripPower, roughness: 0.9 }),
      frame: std(theme.frame, 0.3, 0.8),
      desk: std(theme.desk, 0.4),
      table: std(theme.table, 0.3),
      tile: std(theme.tile, 0.85),
    };
    floorMats = fm;
    perFloorDisposables.push(wallTex, solidTex, floorTex, ceilTex, ...Object.values(fm));
    const pending: [number, number, Guard["kind"], EnemyType, WeaponId | null][] = [];
    yield [`Building floor ${index + 1}: materials`, 0.04];

    const sources: { x: number; y: number; kind: string }[] = [];
    for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) if ("NY".includes(map[y][x])) sources.push({ x, y, kind: map[y][x] });
    if (!codes[index].length) {
      let n = 0;
      for (const row of map) for (const ch of row) if (ch === "D") n++;
      codes[index] = Array.from({ length: n }, () => String(Math.floor(1000 + Math.random() * 9000)));
    }

    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const ch = map[y][x];
        const c = cellBase(x, y, 0);
        const m = arms[y * MAP_W + x];
        const px = (x + 0.5) * U;
        const pz = (y + 0.5) * U;
        if (ch === "#" && !m) put(box(U, h, U), fm.wall, local(c, 0, h / 2, 0), true);
        else if (ch === "#") {
          // A glass partition: a post in the middle and an arm toward each neighbouring wall,
          // each with a kick plate, a top rail, LED lines, tinted glass and a frosted band.
          const glassH = h - 0.2;
          put(box(0.07, h, 0.07), fm.frame, local(c, 0, h / 2, 0), true);
          N4.forEach(([dx, dz], k) => {
            if (!(m & (1 << k))) return;
            const base = local(c, (dx * U) / 4, 0, (dz * U) / 4, dx ? 0 : Math.PI / 2);
            put(box(U / 2, 0.12, 0.08), fm.frame, local(base, 0, 0.06, 0), true);
            put(box(U / 2, 0.012, 0.085), mats.ledCool, local(base, 0, 0.126, 0));
            put(box(U / 2, 0.08, 0.08), fm.frame, local(base, 0, h - 0.04, 0), true);
            put(box(U / 2, 0.012, 0.085), mats.ledWarm, local(base, 0, h - 0.086, 0));
            put(box(U / 2, glassH, 0.024), mats.partition, local(base, 0, 0.12 + glassH / 2, 0), true);
            put(box(U / 2, 0.5, 0.03), mats.frost, local(base, 0, 1.25, 0));
          });
        } else if (ch === "X") put(box(U, h, U), fm.solid, local(c, 0, h / 2, 0), true);
        else if (ch === "S") put(box(U, h, U), mats.server, local(c, 0, h / 2, 0), true);
        else if (ch === "W") {
          put(box(U, 0.5, U), mats.frame, local(c, 0, 0.25, 0), true);
          put(box(U, 0.35, U), mats.frame, local(c, 0, h - 0.175, 0), true);
          put(box(U * 0.98, h - 0.85, U * 0.98), mats.glass, local(c, 0, 0.5 + (h - 0.85) / 2, 0));
          put(box(0.08, h, 0.08), mats.frame, local(c, 0, h / 2, 0));
        } else if (ch === "d") addDesk(x, y, fm.desk);
        else if (ch === "e") addExecDesk(x, y, fm.desk);
        else if (ch === "M") addMeetingTable(x, y, fm.table);
        else if (ch === "Q") addReception(x, y, fm.desk);
        else if (ch === "o") addSofa(x, y);
        else if (ch === "c") {
          const t = cellBase(x, y, 0);
          put(box(1.2, 0.04, 0.7), fm.table, local(t, 0, 0.42, 0), true);
          for (const lx of [-0.55, 0.55]) for (const lz of [-0.3, 0.3]) put(box(0.03, 0.4, 0.03), mats.metal, local(t, lx, 0.2, lz));
          put(box(0.3, 0.04, 0.22), mats.pillow, local(t, 0.25, 0.46, 0.1, 0.3));
          put(shapes.potSmall, mats.pot, local(t, -0.3, 0.5, -0.1));
          put(shapes.leavesSmall, mats.leaves, local(t, -0.3, 0.62, -0.1));
        } else if (ch === "j") addKitchen(x, y);
        else if (ch === "t") addGate(x, y);
        else if (ch === "V") addVideoWall(x, y);
        else if (ch === "k") {
          const alongX = cellAt(x - 1, y) === "k" || cellAt(x + 1, y) === "k";
          const r = cellBase(x, y, alongX ? 0 : Math.PI / 2);
          put(box(U * 0.98, 2.1, 1.1), mats.rackRow, local(r, 0, 1.05, 0), true);
          put(box(U, 0.05, 0.45), mats.tray, local(r, 0, h - 0.35, 0));
          put(box(U, 0.05, 0.28), mats.cables, local(r, 0, h - 0.3, 0));
        } else if (ch === "p") {
          put(shapes.pot, mats.pot, local(c, 0, 0.27, 0));
          put(shapes.leaves, mats.leaves, local(c, 0, 0.9, 0, rand(0, 3)));
          put(shapes.leavesTop, mats.leaves, local(c, 0.05, 1.3, -0.03, rand(0, 3)));
        } else if (ch === "O") {
          // A structural column.
          put(box(0.6, h, 0.6), fm.solid, local(c, 0, h / 2, 0), true);
          put(box(0.66, 0.1, 0.66), fm.frame, local(c, 0, 0.05, 0));
        } else if (ch === "f") {
          // Filing cabinets against the wall: three drawers each, with handles.
          const f = cellBase(x, y, angleOf(frontAway(x, y)));
          put(box(U * 0.92, 1.32, 0.62), mats.filing, local(f, 0, 0.66, -0.66), true);
          for (const dy of [0.44, 0.88]) put(box(U * 0.9, 0.012, 0.01), mats.keyboard, local(f, 0, dy, -0.345));
          for (const hx of [-0.45, 0.45]) for (const hy of [0.25, 0.69, 1.13]) put(box(0.12, 0.02, 0.03), mats.metal, local(f, hx, hy, -0.34));
          if (hash(x, y) % 3 === 0) put(box(0.3, 0.26, 0.24), mats.cardboard, local(f, rand(-0.5, 0.5), 1.45, -0.66, rand(-0.3, 0.3)));
        } else if (ch === "h") {
          // Shelving with boxes and binders.
          const s = cellBase(x, y, angleOf(frontAway(x, y)));
          for (const sx of [-1, 1]) put(box(0.04, 2.1, 0.45), mats.metal, local(s, sx * (U / 2 - 0.05), 1.05, -0.75), true);
          for (const sy of [0.1, 0.55, 1.0, 1.45, 1.9]) put(box(U * 0.95, 0.03, 0.45), mats.metal, local(s, 0, sy, -0.75), true);
          const hsh = hash(x, y);
          [0.12, 0.57, 1.02, 1.47].forEach((sy, k) => {
            if ((hsh >> k) & 1) put(box(0.42, 0.3, 0.36), mats.cardboard, local(s, -0.45 + ((hsh >> (k + 3)) & 1) * 0.2, sy + 0.16, -0.75, rand(-0.15, 0.15)));
            else for (let b = 0; b < 5; b++) put(box(0.07, 0.3, 0.26), mats.binder, local(s, 0.1 + b * 0.09, sy + 0.17, -0.75));
          });
        } else if (ch === "n") {
          // A copier.
          const n = cellBase(x, y, angleOf(openDir(x, y)));
          put(box(0.9, 0.85, 0.65), mats.printer, local(n, 0, 0.425, 0), true);
          put(box(0.9, 0.12, 0.6), mats.printerTop, local(n, 0, 0.91, -0.02), true);
          put(box(0.28, 0.02, 0.14), mats.screens[0], local(n, 0.22, 0.98, 0.18, 0, -0.4));
          put(box(0.5, 0.04, 0.3), mats.porcelain, local(n, -0.6, 0.62, 0));
        } else if (ch === "b") {
          // A whiteboard on wheels.
          const b = cellBase(x, y, angleOf(openDir(x, y)));
          for (const sx of [-0.82, 0.82]) {
            put(box(0.04, 1.85, 0.04), mats.metal, local(b, sx, 0.93, 0));
            put(box(0.05, 0.04, 0.55), mats.metal, local(b, sx, 0.03, 0));
          }
          put(box(1.7, 1.0, 0.03), mats.whiteboard, local(b, 0, 1.35, 0), true);
          put(box(1.7, 0.03, 0.08), mats.metal, local(b, 0, 0.84, 0.03));
        } else if (ch === "a") {
          // A water cooler.
          put(box(0.32, 1.0, 0.32), mats.porcelain, local(c, 0, 0.5, 0), true);
          put(shapes.bottle, mats.bottle, local(c, 0, 1.23, 0));
          put(box(0.1, 0.06, 0.04), mats.ledCool, local(c, 0, 0.82, 0.17));
        } else if (ch === "z") {
          // A toilet stall: side panels, a door left ajar, the toilet.
          const z = cellBase(x, y, angleOf(frontAway(x, y)));
          for (const sx of [-1, 1]) put(box(0.04, 1.8, 1.5), mats.stall, local(z, sx * (U / 2 - 0.05), 1.0, -0.2), true);
          put(box(0.8, 1.6, 0.04), mats.stall, local(z, -0.35, 0.95, 0.6, 0.6), true);
          put(box(0.4, 0.4, 0.55), mats.porcelain, local(z, 0, 0.2, -0.55), true);
          put(box(0.45, 0.4, 0.18), mats.porcelain, local(z, 0, 0.55, -0.88));
        } else if (ch === "T" || ch === "Y") {
          const k = cellBase(x, y, angleOf(openDir(x, y)));
          put(box(0.56, 0.05, 0.44), mats.frame, local(k, 0, 0.025, 0));
          put(box(0.16, 1.0, 0.12), mats.kioskBody, local(k, 0, 0.55, -0.05), true);
          const head = local(k, 0, 1.18, 0, 0, -0.45);
          put(box(0.62, 0.44, 0.06), mats.kioskBody, head, true);
          const screen = placed(shapes.kioskScreen, ch === "T" ? mats.kiosk : mats.codeKiosk, local(head, 0, 0, 0.031));
          const door = ch === "Y" ? sources.findIndex((s) => s.x === x && s.y === y) : -1;
          stations.push({ x: x + 0.5, y: y + 0.5, kind: ch as "T" | "Y", done: false, door, screen, lamp: null });
        } else if (ch === "F") {
          const f = cellBase(x, y, angleOf(openDir(x, y)));
          put(box(0.9, 1.9, 0.45), mats.cabinet, local(f, 0, 0.95, 0), true);
          put(box(0.8, 1.7, 0.02), mats.cabinetDoor, local(f, 0, 0.95, 0.23));
          put(box(0.04, 0.3, 0.04), mats.metal, local(f, 0.3, 1.0, 0.26));
          put(box(0.4, 0.06, 0.012), mats.card, local(f, 0, 1.42, 0.245));
          const lamp = placed(box(0.12, 0.12, 0.03), mats.lampOff, local(f, 0, 1.68, 0.25));
          stations.push({ x: x + 0.5, y: y + 0.5, kind: "F", done: false, door: -1, screen: null, lamp });
        } else if (ch === "N") {
          const door = sources.findIndex((s) => s.x === x && s.y === y);
          notes.push({ x: x + 0.5, y: y + 0.5, door, read: false });
          addNote(x, y);
        } else if (ch === "D") addDoor(x, y);
        else if (ch === "C") addCamera(x, y);
        else if (ch === "=") addWire(x, y);
        else if (ch === "+" || ch === "I") addPickup(x, y, ch === "+" ? "medkit" : "intel");
        else if (ch === "A") addPickup(x, y, "locker");
        else if (ch === "G" || (ch === "g" && DIFFICULTIES[difficulty].extra)) pending.push([x + 0.5, y + 0.5, "patrol", officerType(index), null]);
        else if (ch === "H") pending.push([x + 0.5, y + 0.5, "post", officerType(index), null]);
        else if (ch === "J") pending.push([x + 0.5, y + 0.5, "post", "armored", "shotgun"]);
        else if (ch === "q") pending.push([x + 0.5, y + 0.5, "post", "armored", "shield"]);
        else if (ch === "E") pending.push([x + 0.5, y + 0.5, "patrol", "soldier", null]);
        else if (ch === "B") pending.push([x + 0.5, y + 0.5, "boss", "boss", null]);
        else if (ch === "P" || ch === "U") {
          const car = makeCar(x, y, ch === "U", carDir(x, y), false);
          if (ch === "P") {
            // A medkit waits just outside the doors on every arrival, so each stage starts with one.
            const [dx, dy] = carDir(x, y);
            for (const [ox, oy] of [[dx * 2 + dy, dy * 2 + dx], [dx * 2 - dy, dy * 2 - dx], [dx * 2, dy * 2], [dx * 3, dy * 3]]) {
              if (walkCell(x + ox, y + oy)) {
                addPickup(x + ox, y + oy, "medkit");
                break;
              }
            }
          }
          if (ch === "U" && index === 2) {
            // The laser grid the fuses feed, across the elevator doors.
            lasers = new THREE.Group();
            lasers.position.set(0, 0, 1.12);
            for (const hy of [0.35, 0.75, 1.15, 1.55, 1.95]) {
              const beam = new THREE.Mesh(box(1.2, 0.012, 0.012), mats.laser);
              beam.position.y = hy;
              lasers.add(beam);
            }
            for (const r of [0.95, -0.95]) {
              const beam = new THREE.Mesh(box(2.3, 0.012, 0.012), mats.laser);
              beam.position.y = 1.15;
              beam.rotation.z = r;
              lasers.add(beam);
            }
            car.node.add(lasers);
          }
        } else if (ch === "K") {
          keycardAt = { x: x + 0.5, y: y + 0.5 };
          const card = new THREE.Mesh(shapes.card, mats.card);
          card.position.set(px, 1.1, pz);
          keycardSpot = addSpot(ACCENT, 8, 6, px, 1.3, pz, 2);
          level.add(card);
          keycardNode = card;
        } else if (ch === "L") {
          const door = new THREE.Mesh(box(U, h, U * 0.2), mats.door);
          door.position.set(px, h / 2, pz);
          level.add(door);
          keyDoorNode = door;
          blockers.push(door);
        } else if (ch === "R") {
          rackAt = { x: x + 0.5, y: y + 0.5 };
          const rack = new THREE.Mesh(box(U * 0.7, 2.3, U * 0.6), mats.rack);
          rack.position.set(px, 1.15, pz);
          addSpot(ACCENT, 14, 8, px, h - 0.3, pz, 1.6);
          level.add(rack);
          blockers.push(rack);
        }
        // Cable trays over the operations desks.
        if (ch === "d" && index === 2) {
          put(box(U, 0.05, 0.4), mats.tray, local(c, 0, h - 0.32, 0));
          put(box(U, 0.06, 0.24), mats.cables, local(c, 0, h - 0.27, 0));
        }
      }
      yield [`Building floor ${index + 1}: ${y < 9 ? "walls and partitions" : y < 19 ? "desks and rooms" : "props and doors"}`, 0.05 + (0.6 * (y + 1)) / MAP_H];
    }

    // Guards (their patrol routes need the doors and elevators in place), then the staff.
    for (let i = 0; i < pending.length; i++) {
      const [gx, gy, kind, type, carries] = pending[i];
      const g = spawnGuard(gx, gy, kind, type);
      if (carries) g.carries = carries;
      if (carries === "shield") giveRiotShield(g);
      if (kind === "boss") boss = g;
      yield ["Placing guards", 0.66 + (0.08 * (i + 1)) / pending.length];
    }
    placeCivilians(index);
    yield ["Seating the staff", 0.75];
    yield ["Seating the staff", 0.76];

    // Dashboards on walls facing into rooms; near meeting tables first. The lobby gets its logo.
    const meeting: [number, number][] = [];
    let logoAt: [number, number] | null = null;
    for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) if (map[y][x] === "M") meeting.push([x, y]);
    const reception = map.flatMap((row, y) => [...row].map((ch, x) => [ch, x, y] as const)).filter(([ch]) => ch === "Q");
    if (index === 0 && reception.length) {
      const midX = reception.reduce((s, [, x]) => s + x, 0) / reception.length;
      const ry = reception[0][2];
      for (let y = ry - 1; y > 0; y--) {
        if (map[y][Math.round(midX)] === "X") {
          logoAt = [Math.round(midX), y];
          const logo = placed(shapes.logo, mats.logo, new THREE.Matrix4().setPosition((midX + 0.5) * U, h * 0.55, (y + 1) * U + 0.03));
          logo.renderOrder = 1;
          put(box(7.4, 0.02, 0.04), mats.ledWarm, new THREE.Matrix4().setPosition((midX + 0.5) * U, h * 0.55 + 1.05, (y + 1) * U + 0.03));
          break;
        }
      }
    }
    const candidates: [number, number, [number, number]][] = [];
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const ch = map[y][x];
        if (!(ch === "X" || (ch === "#" && !inside(x, y)))) continue;
        const f = N4.find(([dx, dy]) => cellAt(x + dx, y + dy) === "." && inside(x + dx, y + dy));
        if (!f) continue;
        if (logoAt && Math.abs(logoAt[0] - x) + Math.abs(logoAt[1] - y) < 6) continue;
        candidates.push([x, y, f]);
      }
    }
    const nearMeeting = (x: number, y: number) => (meeting.length ? Math.min(...meeting.map(([mx, my]) => Math.hypot(mx - x, my - y))) : 99);
    candidates.sort((a, b) => nearMeeting(a[0], a[1]) - nearMeeting(b[0], b[1]) || hash(a[0], a[1]) % 7 - (hash(b[0], b[1]) % 7));
    const screensAt: [number, number][] = [];
    for (const [x, y, f] of candidates) {
      if (screensAt.length >= 6) break;
      if (screensAt.some(([sx, sy]) => Math.abs(sx - x) + Math.abs(sy - y) < 8)) continue;
      screensAt.push([x, y]);
      const base = local(cellBase(x, y, angleOf(f)), 0, 0, U / 2);
      const at = Math.min(1.9, h - 1);
      put(box(1.62, 0.96, 0.05), mats.monitor, local(base, 0, at, 0.025), true);
      put(shapes.wallScreen, mats.wallScreens[(screensAt.length + index) % mats.wallScreens.length], local(base, 0, at, 0.052));
    }
    // Dropped ceilings with light panels over corridors and small rooms; open zones, the lobby atrium
    // and the video wall keep the full height.
    yield [`Building floor ${index + 1}: screens`, 0.78];
    const dropped = new Set<number>();
    // The lobby's dropped ceilings sit high under its double-height atrium; elsewhere they are 2.9 m.
    const dropH = index === 0 ? 4.4 : DROP_H;
    if (h > dropH + 0.1) {
      for (let y = 1; y < MAP_H - 1; y++) {
        for (let x = 1; x < MAP_W - 1; x++) {
          if ("#XWSVPUDLt".includes(map[y][x])) continue;
          let open = 0;
          let screen = false;
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const n = cellAt(x + dx, y + dy);
              if (n === "V") screen = true;
              if (!WALLISH.includes(n)) open++;
            }
          }
          if (screen || open >= 20) continue;
          const c = cellBase(x, y, 0);
          dropped.add(y * MAP_W + x);
          put(box(U, 0.06, U), fm.tile, local(c, 0, dropH + 0.03, 0), true);
          if ((x + y) % 2 === 0) put(box(1.2, 0.006, 0.6), mats.panel, local(c, 0, dropH - 0.002, 0));
        }
        if (y % 7 === 0) yield [`Building floor ${index + 1}: ceilings`, 0.8];
      }
    }

    yield [`Building floor ${index + 1}: ceilings and screens`, 0.84];
    yield* flushSteps();
    yield [`Building floor ${index + 1}: lights`, 0.92];

    // Floor and ceiling.
    const floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(MAP_W * U, MAP_H * U), fm.floor);
    floorMesh.rotation.x = -Math.PI / 2;
    floorMesh.position.set(cx, 0, cz);
    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(MAP_W * U, MAP_H * U), fm.ceiling);
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(cx, h, cz);
    level.add(floorMesh, ceiling);
    blockers.push(floorMesh, ceiling);
    perFloorDisposables.push(floorMesh.geometry, ceiling.geometry);

    // Lights spread over the open floor, plus each floor's own accents.
    const spots: [number, number][] = [];
    for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) if (walkCell(x, y) && x % 7 === 3 && y % 6 === 3) spots.push([x, y]);
    const every = Math.max(1, Math.ceil(spots.length / 9));
    const addLight = (color: number, power: number, distance: number, x: number, y: number, at: number) => {
      addSpot(color, power, distance, x * U, at, y * U, 1.4).lamp = true;
    };
    // Lights sit just under whichever ceiling is above them, well over head height.
    spots
      .filter((_, i) => i % every === 0)
      .slice(0, 9)
      .forEach(([x, y]) => addLight(theme.lamp, theme.lampPower, h * 5, x + 0.5, y + 0.5, dropped.has(y * MAP_W + x) ? dropH - 0.12 : h - 0.3));
    if (index === 2) for (const x of [14, 26]) addLight(0x3f7bff, 34, 16, x, 3, h - 0.5);
    if (index === 4) {
      addLight(0x4fe0ff, 18, 14, 20, 8, h - 0.3);
      addLight(0x4fe0ff, 18, 14, 33, 8, h - 0.3);
      addLight(0xff3b30, 7, 8, 29, 20, h - 0.35);
      // Cold mist low over the raised floor.
      const mist = new THREE.Mesh(shapes.mist, mats.mist);
      mist.rotation.x = -Math.PI / 2;
      mist.position.set(cx, 0.18, cz);
      mist.renderOrder = 2;
      level.add(mist);
    }

    floorDone = index === 0;
    // The rest happens when the built floor replaces the shown one (see swapIn).
    const t = theme;
    pendingSwap = {
      old,
      apply: () => {
        // Arrive in the elevator, doors shut, facing out.
        const arrival = cars.find((car) => !car.up);
        if (placePlayer && arrival) {
          const [x, y] = fromLocal(arrival.dir, 0.5, 0.42);
          player.x = Math.floor(arrival.x) + x;
          player.y = Math.floor(arrival.y) + y;
          player.yaw = carYaw(arrival);
          player.pitch = 0;
        }
        player.px = player.x;
        player.py = player.y;
        fog.color.setHex(t.fog);
        fog.near = t.fogNear;
        fog.far = t.fogFar;
        renderer.toneMappingExposure = t.exposure;
        hemi.color.setHex(t.sky);
        hemi.groundColor.setHex(t.ground);
        hemi.intensity = t.hemi + 0.12; // a little more sky light, as only the nearest lamps are lit
        city.position.y = -floorBase(index);
        onSwap?.();
      },
    };
  }

  type OldLevel = { group: THREE.Group; disposables: { dispose(): void }[]; helis: Heli[] };
  const addSpot = (color: number, intensity: number, distance: number, x: number, y: number, z: number, decay: number): LightSpot => {
    const spot: LightSpot = { pos: new THREE.Vector3(x, y, z), color: new THREE.Color(color), base: intensity, intensity, distance, decay, lamp: false };
    levelLights.push(spot);
    return spot;
  };
  // The pooled lights live in the scene, not the level, so every floor has the same number of lights.
  const pool = Array.from({ length: LIGHT_POOL }, () => {
    const light = new THREE.PointLight(0xffffff, 0, 10, 1.4);
    scene.add(light);
    return { light, spot: null as LightSpot | null, w: 0 };
  });
  let activeSpots: LightSpot[] = [];
  /** The nearest few spots, found without sorting or allocating (there are a few dozen at most). */
  const ranked: LightSpot[] = [];
  const rankScore: number[] = [];
  const pooled = (sp: LightSpot) => {
    for (const o of pool) if (o.spot === sp) return true;
    return false;
  };
  /** Gives the pooled lights to the spots nearest you, fading between them so nothing pops. */
  const updateLightPool = (dt: number, instant = false) => {
    const px = player.x * U;
    const pz = player.y * U;
    ranked.length = 0;
    rankScore.length = 0;
    for (const sp of activeSpots) {
      if (sp.intensity <= 0) continue;
      const score = (sp.pos.x - px) ** 2 + (sp.pos.z - pz) ** 2 - sp.distance * sp.distance * 0.2;
      let i = ranked.length;
      if (i === LIGHT_POOL && score >= rankScore[i - 1]) continue;
      if (i < LIGHT_POOL) {
        ranked.push(sp);
        rankScore.push(score);
      } else i--;
      while (i > 0 && rankScore[i - 1] > score) {
        ranked[i] = ranked[i - 1];
        rankScore[i] = rankScore[i - 1];
        i--;
      }
      ranked[i] = sp;
      rankScore[i] = score;
    }
    for (const slot of pool) {
      const keep = slot.spot !== null && ranked.includes(slot.spot);
      slot.w = instant ? (keep ? 1 : 0) : keep ? Math.min(1, slot.w + dt * 4) : Math.max(0, slot.w - dt * 4);
      if (!keep && slot.w === 0) {
        slot.spot = null;
        for (const sp of ranked) {
          if (pooled(sp)) continue;
          slot.spot = sp;
          slot.light.position.copy(sp.pos);
          slot.light.distance = sp.distance;
          slot.light.decay = sp.decay;
          if (instant) slot.w = 1;
          break;
        }
      }
      if (slot.spot) {
        slot.light.color.copy(slot.spot.color);
        slot.light.intensity = slot.spot.intensity * slot.w;
      } else slot.light.intensity = 0;
    }
  };

  /** A built level waiting to be shown, and what to do in the frame it is. */
  let pendingSwap: { old: OldLevel; apply: () => void } | null = null;
  const swapIn = () => {
    const p = pendingSwap;
    pendingSwap = null;
    if (!p) return;
    endLevel(p.old);
    p.apply();
    // The level's loose static meshes (screens, signs, the slab) stop recomputing their matrices.
    for (const o of level.children) {
      if (!(o as THREE.Mesh).isMesh || o === keycardNode || o === ropeNode) continue;
      o.updateMatrix();
      o.matrixAutoUpdate = false;
    }
    activeSpots = levelLights;
    for (const slot of pool) {
      slot.spot = null;
      slot.w = 0;
    }
    updateLightPool(0, true);
  };
  /** Starts a new level group (not shown yet) and resets the floor's state; the old group stays on screen. */
  const beginLevel = (): OldLevel => {
    const old: OldLevel = { group: level, disposables: perFloorDisposables.splice(0), helis };
    helis = [];
    onRoof = false;
    troop = null;
    extract = null;
    roofSpot = null;
    stairDoors = [];
    facade = [];
    windsock = null;
    ropeNode = null;
    heldCells.clear();
    flashbangs.length = 0;
    owner.clear();
    level = new THREE.Group();
    blockers.length = 0;
    camBodies.clear();
    carByCell.clear();
    doorByCell.clear();
    guards = [];
    civs = [];
    seats = [];
    stations = [];
    notes = [];
    doors = [];
    cams = [];
    wires = [];
    cars = [];
    pickups = [];
    flaps = [];
    levelLights = [];
    keycardSpot = null;
    keycardNode = keyDoorNode = badgeNode = lasers = null;
    keycardAt = badgeAt = rackAt = null;
    boss = null;
    hasKey = keyDoorOpen = gatesOpen = camsOff = floorDone = alarm = spottedOnce = false;
    holdAt = null;
    hold = 0;
    run = null;
    backupT = 0;
    finale = 0;
    finaleWave = 0;
    floorClock = 0;
    flowFrom = -1;
    return old;
  };
  /** Shows the new level and throws the old one away. */
  const endLevel = (old: OldLevel) => {
    scene.remove(old.group);
    old.group.traverse((o) => {
      if (o instanceof THREE.InstancedMesh) o.dispose();
    });
    for (const d of old.disposables) d.dispose();
    for (const h of old.helis) h.dispose();
    scene.add(level);
  };

  // ---- loading in slices, so the page keeps its frame rate ----
  let disposed = false;
  let loading = false;
  const ABORT = new Error("raid: stopped");
  const SLICE_MS = 6;
  const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const swallow = (e: unknown) => {
    if (e !== ABORT) console.error(e);
  };
  const drive = async (gen: Generator<[string, number], void, unknown>, onStep: (label: string, f: number) => void) => {
    let t0 = performance.now();
    for (;;) {
      const r = gen.next();
      if (r.done) return;
      onStep(r.value[0], r.value[1]);
      if (performance.now() - t0 > SLICE_MS) {
        await nextFrame();
        if (disposed) throw ABORT;
        t0 = performance.now();
      }
    }
  };
  /**
   * Compiles the shaders of the shown level and uploads its textures a piece at a time, so the first
   * frames after loading do not stutter. Each material is compiled once, on a mesh of its own: compiling
   * a group that holds a light would count that light twice and build the wrong shader.
   */
  const uploaded = new WeakSet<THREE.Texture>();
  /** Takes something off the floor without removing its light: a light coming or going would recompile every shader. */
  const stow = (node: THREE.Object3D) => {
    node.scale.setScalar(0.001);
    node.traverse((o) => {
      if ((o as THREE.PointLight).isLight) (o as THREE.PointLight).intensity = 0;
    });
  };
  const compileLevel = async (onStep?: (f: number) => void, extra: THREE.Object3D[] = [], target: THREE.Scene = scene) => {
    // Per call: the same material needs another shader when a floor has a different number of lights.
    const compiled = new Set<string>();
    const meshes: THREE.Object3D[] = [];
    for (const part of [...extra, ...level.children]) {
      part.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh && !(o as THREE.Line).isLine) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        const skinned = (o as THREE.SkinnedMesh).isSkinnedMesh;
        const key = materials.map((m) => m.uuid).join() + ((o as THREE.InstancedMesh).isInstancedMesh ? "i" : (o as THREE.Line).isLine ? "l" : skinned ? "s" : "m");
        if (compiled.has(key)) return;
        compiled.add(key);
        // A mesh with children is compiled on a copy of its own (a child light would count twice); a
        // skinned mesh needs its bones, which hold no lights.
        meshes.push(o.children.length && mesh.isMesh && !skinned ? new THREE.Mesh(mesh.geometry, mesh.material) : o);
      });
    }
    let t0 = performance.now();
    const pause = async () => {
      if (performance.now() - t0 <= SLICE_MS) return;
      await nextFrame();
      if (disposed) throw ABORT;
      t0 = performance.now();
    };
    for (let i = 0; i < meshes.length; i++) {
      const material = (meshes[i] as THREE.Mesh).material;
      for (const m of Array.isArray(material) ? material : [material]) {
        for (const key of ["map", "emissiveMap", "alphaMap"] as const) {
          const t = (m as THREE.MeshStandardMaterial)[key];
          if (t && !uploaded.has(t)) {
            uploaded.add(t);
            renderer.initTexture(t);
            await pause();
          }
        }
      }
      const shown = meshes[i].visible;
      meshes[i].visible = true; // compiling skips what is hidden (a muzzle flash, a weapon not in hand)
      await renderer.compileAsync(meshes[i], camera, target);
      meshes[i].visible = shown;
      if (disposed) throw ABORT;
      onStep?.((i + 1) / meshes.length);
      await pause();
    }
  };
  /**
   * Compiles the level that is built but not shown yet, on a stage with the same lights the scene will
   * have (the level's own, plus stand-ins for the sky light and the pistol's flash), so that showing it
   * compiles nothing.
   */
  const compileStaged = async (onStep?: (f: number) => void, extra: THREE.Object3D[] = []) => {
    const stage = new THREE.Scene();
    stage.fog = scene.fog;
    stage.environment = scene.environment;
    const standIns = [new THREE.HemisphereLight(), new THREE.PointLight(), ...pool.map(() => new THREE.PointLight())];
    stage.add(level, ...standIns);
    try {
      await compileLevel(onStep, [...extra, ...probes], stage);
      await nextFrame();
      if (disposed) throw ABORT;
      warmDraw(stage);
    } finally {
      stage.remove(level, ...standIns);
    }
  };
  /**
   * One of everything that can appear during play but is not in the level when it loads: your weapons,
   * every kind of character, the pooled effects, pickups and drops. Compiled with each level's lights, so
   * a rifle picked up, a soldier arriving or the first spark never builds a shader mid-fight.
   */
  const probes: THREE.Object3D[] = [];
  const makeProbes = () => {
    for (const id of WEAPON_IDS) {
      probes.push(guns[id].node);
      probes.push(makeWeaponPickup(id), makeAmmoBox(id));
    }
    const kinds: CharacterKind[] = ["officer", "armoredOfficer", "soldier", "boss"];
    for (let i = 0; i < kinds.length + CIVILIAN_VARIANTS; i++) {
      const c = i < kinds.length ? makeCharacter(kinds[i], 0) : makeCharacter("civilian", i - kinds.length);
      if (c.flash) c.flash.visible = true;
      probeChars.push(c);
      probes.push(c.root);
    }
    probes.push(new THREE.Mesh(box(0.56, 0.95, 0.05), mats.riot));
    probes.push(tracerLines, sparkMesh, casingMesh, fx.mesh, smoke.mesh, debris.mesh, new THREE.Mesh(box(0.1, 0.1, 0.1), mats.grenade));
  };
  const probeChars: Character[] = [];
  /**
   * Draws the staged level and every probe once, into a 1-pixel target, with nothing culled: the first
   * real frame then uploads no buffers and the driver has finished every shader variant (on Windows the
   * driver finishes some only at the first draw, which was a hitch of tens of milliseconds mid-fight).
   */
  const warmTarget = new THREE.WebGLRenderTarget(1, 1);
  const warmDraw = (stage: THREE.Scene) => {
    const loose = probes.filter((p) => !p.parent);
    stage.add(...loose);
    const saved: [THREE.Object3D, boolean, boolean][] = [];
    stage.traverse((o) => {
      saved.push([o, o.visible, o.frustumCulled]);
      o.visible = true;
      o.frustumCulled = false;
    });
    renderer.setRenderTarget(warmTarget);
    renderer.render(stage, camera);
    renderer.setRenderTarget(null);
    for (const [o, v, f] of saved) {
      o.visible = v;
      o.frustumCulled = f;
    }
    stage.remove(...loose);
  };
  const loadFloor = async (index: number, placePlayer: boolean, onSwap?: () => void) => {
    loading = true;
    try {
      await drive(floorSteps(index, placePlayer, onSwap), () => {});
      await compileStaged();
      swapIn();
    } finally {
      loading = false;
    }
  };
  const loadRoof = async (onSwap?: () => void) => {
    loading = true;
    try {
      await drive(roofSteps(), () => {});
      const old = pendingSwap!.apply;
      pendingSwap!.apply = () => {
        old();
        onSwap?.();
      };
      await compileStaged();
      swapIn();
    } finally {
      loading = false;
    }
  };

  // ---- the pieces of a floor ----
  /** A workstation; desks next to each other face across a low frosted divider. */
  const addDesk = (x: number, y: number, deskMat: THREE.Material) => {
    let partner: [number, number] | null = null;
    if (floorIndex !== 2) {
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as [number, number][]) {
        if (cellAt(x + dx, y + dy) === "d") {
          partner = [dx, dy];
          break;
        }
      }
    }
    let angle = 0; // operations: every desk faces the video wall to the north
    if (partner) angle = Math.atan2(-partner[0], -partner[1]);
    else if (floorIndex !== 2) {
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        if (walkCell(x + dx, y + dy)) {
          angle = Math.atan2(dx, dy);
          break;
        }
      }
    }
    const d = cellBase(x, y, angle);
    const hsh = hash(x, y + floorIndex * 97);
    put(box(1.6, 0.03, 0.8), deskMat, local(d, 0, 0.735, -0.55), true);
    for (const lx of [-0.76, 0.76]) for (const lz of [-0.9, -0.2]) put(box(0.035, 0.72, 0.035), mats.metal, local(d, lx, 0.36, lz));
    const laptop = hsh % 3 === 0;
    for (const side of [-1, 1]) {
      if (laptop && side === 1) continue;
      addMonitor(local(d, side * 0.29, 1.2, -0.8, -side * 0.18), mats.screens[(hsh + side + 3) % mats.screens.length]);
      put(box(0.03, 0.3, 0.02), mats.metal, local(d, side * 0.29, 0.9, -0.83));
      put(box(0.2, 0.012, 0.16), mats.metal, local(d, side * 0.29, 0.756, -0.82));
    }
    if (laptop) {
      put(box(0.32, 0.015, 0.22), mats.laptop, local(d, 0.42, 0.757, -0.42));
      const lid = local(local(d, 0.42, 0.765, -0.53, 0, -0.3), 0, 0.105, 0);
      put(box(0.32, 0.21, 0.008), mats.laptop, lid);
      put(shapes.laptopScreen, mats.screens[hsh % mats.screens.length], local(lid, 0, 0, 0.005));
    }
    put(box(0.44, 0.015, 0.14), mats.keyboard, local(d, laptop ? -0.15 : 0, 0.758, -0.38));
    put(box(0.06, 0.02, 0.1), mats.keyboard, local(d, laptop ? 0.15 : 0.32, 0.76, -0.36));
    const extra = hsh % 4;
    if (extra === 1 && floorIndex !== 0) addDeskLamp(d, -0.66, -0.85);
    else if (extra === 2) put(shapes.mug, mats.mug, local(d, -0.62, 0.8, -0.3));
    else if (extra === 3) {
      put(shapes.potSmall, mats.pot, local(d, -0.64, 0.81, -0.75));
      put(shapes.leavesSmall, mats.leaves, local(d, -0.64, 0.93, -0.75));
    }
    if (partner && (partner[0] > 0 || partner[1] > 0)) {
      put(box(1.6, 0.4, 0.025), mats.frost, local(d, 0, 0.95, -0.99));
      put(box(1.6, 0.02, 0.04), mats.metal, local(d, 0, 1.16, -0.99));
    }
    if (floorIndex === 2) put(box(U, 0.012, 0.03), mats.ledCool, local(d, 0, 0.01, 0.98)); // tier edge
    const seat = local(d, rand(-0.12, 0.12), 0, 0.22, rand(-0.35, 0.35));
    addChair(seat, false);
    seats.push({ m: seat, kind: "desk" });
  };
  /** An executive desk facing the room, a leather chair behind it, two visitor chairs. */
  const addExecDesk = (x: number, y: number, wood: THREE.Material) => {
    const d = cellBase(x, y, angleOf(openDir(x, y)));
    put(box(1.9, 0.05, 0.95), wood, local(d, 0, 0.75, 0), true);
    put(box(1.9, 0.7, 0.04), wood, local(d, 0, 0.37, 0.44), true);
    for (const side of [-1, 1]) put(box(0.04, 0.7, 0.9), wood, local(d, side * 0.93, 0.37, 0));
    addMonitor(local(d, 0, 1.12, 0.12, Math.PI), mats.screens[0]);
    put(box(0.03, 0.3, 0.02), mats.metal, local(d, 0, 0.92, 0.15));
    put(box(0.44, 0.015, 0.14), mats.keyboard, local(d, 0, 0.783, -0.2));
    addDeskLamp(d, 0.7, -0.1);
    const seat = local(d, 0, 0, -0.85, Math.PI + rand(-0.2, 0.2));
    addChair(seat, true);
    seats.push({ m: seat, kind: "exec" });
    for (const side of [-1, 1]) addChair(local(d, side * 0.45, 0, 0.82, rand(-0.3, 0.3)), false);
  };
  const addMeetingTable = (x: number, y: number, top: THREE.Material) => {
    const alongX = cellAt(x - 1, y) === "M" || cellAt(x + 1, y) === "M";
    const m = cellBase(x, y, alongX ? Math.PI / 2 : 0);
    put(box(1.3, 0.05, U), top, local(m, 0, 0.74, 0), true);
    put(box(0.12, 0.7, 0.8), mats.metal, local(m, 0, 0.36, 0));
    const exec = floorIndex === 3;
    for (const side of [-1, 1]) {
      const seat = local(m, side * 0.88, 0, 0, (side * Math.PI) / 2 + rand(-0.2, 0.2));
      addChair(seat, exec);
      seats.push({ m: seat, kind: "meeting" });
    }
    const front = alongX ? cellAt(x + 1, y) : cellAt(x, y + 1);
    const back = alongX ? cellAt(x - 1, y) : cellAt(x, y - 1);
    if (front !== "M") addChair(local(m, 0, 0, 0.88, rand(-0.2, 0.2)), exec);
    if (back !== "M") addChair(local(m, 0, 0, -0.88, Math.PI + rand(-0.2, 0.2)), exec);
    if (hash(x, y) % 2) put(box(0.3, 0.01, 0.22), mats.note, local(m, rand(-0.3, 0.3), 0.768, 0, rand(-0.5, 0.5)));
  };
  /** The reception counter: white front with a light line, a work desk behind, a screen and a chair in the middle. */
  const addReception = (x: number, y: number, deskMat: THREE.Material) => {
    const front: [number, number] = y < MAP_H / 2 ? [0, 1] : [0, -1];
    const q = cellBase(x, y, angleOf(front));
    put(box(U, 1.05, 0.55), mats.counter, local(q, 0, 0.525, 0.1), true);
    put(box(U, 0.04, 0.78), mats.counterTop, local(q, 0, 1.07, 0.06));
    put(box(U, 0.03, 0.012), mats.brass, local(q, 0, 0.9, 0.38));
    put(box(U, 0.03, 0.45), deskMat, local(q, 0, 0.74, -0.42));
    const sideX = Math.round(Math.cos(angleOf(front)));
    for (const s of [-1, 1]) if (cellAt(x + s * sideX, y) !== "Q") put(box(0.04, 1.05, 0.6), mats.counter, local(q, s * (U / 2 - 0.02) * (sideX || 1), 0.525, 0.1));
    let a = x;
    let b = x;
    while (cellAt(a - 1, y) === "Q") a--;
    while (cellAt(b + 1, y) === "Q") b++;
    if (x === Math.floor((a + b) / 2) || (x === a && b - a > 3)) {
      addMonitor(local(q, 0, 1.0, -0.36, Math.PI), mats.screens[2]);
      const seat = local(q, 0.2, 0, -0.85, Math.PI + rand(-0.3, 0.3));
      addChair(seat, false);
      seats.push({ m: seat, kind: "reception" });
    }
  };
  /** A sofa cell; a run of them faces its coffee table, or away from the wall behind it. */
  const addSofa = (x: number, y: number) => {
    const alongX = cellAt(x - 1, y) === "o" || cellAt(x + 1, y) === "o";
    const runCells: [number, number][] = [];
    if (alongX) {
      let a = x;
      while (cellAt(a - 1, y) === "o") a--;
      for (let i = a; cellAt(i, y) === "o"; i++) runCells.push([i, y]);
    } else {
      let a = y;
      while (cellAt(x, a - 1) === "o") a--;
      for (let i = a; cellAt(x, i) === "o"; i++) runCells.push([x, i]);
    }
    const options: [number, number][] = alongX ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]];
    const score = ([dx, dy]: [number, number]) =>
      runCells.reduce((s, [rx, ry]) => s + (cellAt(rx + dx, ry + dy) === "c" ? 10 : 0) + (WALLISH.includes(cellAt(rx - dx, ry - dy)) ? 3 : 0) + (walkCell(rx + dx, ry + dy) ? 1 : 0), 0);
    const f = score(options[0]) >= score(options[1]) ? options[0] : options[1];
    const a = angleOf(f);
    const s = cellBase(x, y, a);
    const fabric = floorIndex === 3 ? mats.leather : mats.fabric;
    put(box(U, 0.36, 0.86), fabric, local(s, 0, 0.2, 0), true);
    put(box(U * 0.98, 0.1, 0.66), floorIndex === 3 ? mats.leather : mats.cushion, local(s, 0, 0.42, 0.08));
    put(box(U, 0.48, 0.2), fabric, local(s, 0, 0.62, -0.33), true);
    const lx = Math.round(Math.cos(a));
    const ly = Math.round(-Math.sin(a));
    if (cellAt(x + lx, y + ly) !== "o") put(box(0.16, 0.6, 0.86), fabric, local(s, U / 2 - 0.08, 0.3, 0), true);
    if (cellAt(x - lx, y - ly) !== "o") put(box(0.16, 0.6, 0.86), fabric, local(s, -U / 2 + 0.08, 0.3, 0), true);
    if (hash(x, y) % 2) put(box(0.42, 0.34, 0.12), mats.pillow, local(s, rand(-0.5, 0.5), 0.62, -0.18, rand(-0.3, 0.3), -0.25));
    else seats.push({ m: local(s, rand(-0.3, 0.3), 0, 0.12, Math.PI), kind: "sofa" });
  };
  const addKitchen = (x: number, y: number) => {
    const k = cellBase(x, y, angleOf(frontAway(x, y)));
    put(box(U, 0.86, 0.62), mats.cabinetWhite, local(k, 0, 0.43, -0.66), true);
    put(box(U, 0.04, 0.68), mats.counterTop, local(k, 0, 0.88, -0.66));
    put(box(U, 0.7, 0.36), mats.cabinetWhite, local(k, 0, 1.95, -0.81));
    if (floorIndex !== 0) put(box(U, 0.01, 0.03), mats.ledWarm, local(k, 0, 1.595, -0.7));
    const v = x % 3;
    if (v === 0) {
      put(box(0.3, 0.42, 0.32), mats.frame, local(k, 0.4, 1.11, -0.75));
      put(box(0.06, 0.06, 0.01), mats.card, local(k, 0.4, 1.2, -0.585));
    } else if (v === 1) {
      put(box(0.5, 0.02, 0.36), mats.keyboard, local(k, -0.2, 0.905, -0.66));
      put(box(0.03, 0.25, 0.03), mats.metal, local(k, -0.2, 1.02, -0.86));
    } else put(box(0.5, 0.3, 0.36), mats.metal, local(k, 0.3, 1.05, -0.75));
  };
  /** A security gate: a steel pedestal with a status light, and glass flaps that fold away once open. */
  const addGate = (x: number, y: number) => {
    const alongX = "t#XW".includes(cellAt(x - 1, y)) || "t#XW".includes(cellAt(x + 1, y));
    const g = cellBase(x, y, alongX ? 0 : Math.PI / 2);
    const pedestal = (px: number) => {
      put(box(0.26, 1.0, 1.3), mats.steel, local(g, px, 0.5, 0), true);
      put(box(0.26, 0.012, 1.0), mats.gateLamp, local(g, px, 1.006, 0));
    };
    pedestal(-U / 2 + 0.13);
    const next = alongX ? cellAt(x + 1, y) : cellAt(x, y + 1);
    if (next !== "t") pedestal(U / 2 - 0.13);
    for (const px of [-U / 2 + 0.26 + 0.35, U / 2 - 0.26 - 0.35]) flaps.push(placed(box(0.7, 0.7, 0.02), mats.flap, local(g, px, 0.65, 0)));
  };
  /** A video wall: a dark frame full of screens, facing the room. */
  const addVideoWall = (x: number, y: number) => {
    const f = N4.find(([dx, dy]) => walkCell(x + dx, y + dy) || cellAt(x + dx, y + dy) === "d") ?? [0, 1];
    const v = cellBase(x, y, angleOf(f as [number, number]));
    const h = theme.h;
    put(box(U, h - 0.5, 0.12), mats.monitor, local(v, 0, 0.25 + (h - 0.5) / 2, U / 2 - 0.06), true);
    const rows = Math.floor((h - 0.9) / 0.62);
    const all = [...mats.screens, ...mats.wallScreens];
    for (let r = 0; r < rows; r++) {
      for (const col of [-0.5, 0.5]) put(shapes.videoWall, all[(x * 3 + r * 5 + (col > 0 ? 1 : 0)) % all.length], local(v, col, 0.75 + r * 0.62, U / 2 + 0.002));
    }
  };
  /** A sticky note on the desk or counter next to the cell, or on the wall. */
  const addNote = (x: number, y: number) => {
    const tops: Record<string, number> = { d: 0.752, e: 0.777, Q: 1.092, j: 0.902, M: 0.767 };
    const desk = N4.find(([dx, dy]) => cellAt(x + dx, y + dy) in tops);
    const note = new THREE.Mesh(shapes.note, mats.note);
    if (desk) {
      const [dx, dy] = desk;
      note.position.set((x + 0.5 + dx * 0.72) * U, tops[cellAt(x + dx, y + dy)], (y + 0.5 + dy * 0.72) * U);
      note.rotation.set(-Math.PI / 2, 0, rand(-0.4, 0.4));
    } else {
      const [dx, dy] = N4.find(([ddx, ddy]) => WALLISH.includes(cellAt(x + ddx, y + ddy))) ?? [0, -1];
      note.position.set((x + 0.5 + dx * 0.49) * U, 1.45, (y + 0.5 + dy * 0.49) * U);
      note.rotation.y = Math.atan2(-dx, -dy);
    }
    level.add(note);
  };
  /** A security door with a keypad on each side; its leaves slide into the wall once the code is right. */
  const addDoor = (x: number, y: number) => {
    const alongX = WALLISH.includes(cellAt(x - 1, y)) && WALLISH.includes(cellAt(x + 1, y));
    const g = cellBase(x, y, alongX ? 0 : Math.PI / 2);
    const h = theme.h;
    put(box(U, h - 2.3, U), floorMats?.solid ?? mats.frame, local(g, 0, 2.3 + (h - 2.3) / 2, 0), true);
    for (const s of [-1, 1]) put(box(0.1, 2.3, U), mats.steel, local(g, s * (U / 2 - 0.05), 1.15, 0), true);
    const node = new THREE.Group();
    g.decompose(node.position, node.quaternion, node.scale);
    level.add(node);
    const leaves = [-1, 1].map((s) => {
      const leaf = new THREE.Mesh(box(0.95, 2.3, 0.08), mats.secDoor);
      leaf.position.set(s * 0.475, 1.15, 0);
      node.add(leaf);
      blockers.push(leaf);
      return leaf;
    });
    const lamp = new THREE.MeshBasicMaterial({ color: CORAL, toneMapped: false });
    perFloorDisposables.push(lamp);
    for (const s of [-1, 1]) {
      const pad = new THREE.Mesh(box(0.16, 0.24, 0.04), mats.keypad);
      pad.position.set(s * 1.3, 1.3, s * 1.02);
      const light = new THREE.Mesh(box(0.06, 0.03, 0.02), lamp);
      light.position.set(s * 1.3, 1.46, s * 1.03);
      node.add(pad, light);
    }
    const i = doors.length;
    const door: Door = { x: x + 0.5, y: y + 0.5, cell: y * MAP_W + x, code: codes[floorIndex][i] ?? "0000", known: false, open: false, t: 0, leaves, lamp, wrong: 0 };
    doors.push(door);
    doorByCell.set(door.cell, door);
  };
  /** A camera on the wall next to the cell: it sweeps, and its cone shows where it looks. */
  const addCamera = (x: number, y: number) => {
    const [dx, dy] = N4.find(([ddx, ddy]) => WALLISH.includes(cellAt(x + ddx, y + ddy))) ?? [0, -1];
    const mx = x + 0.5 + dx * 0.45;
    const my = y + 0.5 + dy * 0.45;
    const mountH = Math.min(theme.h - 0.35, DROP_H - 0.2);
    const base = Math.atan2(-dy, -dx);
    const head = new THREE.Group();
    head.position.set(mx * U, mountH, my * U);
    level.add(head);
    const arm = new THREE.Mesh(box(0.05, 0.05, 0.3), mats.frame);
    arm.position.set(dx * 0.12 * U, 0.05, dy * 0.12 * U);
    arm.rotation.y = Math.atan2(dx, dy);
    level.add(arm);
    arm.position.add(head.position);
    const body = new THREE.Mesh(box(0.16, 0.13, 0.34), mats.camBody);
    const lens = new THREE.Mesh(box(0.09, 0.09, 0.03), mats.keyboard);
    lens.position.z = -0.18;
    const led = new THREE.Mesh(box(0.025, 0.025, 0.025), mats.camLed);
    led.position.set(0.05, 0.08, -0.1);
    const pitch = new THREE.Group();
    const reach = CAM_RANGE * U * 0.85;
    pitch.rotation.x = -Math.atan(mountH / reach);
    const cone = new THREE.Mesh(shapes.cone, mats.coneIdle);
    const len = Math.hypot(mountH, reach);
    cone.scale.set(Math.tan(CAM_FOV) * len, Math.tan(CAM_FOV) * len, len);
    pitch.add(cone);
    head.add(body, lens, led, pitch);
    blockers.push(body);
    const cam: Cam = { mx, my, sx: x + 0.5, sy: y + 0.5, base, yaw: base, amp: 0.75, speed: rand(0.45, 0.7), phase: rand(0, 6), t: 0, head, cone, led, seen: 0, sees: false, dead: false };
    cams.push(cam);
    camBodies.set(body, cam);
  };
  const addWire = (x: number, y: number) => {
    const blocks = (cx2: number, cy2: number) => !walkCell(cx2, cy2);
    const alongX = blocks(x - 1, y) && blocks(x + 1, y);
    const g = cellBase(x, y, alongX ? 0 : Math.PI / 2);
    const beam = placed(box(U, 0.014, 0.014), mats.laser, local(g, 0, WIRE_HEIGHT, 0));
    for (const s of [-1, 1]) put(box(0.08, 0.14, 0.08), mats.frame, local(g, s * (U / 2 - 0.04), WIRE_HEIGHT, 0));
    wires.push({ x, y, alongX, beam, flash: 0 });
  };
  /**
   * Something to pick up: a medkit, intel, an ammo locker (a crate of ammunition for everything you carry),
   * a weapon on a crate, or an ammo box someone dropped (at, in cells, for those).
   */
  const addPickup = (x: number, y: number, kind: PickupKind, at?: Spot, ammo?: AmmoType) => {
    const node = new THREE.Group();
    const px = at ? at.x : x + 0.5;
    const py = at ? at.y : y + 0.5;
    node.position.set(px * U, 0, py * U);
    let spot: LightSpot | null = null;
    let lift = 0.45;
    if (kind === "medkit") {
      node.add(new THREE.Mesh(box(0.42, 0.26, 0.3), mats.medkit));
      for (const [w, d] of [[0.22, 0.07], [0.07, 0.22]]) {
        const top = new THREE.Mesh(box(w, 0.012, d), mats.cross);
        top.position.y = 0.136;
        node.add(top);
      }
      for (const z of [0.156, -0.156]) {
        for (const [w, hh] of [[0.16, 0.05], [0.05, 0.16]]) {
          const side = new THREE.Mesh(box(w, hh, 0.012), mats.cross);
          side.position.z = z;
          node.add(side);
        }
      }
    } else if (kind === "intel") {
      node.add(new THREE.Mesh(box(0.34, 0.05, 0.26), mats.intel));
      node.add(new THREE.Mesh(box(0.34, 0.052, 0.04), mats.card));
      spot = addSpot(0xff8a5a, 4, 4, px * U, 0.6, py * U, 2);
    } else if (kind === "ammo") {
      lift = 0;
      const item = makeAmmoBox(ammo === "rifle" ? "rifle" : ammo === "shell" ? "shotgun" : "pistol");
      item.scale.setScalar(1.8);
      node.add(item);
    } else if (at) {
      // A weapon someone dropped, on the floor where he fell.
      lift = 0;
      const item = makeWeaponPickup(kind as WeaponId);
      item.scale.setScalar(1.4);
      node.add(item);
    } else {
      // On a steel crate: an ammunition locker, or a weapon.
      lift = 0;
      put(box(0.8, 0.5, 0.55), mats.cabinet, new THREE.Matrix4().makeTranslation(px * U, 0.25, py * U), true);
      put(box(0.82, 0.03, 0.57), mats.secDoor, new THREE.Matrix4().makeTranslation(px * U, 0.515, py * U));
      const item = kind === "locker" ? makeAmmoBox("rifle") : makeWeaponPickup(kind as WeaponId);
      item.position.y = 0.53;
      if (kind === "locker") item.scale.setScalar(2.2);
      node.add(item);
      spot = addSpot(kind === "locker" ? 0x9fd4ff : ACCENT, kind === "locker" ? 3 : 7, 5, px * U, 1.4, py * U, 2);
    }
    level.add(node);
    pickups.push({ kind, at: { x: px, y: py }, node, taken: false, spot, ammo: ammo ?? null, lift, phase: rand(0, 6) });
  };
  /**
   * What someone leaves where he fell. The weapon he carried, if you do not have one (soldiers and the head
   * of security their rifle, some officers in plates a shotgun, the riot officer his shield); otherwise
   * his ammunition: rifle rounds from the army, pistol rounds (now and then shells) from officers.
   */
  const dropLoot = (g: Guard) => {
    if (g.shield) {
      g.shield.removeFromParent();
      g.shield = null;
    }
    const at = { x: g.x, y: g.y };
    if (g.carries && (!inv.owned[g.carries] || g.type === "soldier" || g.type === "boss" || Math.random() < 0.5)) {
      addPickup(0, 0, g.carries as PickupKind, at);
      return;
    }
    let drops = 0;
    for (const p of pickups) if (p.kind === "ammo" && !p.taken) drops++;
    if (drops >= MAX_DROPS) return;
    const army = g.type === "soldier" || g.type === "boss";
    if (Math.random() > (army ? 0.85 : 0.6)) return;
    const ammo: AmmoType = army ? "rifle" : inv.owned.shotgun && Math.random() < 0.3 ? "shell" : "pistol";
    addPickup(0, 0, "ammo", at, ammo);
  };
  /** A riot officer's shield: on his left forearm, in front of him. */
  const giveRiotShield = (g: Guard) => {
    const shield = new THREE.Mesh(box(0.56, 0.95, 0.05), mats.riot);
    shield.position.set(0.12, -0.18, 0.2);
    g.ch.bones[5].add(shield);
    g.shield = shield;
    owner.set(shield, g);
  };

  /** An elevator: a steel shaft in the wall, sliding doors, a call panel and a floor indicator. */
  const makeCar = (x: number, y: number, up: boolean, dir: [number, number], roof: boolean): Car => {
    const angle = angleOf(dir);
    const base = cellBase(x, y, angle);
    const h = theme.h;
    put(box(2, h, 0.1), mats.steel, local(base, 0, h / 2, -0.95), true);
    for (const s of [-1, 1]) {
      put(box(0.1, h, 2), mats.steel, local(base, s * 0.95, h / 2, 0), true);
      put(box(0.45, h, 0.1), mats.steel, local(base, s * 0.775, h / 2, 0.95), true);
      put(box(0.04, 0.04, 1.5), mats.metal, local(base, s * 0.86, 0.95, -0.05));
    }
    put(box(1.1, h - 2.3, 0.1), mats.steel, local(base, 0, 2.3 + (h - 2.3) / 2, 0.95), true);
    put(box(1.9, 0.02, 1.9), mats.carFloor, local(base, 0, 0.01, 0));
    put(box(1.9, 0.05, 1.9), mats.carFloor, local(base, 0, CAR_H, 0), true);
    put(box(1.3, 0.02, 1.3), mats.ledWarm, local(base, 0, CAR_H - 0.035, 0));
    put(box(1.6, 0.04, 0.04), mats.metal, local(base, 0, 0.95, -0.86));
    const node = new THREE.Group();
    base.decompose(node.position, node.quaternion, node.scale);
    level.add(node);
    const doorsM = [-1, 1].map((s) => {
      const leaf = new THREE.Mesh(box(0.56, 2.3, 0.04), mats.carDoor);
      leaf.position.set(s * 0.28, 1.15, 0.88);
      node.add(leaf);
      blockers.push(leaf);
      return leaf;
    });
    const arrow = new THREE.MeshBasicMaterial({ color: CORAL, toneMapped: false });
    const plate = new THREE.Mesh(box(0.14, 0.26, 0.02), mats.frame);
    plate.position.set(0.78, 1.2, 1.01);
    const arrowMesh = new THREE.Mesh(shapes.arrow, arrow);
    arrowMesh.position.set(0.78, 1.22, 1.022);
    if (!up && !roof) arrowMesh.rotation.z = Math.PI;
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 48;
    const ctx = canvas.getContext("2d")!;
    const indicatorTex = new THREE.CanvasTexture(canvas);
    indicatorTex.colorSpace = THREE.SRGBColorSpace;
    const indicatorMat = new THREE.MeshBasicMaterial({ map: indicatorTex, toneMapped: false });
    perFloorDisposables.push(arrow, indicatorTex, indicatorMat);
    const frame = new THREE.Mesh(box(0.52, 0.2, 0.02), mats.frame);
    frame.position.set(0, 2.55, 1.01);
    const outside = new THREE.Mesh(shapes.indicator, indicatorMat);
    outside.position.set(0, 2.55, 1.022);
    const within = new THREE.Mesh(shapes.indicator, indicatorMat);
    within.position.set(0, 2.55, 0.895);
    within.rotation.y = Math.PI;
    addSpot(0xfff0dc, 1.6, 2.6, (x + 0.5) * U, CAR_H - 0.25, (y + 0.5) * U, 2);
    node.add(plate, arrowMesh, frame, outside, within);
    const car: Car = {
      x: x + 0.5,
      y: y + 0.5,
      cell: y * MAP_W + x,
      dir,
      up,
      roof,
      node,
      doors: doorsM,
      open: 0,
      arrow,
      ctx,
      tex: indicatorTex,
      shown: "",
      call: -1,
      walls: orientRects(CAR_WALLS, dir),
      closed: orientRects([...CAR_WALLS, ...CAR_DOOR], dir),
    };
    carByCell.set(car.cell, car);
    cars.push(car);
    return car;
  };
  const drawIndicator = (car: Car, text: string, moving: boolean) => {
    const key = `${text}${moving}`;
    if (car.shown === key) return;
    car.shown = key;
    const c = car.ctx;
    c.fillStyle = "#07080c";
    c.fillRect(0, 0, 128, 48);
    c.fillStyle = "#ffb81f";
    c.font = "700 30px monospace";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(text, 76, 26);
    if (moving) {
      c.beginPath();
      c.moveTo(30, 12);
      c.lineTo(42, 32);
      c.lineTo(18, 32);
      c.closePath();
      c.fill();
    }
    car.tex.needsUpdate = true;
  };

  const spawnCiv = (x: number, y: number, yaw: number, sit: boolean, act: Civ["act"]) => {
    const ch = makeCharacter("civilian", Math.floor(Math.random() * CIVILIAN_VARIANTS));
    ch.root.position.set(x * U, 0, y * U);
    level.add(ch.root);
    perFloorDisposables.push(ch);
    const civ: Civ = { x, y, ch, ps: { pose: "idle", sit }, node: ch.root, sit, act, yaw, t: rand(0, 10), state: "calm", fleeFor: 0, witness: 0, dying: 0 };
    for (const h of ch.hit.all) owner.set(h, civ);
    civs.push(civ);
  };
  /** How many staff are in at night, per floor. */
  const CIV_MAX = [14, 18, 14, 12, 6];
  /**
   * Staff where they would be: the reception, executives, a meeting or two, people at their desks and on
   * the sofas, at the water cooler and the kitchen, at the copier, the racks and the whiteboards, and a few
   * pairs talking in the open.
   */
  const placeCivilians = (index: number) => {
    const max = CIV_MAX[index];
    const take = <T,>(list: T[]) => list.splice(Math.floor(Math.random() * list.length), 1)[0];
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const euler = new THREE.Euler(0, 0, 0, "YXZ");
    const used = new Set<number>();
    const seated = (m: THREE.Matrix4, act: Civ["act"]) => {
      if (civs.length >= max) return;
      m.decompose(pos, quat, scale);
      euler.setFromQuaternion(quat, "YXZ");
      used.add(Math.floor(pos.z / U) * MAP_W + Math.floor(pos.x / U));
      spawnCiv(pos.x / U, pos.z / U, euler.y + Math.PI, true, act);
    };
    const of = (kind: string) => seats.filter((st) => st.kind === kind);
    for (const r of of("reception")) seated(r.m, "type");
    for (const e of of("exec")) seated(e.m, "type");
    // Meetings: two tables at most, three or four around each.
    const meeting = of("meeting");
    for (let t = 0; t < 2 && meeting.length >= 2; t++) {
      const a = take(meeting);
      const at = new THREE.Vector3().setFromMatrixPosition(a.m);
      meeting.sort((p, q) => new THREE.Vector3().setFromMatrixPosition(p.m).distanceTo(at) - new THREE.Vector3().setFromMatrixPosition(q.m).distanceTo(at));
      seated(a.m, "talk");
      for (let k = 0; k < 2 + (t === 0 ? 1 : 0) && meeting.length; k++) {
        if (new THREE.Vector3().setFromMatrixPosition(meeting[0].m).distanceTo(at) > U * 2.2) break;
        seated(meeting.shift()!.m, "talk");
      }
    }
    const sofas = of("sofa");
    for (let i = 0; i < 2 && sofas.length; i++) seated(take(sofas).m, "talk");
    const desks = of("desk");
    while (desks.length && civs.length < max - 5) seated(take(desks).m, "type");
    // Standing next to something.
    const standBy = (chars: string, act: Civ["act"]) => {
      if (civs.length >= max) return;
      const spots: [number, number, number][] = [];
      for (let y = 1; y < MAP_H - 1; y++) {
        for (let x = 1; x < MAP_W - 1; x++) {
          if (!chars.includes(map[y][x])) continue;
          for (const [dx, dy] of N4) if (map[y + dy][x + dx] === "." && !used.has((y + dy) * MAP_W + x + dx)) spots.push([x + dx, y + dy, Math.atan2(-dx, -dy)]);
        }
      }
      if (!spots.length) return;
      const [x, y, yaw] = take(spots);
      used.add(y * MAP_W + x);
      spawnCiv(x + 0.5, y + 0.5, yaw, false, act);
    };
    standBy("a", "sip");
    standBy("j", "sip");
    standBy("j", "talk");
    standBy("n", "work");
    standBy("k", "work");
    standBy("b", "talk");
    standBy("f", "work");
    // Pairs talking in the open, away from the elevators.
    for (let tries = 0; tries < 60 && civs.length < max - 1; tries++) {
      const x = 2 + Math.floor(Math.random() * (MAP_W - 4));
      const y = 2 + Math.floor(Math.random() * (MAP_H - 4));
      if (map[y][x] !== "." || map[y][x + 1] !== "." || used.has(y * MAP_W + x) || used.has(y * MAP_W + x + 1)) continue;
      if (cars.some((c) => Math.hypot(c.x - x, c.y - y) < 4)) continue;
      used.add(y * MAP_W + x);
      used.add(y * MAP_W + x + 1);
      spawnCiv(x + 0.75, y + 0.5, Math.PI / 2, false, "talk");
      spawnCiv(x + 1.35, y + 0.5, -Math.PI / 2, false, "talk");
    }
  };
  /** Officers on this floor wear plates now and then; more of them higher up and on Hard. */
  const officerType = (index: number): EnemyType => (Math.random() < ARMOUR_SHARE[index] * DIFFICULTIES[difficulty].armour ? "armored" : "officer");
  const CHAR_KIND: Record<EnemyType, CharacterKind> = { officer: "officer", armored: "armoredOfficer", soldier: "soldier", boss: "boss" };
  const spawnGuard = (x: number, y: number, kind: Guard["kind"], type: EnemyType = "officer") => {
    const ch = makeCharacter(CHAR_KIND[type]);
    ch.root.position.set(x * U, 0, y * U);
    level.add(ch.root);
    perFloorDisposables.push(ch);
    const start = Math.floor(y) * MAP_W + Math.floor(x);
    const route: number[] = [];
    if (kind === "patrol") {
      const d = distances(start);
      const far: number[] = [];
      for (let i = 0; i < d.length; i++) if (d[i] >= 5 && d[i] <= 14) far.push(i);
      for (let k = 0; k < 2 && far.length; k++) route.push(far.splice(Math.floor(Math.random() * far.length), 1)[0]);
      route.push(start);
    }
    const facing = angleOf(openDir(Math.floor(x), Math.floor(y)));
    const hunter = kind === "hunter";
    const stats = ENEMY[type];
    const guard: Guard = {
      kind,
      type,
      stats,
      x,
      y,
      z: 0,
      ch,
      ps: { pose: "idle", aim: false, recoil: 0, stagger: 0, fall: 0, reload: 0, hitDir: 0, look: 0 },
      node: ch.root,
      health: stats.health,
      maxHealth: stats.health,
      mag: stats.mag,
      burstLeft: 0,
      burstT: 0,
      reloading: 0,
      role: Math.random() < stats.flank ? "flank" : "push",
      flankFor: 0,
      lastX: x,
      lastY: y,
      lastSeen: 99,
      flashT: 0,
      rope: 0,
      stage: 0,
      seenOnce: false,
      crouch: 0,
      carries: type === "soldier" || type === "boss" ? "rifle" : type === "armored" && Math.random() < 0.35 ? "shotgun" : null,
      shield: null,
      alert: hunter,
      sees: false,
      suspicion: 0,
      chase: hunter ? Infinity : 0,
      heading: facing,
      postAngle: facing,
      look: rand(0, 6),
      route,
      routeAt: 0,
      path: [],
      wait: rand(0, 2),
      cover: null,
      coverFor: 0,
      stagger: 0,
      reload: hunter ? rand(1, 2) : rand(0.4, 1.4),
      hurt: 0,
      dying: 0,
      walk: 0,
      strafe: 1,
      strafeFor: 0,
      skip: 0,
    };
    ch.root.rotation.y = facing;
    for (const h of ch.hit.all) owner.set(h, guard);
    guards.push(guard);
    return guard;
  };

  // ---- the roof: the last stand ----
  /** The roof: parapets, the stair and lift housings, air conditioning and vents to hide behind, a water tank, the helipad. */
  function* roofSteps(): Generator<[string, number], void, unknown> {
    const old = beginLevel();
    theme = ROOF_THEME;
    map = ROOF_MAP;
    computeRects();
    tex.roof.repeat.set(20, 14);
    const slab = new THREE.Mesh(box(MAP_W * U, 0.5, MAP_H * U), mats.roof);
    slab.position.set(cx, -0.25, cz);
    level.add(slab);
    blockers.push(slab);
    // The tower under the roof, seen from the helicopter at the end: lit window bands for the five floors
    // you came up through, plain lit glass below them down to the street.
    {
      const depth = floorBase(FLOORS.length) + 72;
      const lower = tex.towers[1].clone();
      lower.repeat.set(10, 18);
      lower.needsUpdate = true;
      const band = tex.towers[0].clone();
      band.repeat.set(14, 1);
      band.needsUpdate = true;
      const shaftMat = new THREE.MeshBasicMaterial({ map: lower, color: 0x9aa4b8 });
      perFloorDisposables.push(lower, band, shaftMat);
      const shaft = new THREE.Mesh(box(MAP_W * U, depth, MAP_H * U), shaftMat);
      shaft.position.set(cx, -0.5 - depth / 2, cz);
      level.add(shaft);
      for (let i = 0; i < FLOORS.length; i++) {
        const h = THEMES[i].h;
        const m = new THREE.MeshBasicMaterial({ map: band, color: 0xffe2b8, toneMapped: false });
        perFloorDisposables.push(m);
        const b = new THREE.Mesh(box(MAP_W * U + 0.3, h - 0.9, MAP_H * U + 0.3), m);
        b.position.set(cx, -floorBase(FLOORS.length) + floorBase(i) + 0.45 + (h - 0.9) / 2 - 0.5, cz);
        level.add(b);
        facade.push({ mat: m, y: b.position.y, h: h - 0.9 });
      }
    }
    const isV = (x: number, y: number) => cellAt(x, y) === "v";
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const ch = map[y][x];
        const c = cellBase(x, y, 0);
        if (ch === "W") {
          put(box(U, 1.1, U), mats.parapet, local(c, 0, 0.55, 0), true);
          put(box(U, 0.06, U * 1.06), mats.metal, local(c, 0, 1.13, 0));
        } else if (ch === "X") {
          if (x >= 33 && x <= 35 && y >= 2 && y <= 4) continue; // the water tank, below
          put(box(U, 3.4, U), mats.housing, local(c, 0, 1.7, 0), true);
          put(box(U, 0.12, U), mats.frame, local(c, 0, 3.46, 0));
        } else if (ch === "v") {
          if (isV(x - 1, y) || isV(x + 1, y) || isV(x, y - 1) || isV(x, y + 1)) {
            // An air conditioning unit: a cabinet with a fan grille on top and a vent on its side.
            put(box(U * 0.96, 1.35, U * 0.96), mats.filing, local(c, 0, 0.675, 0), true);
            put(box(U * 0.7, 0.05, U * 0.7), mats.frame, local(c, 0, 1.375, 0));
            put(box(0.5, 0.06, 0.5), mats.metal, local(c, 0, 1.41, 0, hash(x, y) % 3));
            put(box(U * 0.8, 0.5, 0.02), mats.chairMesh, local(c, 0, 0.6, U * 0.48));
          } else {
            // A vent: a stack with a hood.
            put(box(0.9, 1.0, 0.9), mats.metal, local(c, 0, 0.5, 0), true);
            put(box(1.3, 0.08, 1.3), mats.metal, local(c, 0, 1.15, 0), true);
            put(box(0.7, 0.12, 0.7), mats.frame, local(c, 0, 1.25, 0));
          }
        } else if (ch === "y") {
          const [dx, dy] = N4.find(([ddx, ddy]) => cellAt(x + ddx, y + ddy) === "X") ?? [0, -1];
          const face = cellBase(x, y, Math.atan2(-dx, -dy));
          put(box(1.4, 2.4, 0.1), mats.frame, local(face, 0, 1.2, -U / 2 - 0.02));
          put(box(0.5, 0.18, 0.06), mats.lampOn, local(face, 0, 2.55, -U / 2 + 0.02));
          const hinge = new THREE.Group();
          face.decompose(hinge.position, hinge.quaternion, hinge.scale);
          const pivot = new THREE.Group();
          pivot.position.set(-0.55, 0, -U / 2 + 0.04);
          hinge.add(pivot);
          const leaf = new THREE.Mesh(box(1.1, 2.2, 0.06), mats.carDoor);
          leaf.position.set(0.55, 1.1, 0);
          pivot.add(leaf);
          level.add(hinge);
          stairDoors.push({ x: x + 0.5, y: y + 0.5, node: pivot, open: 0 });
          addSpot(0xffe2b0, 10, 9, (x + 0.5) * U, 2.9, (y + 0.5) * U, 1.6);
        } else if (ch === "+") addPickup(x, y, "medkit");
        else if (ch === "P") {
          // As on every floor, a medkit waits just outside the doors on arrival.
          const [dx, dy] = carDir(x, y);
          if (walkCell(x + dx * 2, y + dy * 2)) addPickup(x + dx * 2, y + dy * 2, "medkit");
        }
      }
      if (y % 7 === 0) yield ["Building the roof", 0.1 + (0.5 * y) / MAP_H];
    }
    // The water tank on its legs.
    const tankGeo = new THREE.CylinderGeometry(2.3, 2.3, 3.2, 20);
    perFloorDisposables.push(tankGeo);
    const tank = new THREE.Mesh(tankGeo, mats.tank);
    tank.position.set(34.5 * U, 2.0 + 1.6, 3.5 * U);
    level.add(tank);
    blockers.push(tank);
    for (const [lx, lz] of [[-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]]) put(box(0.22, 2.0, 0.22), mats.frame, new THREE.Matrix4().makeTranslation(34.5 * U + lx, 1.0, 3.5 * U + lz), true);
    put(box(5.4, 0.1, 5.4), mats.frame, new THREE.Matrix4().makeTranslation(34.5 * U, 2.0, 3.5 * U));
    // The helipad and its edge lights, a windsock, the antenna mast.
    const pad = new THREE.Mesh(shapes.helipad, mats.helipad);
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(PAD.x * U, 0.02, PAD.y * U);
    level.add(pad);
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      put(box(0.22, 0.08, 0.22), i % 2 ? mats.lampOn : mats.ledWarm, new THREE.Matrix4().makeTranslation(PAD.x * U + Math.cos(a) * 7.3, 0.05, PAD.y * U + Math.sin(a) * 7.3));
    }
    put(box(0.08, 3.2, 0.08), mats.metal, new THREE.Matrix4().makeTranslation(35.5 * U, 1.6, 20.5 * U));
    windsock = new THREE.Group();
    windsock.position.set(35.5 * U, 3.1, 20.5 * U);
    const sock = new THREE.Mesh(shapes.cone, mats.sock);
    sock.scale.set(0.28, 0.28, 1.5);
    sock.rotation.y = Math.PI;
    windsock.add(sock);
    level.add(windsock);
    put(box(0.15, 9, 0.15), mats.metal, new THREE.Matrix4().makeTranslation(39 * U - 0.3, 4.5, 27 * U - 0.3));
    put(box(0.25, 0.25, 0.25), mats.camLed, new THREE.Matrix4().makeTranslation(39 * U - 0.3, 9.1, 27 * U - 0.3));
    // Floodlights: the helipad, the lift housing.
    addSpot(0xffd9a8, 22, 22, PAD.x * U - 6, 4, PAD.y * U - 6, 1.5);
    addSpot(0xffd9a8, 22, 22, PAD.x * U + 6, 4, PAD.y * U + 6, 1.5);
    addSpot(0xffd9a8, 14, 14, 5 * U, 3.6, 13.5 * U, 1.6);
    addSpot(0xffd9a8, 12, 16, 12 * U, 3.6, 5 * U, 1.6);
    addSpot(0xffd9a8, 12, 16, 12 * U, 3.6, 22 * U, 1.6);
    makeCar(2, 13, false, carDir(2, 13), true);
    yield ["Building the roof", 0.65];
    yield* flushSteps();
    // The two helicopters, out of sight for now, and the searchlight that rides with whichever is close.
    const troopH = makeHelicopter(true);
    const extractH = makeHelicopter(false);
    for (const h of [troopH, extractH]) {
      h.node.position.set(cx + 400, 60, cz);
      level.add(h.node);
      helis.push(h);
    }
    troop = { h: troopH, state: "wait", t: 0, dropped: 0 };
    extract = { h: extractH, state: "wait", t: 0 };
    roofSpot = new THREE.SpotLight(0xfff3d0, 160, 70, 0.3, 0.5, 1.2);
    troopH.mount.add(roofSpot);
    const target = new THREE.Object3D();
    level.add(target);
    roofSpot.target = target;
    ropeNode = new THREE.Mesh(box(0.11, 1, 0.11), mats.rope);
    ropeNode.visible = false;
    level.add(ropeNode);
    yield ["Building the roof", 0.95];
    pendingSwap = {
      old,
      apply: () => {
        fog.color.setHex(NIGHT);
        fog.near = 40;
        fog.far = 300;
        renderer.toneMappingExposure = 1.05;
        hemi.color.setHex(0x8fa4d8);
        hemi.groundColor.setHex(0x101018);
        hemi.intensity = 0.85;
        city.position.y = -floorBase(FLOORS.length) - 2;
        onRoof = true;
        roofClock = 0;
        roofWave = 0;
        roofHold = DIFFICULTIES[difficulty].hold;
        sound.setOutdoor(true);
        sound.wind(true);
      },
    };
  }

  // ---- the HUD ----
  hud.innerHTML = `
    <div class="raid-top">
      <div class="raid-floor"><span></span><strong></strong><b class="raid-alarm">Alarm</b></div>
      <div class="raid-objective"><span>Objective</span><strong></strong><em></em></div>
    </div>
    <div class="raid-timer"><span></span><b></b></div>
    <div class="raid-boss"><span>Head of security · Kessler</span><div><i></i></div></div>
    <div class="raid-banner"></div>
    <div class="raid-radio"><span>Handler</span><p></p></div>
    <div class="raid-arc"></div><div class="raid-arc"></div><div class="raid-arc"></div>
    <div class="raid-crosshair"><i></i></div>
    <div class="raid-hitmarker"></div>
    <div class="raid-headshot">Headshot</div>
    <div class="raid-prompt"><p><kbd></kbd><span></span></p><div><i></i></div></div>
    <div class="raid-keypad"><span>Security door</span><div class="raid-digits"><i></i><i></i><i></i><i></i></div><p>Type the code · <kbd>Backspace</kbd> deletes · <kbd>E</kbd> closes</p></div>
    <div class="raid-health"><span>Health <em></em><small>Crouched</small></span><div><i></i></div><b></b></div>
    <div class="raid-weapons">${WEAPON_IDS.map((id) => `<div data-slot="${id}"><kbd></kbd><span>${WEAPONS[id].name}</span><b></b><i><u></u></i></div>`).join("")}</div>
    <div class="raid-ammo"><b></b><span></span></div>
    <div class="raid-fps"></div>
    <div class="raid-hurt"></div>
    <div class="raid-alarmglow"></div>
    <div class="raid-flash"></div>
    <div class="raid-fade"></div>
    <div class="raid-intro"><div><p></p><p></p><p></p><p></p></div><span>Click or press E to skip</span></div>
    <div class="raid-down"><h2></h2><p></p></div>
    <div class="raid-card raid-start">
      <span class="raid-kicker">Hidden level</span>
      <h2>Raid the HQ</h2>
      <p>Five floors of a glass headquarters at night, each with a job to do before its elevator opens. Find better guns on the way up, take the secrets off the top floor and hold the roof until the helicopter lands.</p>
      <div class="raid-diff">
        <button type="button" data-diff="0">Easy<small>150 health</small></button>
        <button type="button" data-diff="1">Normal<small>100 health</small></button>
        <button type="button" data-diff="2">Hard<small>80 health, sharper guards</small></button>
      </div>
      <ul>
        <li><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move</li>
        <li><kbd>Mouse</kbd> look</li>
        <li><kbd>Click</kbd> shoot</li>
        <li><kbd>1</kbd>–<kbd>4</kbd> <kbd>Wheel</kbd> weapons</li>
        <li><kbd>Q</kbd> last weapon</li>
        <li><kbd>Ctrl</kbd> crouch</li>
        <li><kbd>Space</kbd> jump</li>
        <li><kbd>E</kbd> use</li>
        <li><kbd>R</kbd> reload</li>
        <li><kbd>Shift</kbd> run</li>
        <li><kbd>Right click</kbd> aim · shield up (toggles)</li>
        <li><kbd>M</kbd> mute</li>
        <li><kbd>Esc</kbd> pause</li>
      </ul>
      ${
        import.meta.env.DEV
          ? `<div class="raid-test" style="display:grid;gap:6px;justify-items:center;margin:-6px 0 14px;font-size:12px;color:rgba(242,242,243,0.7)">
        <label>Start on <select data-test-floor style="margin-left:6px;font:inherit">${FLOORS.map((_, i) => `<option value="${i}">Floor ${i + 1} · ${THEMES[i].name}</option>`).join("")}<option value="${FLOORS.length}">Roof</option></select></label>
        <span>Test keys (dev only): <kbd>F9</kbd> next floor · <kbd>Shift</kbd>+<kbd>F9</kbd> previous · <kbd>F10</kbd> finish the objective · <kbd>F11</kbd> god mode</span>
      </div>`
          : ""
      }
      <button type="button" class="btn btn-primary" data-start>Start the raid</button>
      <p class="raid-best"></p>
    </div>
    <div class="raid-card raid-paused"><h2>Paused</h2><p>Click to keep going. <kbd>Esc</kbd> again leaves the game.</p></div>
    <div class="raid-card raid-results"><span class="raid-kicker"></span><h2></h2><div class="raid-rank"><b></b><span></span></div><dl></dl><p class="raid-best"></p><button type="button" class="btn btn-primary" data-leave>Leave</button></div>`;
  hud.classList.add("hud-off"); // nothing of the HUD shows behind the loading screen
  const el = <T extends HTMLElement = HTMLElement>(s: string) => hud.querySelector<T>(s)!;
  const floorEl = el(".raid-floor span");
  const floorName = el(".raid-floor strong");
  const alarmEl = el(".raid-alarm");
  const objectiveEl = el(".raid-objective strong");
  const codesEl = el(".raid-objective em");
  const timerEl = el(".raid-timer");
  const timerLabel = el(".raid-timer span");
  const timerNum = el(".raid-timer b");
  const bossEl = el(".raid-boss");
  const bossBar = el(".raid-boss i");
  const bannerEl = el(".raid-banner");
  const radioEl = el(".raid-radio");
  const radioWho = el(".raid-radio span");
  const radioText = el(".raid-radio p");
  const arcEls = [...hud.querySelectorAll<HTMLElement>(".raid-arc")];
  const promptEl = el(".raid-prompt");
  const promptKey = el(".raid-prompt kbd");
  const promptText = el(".raid-prompt span");
  const promptBar = el(".raid-prompt i");
  const keypadEl = el(".raid-keypad");
  const digitEls = [...hud.querySelectorAll<HTMLElement>(".raid-digits i")];
  const healthEl = el(".raid-health");
  const healthBar = el(".raid-health > div > i");
  const healthNum = el(".raid-health b");
  const livesEl = el(".raid-health em");
  const slotEls = WEAPON_IDS.map((id) => {
    const node = el(`[data-slot="${id}"]`);
    return { id, node, key: node.querySelector("kbd")!, ammo: node.querySelector("b")!, bar: node.querySelector("u")! };
  });
  const ammoNum = el(".raid-ammo b");
  const ammoNote = el(".raid-ammo span");
  const hurtEl = el(".raid-hurt");
  const alarmGlow = el(".raid-alarmglow");
  const flashEl = el(".raid-flash");
  const fadeEl = el(".raid-fade");
  const introEl = el(".raid-intro");
  const introLines = [...hud.querySelectorAll<HTMLElement>(".raid-intro p")];
  const downEl = el(".raid-down");
  const hitEl = el(".raid-hitmarker");
  const crosshairEl = el(".raid-crosshair");
  const headshotEl = el(".raid-headshot");
  const startEl = el(".raid-start");
  const diffButtons = [...hud.querySelectorAll<HTMLElement>("[data-diff]")];
  const pausedEl = el(".raid-paused");
  const resultsEl = el(".raid-results");
  /** Writes a style only when it changes, so the HUD does not restyle every frame. */
  const styleCache = new WeakMap<HTMLElement, Record<string, string>>();
  const css = (node: HTMLElement, prop: "opacity" | "transform" | "width" | "height" | "display", value: string) => {
    let c = styleCache.get(node);
    if (!c) styleCache.set(node, (c = {}));
    if (c[prop] === value) return;
    c[prop] = value;
    node.style[prop] = value;
  };
  const OPACITY = Array.from({ length: 51 }, (_, i) => String(i / 50));
  const op = (v: number) => OPACITY[Math.round(Math.min(1, Math.max(0, v)) * 50)];
  const PERCENT = Array.from({ length: 1001 }, (_, i) => `${i / 10}%`);
  /** A width in percent, from a 0..1 fraction (to a tenth of a percent), with no new string per frame. */
  const pct = (f: number) => PERCENT[Math.round(Math.min(1, Math.max(0, f)) * 1000)];
  const PIXELS = Array.from({ length: 401 }, (_, i) => `${i}px`);
  const numCache = new WeakMap<HTMLElement, number>();
  /** Text from a number, written (and turned into a string) only when the number changes. */
  const setNum = (node: HTMLElement, n: number, format?: (n: number) => string) => {
    if (numCache.get(node) === n) return;
    numCache.set(node, n);
    node.textContent = format ? format(n) : String(n);
  };
  let cullT = 0;
  /** Whether you could see a spot: not too far, and no solid wall, closed door or elevator in between (glass is fine). */
  const inView = (x: number, y: number) => {
    const dx = x - player.x;
    const dy = y - player.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 30) return false;
    if (dist < 2) return true;
    const steps = Math.ceil(dist * 2);
    const px = Math.floor(player.x);
    const py = Math.floor(player.y);
    for (let i = 1; i < steps; i++) {
      const sx = player.x + (dx * i) / steps;
      const sy = player.y + (dy * i) / steps;
      const cx = Math.floor(sx);
      const cy = Math.floor(sy);
      if (cx === px && cy === py) continue; // your own cell (the elevator you stand in)
      const ch = cellAt(cx, cy);
      if ("XSVPU".includes(ch)) return false;
      if (ch === "D" && !doorByCell.get(cy * MAP_W + cx)?.open) return false;
      if (ch === "#" && (!inside(cx, cy) || arms[cy * MAP_W + cx] === 0)) return false;
    }
    return true;
  };
  const setText = (node: HTMLElement, text: string) => {
    if (node.textContent !== text) node.textContent = text;
  };
  const clockText = (s: number) => {
    const t = Math.max(0, Math.ceil(s));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
  };
  const readBest = () => {
    try {
      return Number(localStorage.getItem(BEST_KEY) ?? 0) || 0;
    } catch {
      return 0;
    }
  };
  startEl.querySelector<HTMLElement>(".raid-best")!.textContent = readBest() ? `Best score ${readBest()}` : "";

  // ---- state ----
  let phase: "menu" | "intro" | "play" | "extract" | "results" = "menu";
  let locked = false;
  let everLocked = false;
  let ride: { car: Car; phase: "closing" | "moving"; t: number; swapped: boolean; loading: boolean; exit: boolean } | null = null;
  let boardT = 0;
  let downT = 0;
  let failT = 0;
  let failReason = "";
  let introLine = 0;
  let introChars = 0;
  let introHold = 0;
  let hitmark = 0;
  let hitKind: "hit" | "head" | "kill" = "hit";
  let headshotFlash = 0;
  let banner = 0;
  let shake = 0;
  let stepClock = 0;
  let tickClock = 0;
  let spotCooldown = 0;
  let alarmSoundT = 0;
  let pumpSoundT = 0;
  let ePressed = false;
  let muted = false;
  let hudT = 0;
  let keypad: { door: Door; input: string; flash: number; ok: boolean } | null = null;
  let prompt: { key: string; text: string; bar: number | null; warn: boolean } | null = null;
  const radioQueue: string[] = [];
  let radioLine = "";
  let radioShown = 0;
  let radioHold = 0;
  const arcs = arcEls.map((node) => ({ node, angle: 0, life: 0 }));
  let nextArc = 0;
  const keys = new Set<string>();
  const flashbangs: { node: THREE.Mesh; x: number; y: number; z: number; vx: number; vy: number; vz: number; t: number }[] = [];
  /** Which character a hit box belongs to. */
  const owner = new Map<THREE.Object3D, Guard | Civ>();
  const raycaster = new THREE.Raycaster();
  const centre = new THREE.Vector2(0, 0);
  const targets: THREE.Object3D[] = [];
  const hitList: THREE.Intersection[] = [];
  // Scratch vectors: nothing in the frame loop allocates.
  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const vR = new THREE.Vector3();
  const vU = new THREE.Vector3();
  const qA = new THREE.Quaternion();
  const look = new THREE.Object3D();
  const camFrom = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
  const MY_TRACER = new THREE.Color(0xffd27a);
  const THEIR_TRACER = new THREE.Color(CORAL);

  // ---- pooled effects: one draw call each for every tracer, spark and casing ----
  const TRACERS = 64;
  const tracerPos = new Float32Array(TRACERS * 6);
  const tracerCol = new Float32Array(TRACERS * 6);
  const tracerLife = new Float32Array(TRACERS);
  const tracerTint = new Float32Array(TRACERS * 3);
  let tracerNext = 0;
  const tracerGeo = new THREE.BufferGeometry();
  const tracerPosAttr = new THREE.BufferAttribute(tracerPos, 3).setUsage(THREE.DynamicDrawUsage);
  const tracerColAttr = new THREE.BufferAttribute(tracerCol, 3).setUsage(THREE.DynamicDrawUsage);
  tracerGeo.setAttribute("position", tracerPosAttr);
  tracerGeo.setAttribute("color", tracerColAttr);
  // Additive: a tracer fades by going black, so no per-tracer material is needed.
  const tracerLines = new THREE.LineSegments(tracerGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  tracerLines.frustumCulled = false;
  scene.add(tracerLines);
  const addTracer = (from: THREE.Vector3, to: THREE.Vector3, color: THREE.Color) => {
    const i = tracerNext++ % TRACERS;
    const o = i * 6;
    tracerPos[o] = from.x;
    tracerPos[o + 1] = from.y;
    tracerPos[o + 2] = from.z;
    tracerPos[o + 3] = to.x;
    tracerPos[o + 4] = to.y;
    tracerPos[o + 5] = to.z;
    tracerLife[i] = 0.08;
    tracerTint[i * 3] = color.r;
    tracerTint[i * 3 + 1] = color.g;
    tracerTint[i * 3 + 2] = color.b;
  };
  const SPARKS = 220;
  const sparkMesh = new THREE.InstancedMesh(shapes.spark, mats.spark, SPARKS);
  sparkMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(SPARKS * 3), 3);
  sparkMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  sparkMesh.count = 0;
  sparkMesh.frustumCulled = false;
  scene.add(sparkMesh);
  const sparks = Array.from({ length: SPARKS }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), life: 0, max: 1, c: new THREE.Color(), moving: false, s: 1 }));
  let sparkN = 0;
  const sparkColor = new THREE.Color();
  const addSpark = (at: THREE.Vector3, color = 0xffe2a0, vx = 0, vy = 0, vz = 0, life = 0.25, moving = false) => {
    if (sparkN >= SPARKS) return;
    const s = sparks[sparkN++];
    s.p.copy(at);
    s.v.set(vx, vy, vz);
    s.life = s.max = life;
    s.c.setHex(color);
    s.moving = moving;
    s.s = moving ? rand(0.5, 1) : 1;
  };
  const burst = (at: THREE.Vector3, color: number, n: number, speed: number, life: number) => {
    for (let i = 0; i < n; i++) addSpark(at, color, rand(-speed, speed), rand(0.3, 1.6) * speed, rand(-speed, speed), life * rand(0.7, 1.2), true);
  };
  const CASINGS = 48;
  const casingMesh = new THREE.InstancedMesh(shapes.casing, mats.casing, CASINGS);
  casingMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CASINGS * 3), 3);
  casingMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  casingMesh.count = 0;
  casingMesh.frustumCulled = false;
  scene.add(casingMesh);
  const casings = Array.from({ length: CASINGS }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Euler(), spin: new THREE.Vector3(), life: 0, c: new THREE.Color(), shell: false }));
  let casingN = 0;
  const addCasing = (shell: boolean) => {
    const c = casingN < CASINGS ? casings[casingN++] : casings[Math.floor(Math.random() * CASINGS)];
    camera.updateMatrixWorld();
    (guns[weapon].parts.slide ?? guns[weapon].parts.bolt ?? guns[weapon].parts.gun).getWorldPosition(c.p);
    vR.set(1, 0, 0).applyQuaternion(camera.quaternion);
    c.v.copy(vR).multiplyScalar(rand(1.2, 1.9)).add(vA.set(0, rand(1.4, 2.0), 0));
    c.spin.set(rand(10, 20), rand(5, 15), rand(-10, 10));
    c.r.set(0, 0, 0);
    c.life = 2.5;
    c.shell = shell;
    c.c.setHex(shell ? 0xc0392b : 0xd9a53f);
  };
  const mtx = new THREE.Matrix4();
  const updateEffects = (dt: number) => {
    let any = false;
    for (let i = 0; i < TRACERS; i++) {
      if (tracerLife[i] <= 0) {
        if (tracerCol[i * 6] || tracerCol[i * 6 + 1] || tracerCol[i * 6 + 2]) tracerCol.fill(0, i * 6, i * 6 + 6);
        continue;
      }
      any = true;
      tracerLife[i] = Math.max(0, tracerLife[i] - dt);
      const k = tracerLife[i] / 0.08;
      for (let v = 0; v < 2; v++) {
        const f = k * (v ? 1 : 0.35);
        tracerCol[i * 6 + v * 3] = tracerTint[i * 3] * f;
        tracerCol[i * 6 + v * 3 + 1] = tracerTint[i * 3 + 1] * f;
        tracerCol[i * 6 + v * 3 + 2] = tracerTint[i * 3 + 2] * f;
      }
    }
    tracerLines.visible = any;
    if (any) {
      tracerPosAttr.needsUpdate = true;
      tracerColAttr.needsUpdate = true;
    }
    for (let i = 0; i < sparkN; i++) {
      const s = sparks[i];
      s.life -= dt;
      if (s.life <= 0) {
        const last = sparks[--sparkN];
        sparks[sparkN] = s;
        sparks[i] = last;
        i--;
        continue;
      }
      const k = s.life / s.max;
      let scale = s.s;
      if (s.moving) {
        s.v.y -= 6 * dt;
        s.p.addScaledVector(s.v, dt);
      } else scale = 1 + (s.max - s.life) * 6;
      mtx.makeScale(scale, scale, scale).setPosition(s.p);
      sparkMesh.setMatrixAt(i, mtx);
      sparkMesh.setColorAt(i, sparkColor.copy(s.c).multiplyScalar(k));
    }
    sparkMesh.count = sparkN;
    if (sparkN) {
      sparkMesh.instanceMatrix.needsUpdate = true;
      sparkMesh.instanceColor!.needsUpdate = true;
    }
    for (let i = 0; i < casingN; i++) {
      const c = casings[i];
      c.life -= dt;
      if (c.life <= 0) {
        const last = casings[--casingN];
        casings[casingN] = c;
        casings[i] = last;
        i--;
        continue;
      }
      if (c.p.y > 0.012 || Math.abs(c.v.y) > 0.05) {
        c.v.y -= 9.8 * dt;
        c.p.addScaledVector(c.v, dt);
        c.r.x += c.spin.x * dt;
        c.r.y += c.spin.y * dt;
        if (c.p.y < 0.012) {
          c.p.y = 0.012;
          c.v.multiplyScalar(0.4);
          c.v.y = Math.abs(c.v.y) * 0.5;
          c.spin.multiplyScalar(0.5);
          c.r.x = Math.PI / 2;
        }
      }
      const s = (c.shell ? 2.2 : 1) * Math.min(1, c.life / 0.25);
      qA.setFromEuler(c.r);
      mtx.compose(c.p, qA, vA.set(s, s, s));
      casingMesh.setMatrixAt(i, mtx);
      casingMesh.setColorAt(i, c.c);
    }
    casingMesh.count = casingN;
    if (casingN) {
      casingMesh.instanceMatrix.needsUpdate = true;
      casingMesh.instanceColor!.needsUpdate = true;
    }
  };

  const paused = () => phase === "play" && everLocked && !locked;
  const near = (p: Spot, r: number) => Math.hypot(p.x - player.x, p.y - player.y) < r;
  /** Where something is relative to where you look: 0 ahead, positive to the right. */
  const relAngle = (x: number, y: number) => wrap(Math.atan2(y - player.y, x - player.x) - player.yaw);
  const showBanner = (text: string) => {
    bannerEl.textContent = text;
    banner = 3;
  };
  /** Queues a line on the radio; one starting with KESSLER is the head of security on the guards' channel. */
  const radio = (line: string) => {
    if (line && radioLine !== line && !radioQueue.includes(line) && radioQueue.length < 4) radioQueue.push(line);
  };

  // ---- your weapons ----
  let sinceShot = 9; // seconds since your last shot
  let burstShots = 0; // shots in the current string (the rifle's first three are steady)
  let ads = 0; // aiming down the sights, 0..1
  let adsHeld = false;
  /**
   * The cone a shot leaves in now, in radians: the weapon's own (crouch, movement, the kick of the last
   * shots), much tighter on the sights, wider in the air; and the first shot after a moment still and
   * steady goes where the crosshair is. The crosshair is drawn from this same number.
   */
  const currentSpread = () => {
    const kick = weapon === "rifle" && (sinceShot > 0.3 || burstShots < 3) ? 0 : anim.kick;
    let sp = weaponSpread(weapon, crouched(), player.moving, kick);
    if (sinceShot > 0.3 && player.moving < 0.05 && player.z === 0 && weapon !== "shotgun") sp *= 0.12;
    sp *= 1 - ads * (weapon === "shotgun" ? 0.35 : 0.75);
    return sp * (player.z > 0 ? 2.5 : 1);
  };
  const owned = () => WEAPON_IDS.filter((id) => inv.owned[id]);
  const crouched = () => player.crouch > 0.5;
  const magOf = (id: WeaponId) => inv.mag[magKey(id)];
  const reserveOf = (id: WeaponId) => inv.reserve[WEAPONS[id].ammo];
  const busy = () => phase !== "play" || paused() || !!ride || downT > 0 || failT > 0 || !!keypad || restarting;
  const selectWeapon = (id: WeaponId) => {
    if (!inv.owned[id] || (id === weapon && !wantWeapon) || id === wantWeapon) return;
    wantWeapon = id;
    anim.raised = false;
    reloadT = -1;
    anim.reload = -1;
    adsHeld = false;
    shieldRaised = false;
  };
  const cycleWeapon = (dir: number) => {
    const list = owned();
    const at = list.indexOf(wantWeapon ?? weapon);
    selectWeapon(list[(at + dir + list.length) % list.length]);
  };
  /** The weapon in hand changes once the old one is down. */
  const finishSwitch = () => {
    if (!wantWeapon || anim.raise > 0.001) return;
    guns[weapon].node.visible = false;
    lastWeapon = weapon;
    weapon = wantWeapon;
    wantWeapon = null;
    guns[weapon].node.visible = true;
    anim.raised = true;
    anim.empty = false;
    fireCooldown = Math.max(fireCooldown, 0.1);
    sound.weaponSwitch();
  };
  const startReload = () => {
    if (reloadT >= 0 || wantWeapon || busy()) return;
    const st = WEAPONS[weapon];
    if (magOf(weapon) >= st.magazine || reserveOf(weapon) <= 0) return;
    reloadT = 0;
    adsHeld = false;
    reloadPumps = magOf(weapon) === 0;
    if (weapon === "rifle") sound.rifleReload();
    else if (weapon !== "shotgun") sound.reload();
  };
  const stopReload = () => {
    if (reloadT < 0) return;
    reloadT = -1;
    anim.reload = -1;
    if (weapon === "shotgun" && reloadPumps) {
      rackPump(anim);
      sound.shotgunPump();
      reloadPumps = false;
    }
  };
  const stepReload = (dt: number) => {
    if (reloadT < 0) return;
    const st = WEAPONS[weapon];
    const key = magKey(weapon);
    reloadT += dt;
    if (st.reloadPerShell) {
      // One shell at a time; firing (or running out of shells) stops it between shells.
      if (reloadT >= st.reloadTime) {
        reloadT = 0;
        inv.mag[key]++;
        inv.reserve[st.ammo]--;
        sound.shellInsert();
        if (inv.mag[key] >= st.magazine || inv.reserve[st.ammo] <= 0) stopReload();
      }
    } else if (reloadT >= st.reloadTime) {
      const take = Math.min(st.magazine - inv.mag[key], inv.reserve[st.ammo]);
      inv.mag[key] += take;
      inv.reserve[st.ammo] -= take;
      reloadT = -1;
    }
    anim.reload = reloadT < 0 ? -1 : reloadT / st.reloadTime;
  };
  /** One round (or pellet) along the view, spread by up to `spread` radians. Returns whether it hit someone. */
  const shootRay = (spread: number, dist0: number): boolean => {
    raycaster.setFromCamera(centre, camera);
    const a = Math.random() * Math.PI * 2;
    const r = spread * Math.sqrt(Math.random());
    vR.set(1, 0, 0).applyQuaternion(camera.quaternion).multiplyScalar(Math.tan(r) * Math.cos(a));
    vU.set(0, 1, 0).applyQuaternion(camera.quaternion).multiplyScalar(Math.tan(r) * Math.sin(a));
    raycaster.ray.direction.add(vR).add(vU).normalize();
    raycaster.far = 120;
    hitList.length = 0;
    raycaster.intersectObjects(targets, false, hitList);
    const hit = hitList[0];
    guns[weapon].muzzle.getWorldPosition(vA);
    if (import.meta.env.DEV) (window as unknown as { __lastHit?: unknown }).__lastHit = hit ? [spread.toFixed(4), anim.viewPitch.toFixed(4), anim.viewYaw.toFixed(4), camera.rotation.x.toFixed(4), player.pitch.toFixed(4), hit.distance.toFixed(2), owner.has(hit.object) ? "person" : blockers.includes(hit.object) ? "blocker" : hit.object.type, hit.point.toArray().map((v) => +v.toFixed(2))] : "none";
    addTracer(vA, hit ? hit.point : raycaster.ray.at(60, vB), MY_TRACER);
    if (!hit) return false;
    addSpark(hit.point);
    const cam = camBodies.get(hit.object);
    if (cam && !cam.dead) {
      // A shot camera goes dark and droops.
      cam.dead = true;
      cam.cone.visible = false;
      cam.led.material = mats.camLedOff;
      cam.head.rotation.x = -0.6;
      burst(hit.point, 0xbfe4ff, 8, 1, 0.4);
      sound.hit(false);
      return false;
    }
    const who = owner.get(hit.object);
    if (!who) return false;
    if ("stats" in who && hit.object === who.shield) {
      burst(hit.point, 0xffe2a0, 5, 1.2, 0.25);
      sound.shieldHit();
      return false;
    }
    if (!("stats" in who)) {
      if (who.state === "down") return false;
      who.state = "down";
      who.dying = 0.6;
      who.ps.hitDir = wrap(Math.atan2(player.x - who.x, player.y - who.y) - who.yaw);
      civiliansHit++;
      hitmark = 0.18;
      hitKind = "hit";
      sound.hit(false);
      showBanner("Civilian hit · -500");
      radio("Civilians aren't the target.");
      return false;
    }
    const g = who;
    if (g.dying !== 0) return false;
    const zone = g.ch.hit.zoneOf(hit.object) ?? "body";
    const head = zone === "head";
    const metres = dist0 + hit.distance;
    let dmg = damageAt(weapon, metres, head);
    if (head) dmg *= g.stats.head;
    else if (zone === "armor") dmg *= g.stats.armour;
    else if (zone === "limb") dmg *= 0.75;
    if (zone === "armor") addSpark(hit.point, 0xbfe4ff);
    damageGuard(g, dmg, head);
    return true;
  };
  const fire = () => {
    const st = WEAPONS[weapon];
    const key = magKey(weapon);
    if (weapon === "shield" && shieldRaised) return; // raised, the pistol is behind it
    if (inv.mag[key] <= 0) {
      sound.empty();
      fireCooldown = 0.3;
      startReload();
      return;
    }
    if (reloadT >= 0) {
      if (!st.reloadPerShell) return;
      stopReload(); // a shotgun reload stops for the shot
    }
    inv.mag[key]--;
    fireCooldown = fireInterval(weapon);
    shots++;
    // The spread for this shot, and the aim it leaves along, both from before its own recoil: the camera
    // is turned to this frame's aim (the mouse was applied at the start of the frame; the frame draws it).
    const spread = currentSpread();
    camera.rotation.y = -player.yaw - Math.PI / 2 - anim.viewYaw;
    camera.rotation.x = player.pitch + anim.viewPitch;
    camera.rotation.z = 0;
    burstShots = sinceShot > 0.3 ? 1 : burstShots + 1;
    sinceShot = 0;
    addRecoil(anim, weapon);
    // Less climb on the sights, and the rifle's first rounds climb half as much.
    const climb = WEAPONS[weapon].recoilPitch * (ads * 0.45 + (weapon === "rifle" && burstShots <= 3 ? 0.5 : 0));
    anim.viewPitch -= Math.min(climb, WEAPONS[weapon].recoilPitch * 0.8);
    if (weapon === "shotgun") shake = Math.max(shake, 0.012);
    if (weapon === "rifle") sound.rifleShot();
    else if (weapon === "shotgun") {
      sound.shotgunShot();
      pumpSoundT = 0.28;
    } else sound.shot();
    if (weapon !== "shotgun") addCasing(false);
    muzzleLight.intensity = 40;
    // Who hears it.
    const loud = HEARS_SHOT * (weapon === "pistol" || weapon === "shield" ? 1 : 1.3);
    for (const g of guards) {
      if (g.dying !== 0 || Math.hypot(g.x - player.x, g.y - player.y) > loud) continue;
      if (!g.alert) g.reload = Math.max(g.reload, rand(0.6, 1.4));
      g.alert = true;
      g.chase = Math.max(g.chase, CHASE_SECONDS);
      g.lastX = player.x;
      g.lastY = player.y;
    }
    for (const c of civs) {
      if (c.state === "down" || Math.hypot(c.x - player.x, c.y - player.y) > 10) continue;
      if (c.witness === 0 && seesFrom(c.x, c.y, player.x, player.y)) c.witness = 2.5;
      panicCiv(c);
    }
    // What a round can hit: the level's bullet areas, the doors and cameras, and everyone's hit boxes.
    camera.updateMatrixWorld();
    targets.length = 0;
    for (const b of blockers) targets.push(b);
    for (const g of guards) {
      if (g.dying !== 0 || !g.node.visible) continue; // hidden ones keep stale hit boxes (and cannot be seen)
      for (const h of g.ch.hit.all) targets.push(h);
      if (g.shield) targets.push(g.shield);
    }
    for (const c of civs) if (c.state !== "down" && c.node.visible) for (const h of c.ch.hit.all) targets.push(h);
    let any = false;
    for (let i = 0; i < st.pellets; i++) if (shootRay(spread, 0)) any = true;
    if (any) hits++;
    if (inv.mag[key] === 0) startReload();
  };

  /** The floor's job is done: its elevator opens. */
  const unlockFloor = (note: string) => {
    if (floorDone) return;
    floorDone = true;
    if (lasers) lasers.visible = false;
    sound.done();
    showBanner(note);
    radio("Good. The elevator's yours.");
  };
  const finishStation = (s: Station) => {
    s.done = true;
    if (s.screen) s.screen.material = mats.kioskDone;
    if (s.lamp) s.lamp.material = mats.lampOn;
    sound.done();
  };
  const learnCode = (door: number) => {
    const d = doors[door];
    if (!d) return;
    d.known = true;
    sound.pickup();
    showBanner(`Door code ${d.code}`);
  };

  /** The whole floor knows: every guard hunts you, more come, the elevator takes longer. */
  const raiseAlarm = (why: string) => {
    for (const g of guards) {
      if (g.dying !== 0) continue;
      g.alert = true;
      g.chase = Infinity;
    }
    if (alarm) return;
    alarm = true;
    alarms++;
    sound.spotted();
    sound.alarm(true);
    alarmSoundT = 4;
    for (let i = 0; i < 2; i++) reinforce();
    radio(floorIndex >= 3 ? `${why} The alarm is up, and the army is in the building.` : `${why} The alarm is up: they're all coming.`);
    showBanner("Alarm");
  };
  /** A guard has seen you: he and the guards near him join in. */
  const spot = (g: Guard) => {
    g.alert = true;
    g.suspicion = 0;
    g.chase = Math.max(g.chase, CHASE_SECONDS);
    g.reload = Math.max(g.reload, rand(0.5, 1.1));
    for (const o of guards) {
      if (o === g || o.dying !== 0 || o.alert || Math.hypot(o.x - g.x, o.y - g.y) > ALERT_RADIUS) continue;
      o.alert = true;
      o.chase = CHASE_SECONDS;
      o.reload = rand(0.8, 1.8);
    }
    if (!spottedOnce) {
      spottedOnce = true;
      radio("You've been spotted. Fight, or lose them.");
    }
    if (spotCooldown <= 0) {
      sound.spotted();
      spotCooldown = 3;
    }
  };
  /** What comes when more come: officers low down, the army from the executive floor up. */
  const reinforcementType = (): EnemyType => (floorIndex >= 3 || onRoof ? (Math.random() < 0.7 ? "soldier" : "armored") : officerType(floorIndex));
  /** Brings someone in at a free cell far from you (or near `from`) and out of your sight, already hunting. */
  const reinforce = (type: EnemyType = reinforcementType(), from?: Spot): boolean => {
    updateFlow();
    const far: [number, number][] = [];
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        if (map[y][x] !== "." || flow[y * MAP_W + x] < 0) continue;
        const d = Math.hypot(x + 0.5 - player.x, y + 0.5 - player.y);
        if (from && Math.hypot(x + 0.5 - from.x, y + 0.5 - from.y) > 7) continue;
        if (d > (from ? 6 : 9) && d < 26 && !seesFrom(x + 0.5, y + 0.5, player.x, player.y)) far.push([x, y]);
      }
    }
    if (!far.length) return false;
    const [x, y] = far[Math.floor(Math.random() * far.length)];
    spawnGuard(x + 0.5, y + 0.5, "hunter", type);
    return true;
  };
  const startRun = (at: Spot, total: number, label: string, finish: () => void) => {
    run = { at, t: 0, total, spawned: 0, spawnClock: 0, label, finish };
    sound.progressTick();
  };
  const startFinale = () => {
    finale = FINALE_SECONDS;
    finaleWave = 0;
    floorDone = true;
    sound.alarm(true);
    showBanner("Upload done");
    radio("Lockdown! Sixty seconds, and the army is on the stairs. The elevator you came up in goes to the roof. Move!");
  };

  const dropBadge = (g: Guard) => {
    badgeAt = { x: g.x, y: g.y };
    const card = new THREE.Mesh(shapes.card, mats.card);
    card.position.set(g.x * U, 0.6, g.y * U);
    level.add(card);
    badgeNode = card;
    showBanner("Head of security down");
    radio("He's down. Grab his badge, it calls the lift.");
  };
  /** The boss's flashbang: an arc toward you, a bounce, a bang. Looking at it blinds you for seconds. */
  const throwFlashbang = (g: Guard) => {
    const tx = player.x + rand(-0.8, 0.8);
    const ty = player.y + rand(-0.8, 0.8);
    const T = 0.9;
    const node = new THREE.Mesh(box(0.07, 0.13, 0.07), mats.grenade);
    level.add(node);
    flashbangs.push({ node, x: g.x, y: g.y, z: 1.4, vx: (tx - g.x) / T, vy: (ty - g.y) / T, vz: (-1.4 + 0.5 * GRAVITY * T * T) / T, t: 0 });
  };
  const stepFlashbangs = (dt: number) => {
    for (let i = flashbangs.length - 1; i >= 0; i--) {
      const f = flashbangs[i];
      f.t += dt;
      f.vz -= GRAVITY * dt;
      const nx = f.x + f.vx * dt;
      const ny = f.y + f.vy * dt;
      if (fits(nx, f.y, 0.05)) f.x = nx;
      else f.vx *= -0.4;
      if (fits(f.x, ny, 0.05)) f.y = ny;
      else f.vy *= -0.4;
      f.z += f.vz * dt;
      if (f.z < 0.05) {
        f.z = 0.05;
        f.vz = Math.abs(f.vz) * 0.25;
        f.vx *= 0.5;
        f.vy *= 0.5;
      }
      f.node.position.set(f.x * U, f.z, f.y * U);
      f.node.rotation.x += dt * 9;
      if (f.t < FLASH_FUSE) continue;
      flashbangs.splice(i, 1);
      f.node.removeFromParent();
      burst(f.node.position, 0xffffff, 18, 2.2, 0.35);
      addSpark(f.node.position, 0xffffff, 0, 0, 0, 0.3);
      sound.flashbang();
      const d = Math.hypot(f.x - player.x, f.y - player.y);
      if (d < 14 && seesFrom(f.x, f.y, player.x, player.y)) {
        const facing = Math.max(0, Math.cos(relAngle(f.x, f.y)));
        const amount = (0.35 + 0.65 * facing) * (1 - d / 16);
        player.blind = Math.max(player.blind, 1 + 3.2 * amount);
        sound.deafen(1.5 + 2.5 * amount);
      }
      for (const g of guards) if (g.dying === 0 && g.type !== "boss" && Math.hypot(g.x - f.x, g.y - f.y) < 5) g.stagger = 1.2;
    }
  };
  /** Whether something low stands right next to a guard, between him and you: he can duck behind it. */
  const guardCover = (g: Guard) => {
    const dx = player.x - g.x;
    const dy = player.y - g.y;
    const l = Math.hypot(dx, dy) || 1;
    for (let s = 0.4; s <= 1.3; s += 0.3) {
      const ch = cellAt(Math.floor(g.x + (dx / l) * s), Math.floor(g.y + (dy / l) * s));
      if (LOW_COVER.includes(ch) || (onRoof && ch === "W")) return true;
    }
    return false;
  };
  /** A round landed on a guard. Plates, the boss's phases, the fall, the drop. */
  const damageGuard = (g: Guard, dmg: number, head: boolean) => {
    g.health -= dmg;
    // Under fire next to something low: he ducks behind it for a moment.
    if (g.health > 0 && g.type !== "boss" && g.crouch <= 0 && Math.random() < 0.6 && guardCover(g)) g.crouch = rand(1.4, 2.8);
    g.hurt = 0.12;
    g.stagger = Math.max(g.stagger, g.type === "boss" ? 0.1 : 0.2);
    g.ps.hitDir = wrap(Math.atan2(player.x - g.x, player.y - g.y) - g.heading);
    if (!g.alert) spot(g);
    g.chase = Math.max(g.chase, CHASE_SECONDS);
    g.lastX = player.x;
    g.lastY = player.y;
    const killed = g.health <= 0;
    hitmark = 0.18;
    hitKind = head ? "head" : killed ? "kill" : "hit";
    if (head) {
      headshotFlash = HEADSHOT_SECONDS;
      headshots++;
    }
    sound.hit(head);
    if (g.type === "boss" && !killed) {
      if (g.stage === 0 && g.health <= g.maxHealth * 0.75) {
        g.stage = 1;
        throwFlashbang(g);
        radio(`${KESSLER}Flash out!`);
      } else if (g.stage < 2 && g.health <= g.maxHealth * 0.35) {
        g.stage = 2;
        for (let i = 0; i < 3; i++) reinforce("soldier", g);
        sound.armyRadio();
        radio(`${KESSLER}All units, executive floor. Now!`);
        radio("He's called in a squad. Finish him before they get there.");
      }
    }
    if (killed) {
      g.dying = 0.7;
      g.burstLeft = 0;
      kills++;
      sound.kill();
      if (head && g.type !== "boss") {
        g.ch.setHeadVisible(false);
        g.ch.hit.head.getWorldPosition(vC);
        for (let i = 0; i < 14; i++) addSpark(vC, i % 3 ? 0xffc94a : 0xff6b57, rand(-1.6, 1.6), rand(0.6, 2.6), rand(-1.6, 1.6), rand(0.35, 0.6), true);
      }
      if (g.type === "boss") dropBadge(g);
      else dropLoot(g);
    }
  };

  /** Whether something low (a desk, a counter, a parapet) is between you and a shooter, right in front of you. */
  const behindLow = (fx: number, fy: number) => {
    const dx = fx - player.x;
    const dy = fy - player.y;
    const l = Math.hypot(dx, dy);
    for (let s = 0.3; s <= 1.6 && s < l - 0.6; s += 0.2) {
      const ch = cellAt(Math.floor(player.x + (dx / l) * s), Math.floor(player.y + (dy / l) * s));
      if (LOW_COVER.includes(ch) || (onRoof && ch === "W")) {
        vC.set((player.x + (dx / l) * s) * U, rand(0.6, 0.95), (player.y + (dy / l) * s) * U);
        return true;
      }
    }
    return false;
  };
  /** One round from a guard: it may hit you, your shield, or the desk you are ducked behind. */
  const guardFire = (g: Guard, dist: number) => {
    const diff = DIFFICULTIES[difficulty];
    g.mag--;
    g.ps.recoil = 1;
    if (g.type === "officer" || g.type === "armored") sound.guardShot(Math.sin(relAngle(g.x, g.y)), dist);
    if (g.ch.muzzle) g.ch.muzzle.getWorldPosition(vA);
    else vA.set(g.x * U, 1.4, g.y * U);
    const moving = player.moving > 0.3;
    let chance = Math.min(0.92, Math.max(0.12, 0.8 - dist * 0.055 - (moving ? 0.15 : 0) - (player.z > 0 ? 0.1 : 0)));
    chance *= diff.accuracy * g.stats.aim * (crouched() ? 0.75 : 1) * (g.burstLeft > 1 ? 0.85 : 1);
    const hitYou = Math.random() < Math.min(0.95, chance);
    const ang = relAngle(g.x, g.y);
    if (hitYou && weapon === "shield" && !wantWeapon && inv.shield > 0 && shieldCovers(shieldRaised, ang)) {
      // Sparks off the shield in front of you.
      vB.set(Math.cos(player.yaw + ang * 0.5), 0, Math.sin(player.yaw + ang * 0.5));
      vC.copy(camera.position).addScaledVector(vB.set(vB.x, 0, vB.z), 0.55);
      vC.y -= 0.15;
      addTracer(vA, vC, THEIR_TRACER);
      burst(vC, 0xffe2a0, 5, 1.2, 0.25);
      sound.shieldHit();
      hitShield(anim, 0.6);
      inv.shield -= rand(...g.stats.damage) * diff.damage * 1.4;
      if (inv.shield <= 0) {
        inv.shield = 0;
        inv.owned.shield = false;
        sound.shieldBreak();
        showBanner("The shield broke");
        wantWeapon = "pistol";
        anim.raised = false;
        shieldRaised = false;
      }
      return;
    }
    if (hitYou && crouched() && behindLow(g.x, g.y)) {
      addTracer(vA, vC, THEIR_TRACER);
      burst(vC, 0xffe2a0, 4, 1, 0.25);
      return;
    }
    vB.copy(camera.position).add(vC.set(rand(-0.6, 0.6), hitYou ? -0.25 : rand(-0.8, 0.6), rand(-0.6, 0.6)));
    addTracer(vA, vB, THEIR_TRACER);
    if (hitYou) hurtPlayer(g);
  };
  const hurtPlayer = (from: Guard) => {
    if (god) return;
    const diff = DIFFICULTIES[difficulty];
    player.health -= rand(...from.stats.damage) * diff.damage;
    player.hurt = 0.4;
    shake = Math.max(shake, 0.035);
    sound.hurt();
    const arc = arcs[nextArc++ % arcs.length];
    arc.angle = relAngle(from.x, from.y);
    arc.life = 1;
    if (player.health <= 0) die();
  };
  /** Down: back to the start of the floor (or the roof) with 70 health, until the third time. */
  const die = () => {
    player.health = 0;
    deaths++;
    keypad = null;
    trigger = false;
    sound.alarm(false);
    if (deaths >= MAX_DEATHS) {
      failReason = "Caught";
      failT = 2.6;
      setText(downEl.querySelector("h2")!, "Caught.");
      setText(downEl.querySelector("p")!, onRoof ? "The army took the roof." : `Security got you on floor ${floorIndex + 1}.`);
      sound.lose();
      return;
    }
    downT = 2.4;
    const left = MAX_DEATHS - deaths;
    setText(downEl.querySelector("h2")!, "Down.");
    setText(downEl.querySelector("p")!, `Back to the start of ${onRoof ? "the roof" : `floor ${floorIndex + 1}`} · ${left} ${left === 1 ? "try" : "tries"} left`);
  };
  /** Puts you in the car you arrive by, doors shut, facing out. */
  const placeInCar = () => {
    const arrival = cars.find((car) => !car.up);
    if (!arrival) return;
    const [x, y] = fromLocal(arrival.dir, 0.5, 0.42);
    player.x = player.px = Math.floor(arrival.x) + x;
    player.y = player.py = Math.floor(arrival.y) + y;
    player.yaw = carYaw(arrival);
    player.pitch = 0;
  };
  const resetHands = () => {
    for (const id of WEAPON_IDS) guns[id].node.visible = false;
    weapon = inv.owned[weapon] ? weapon : "pistol";
    guns[weapon].node.visible = true;
    wantWeapon = null;
    reloadT = -1;
    anim.reload = -1;
    anim.raised = true;
    trigger = false;
    shieldRaised = false;
    adsHeld = false;
  };
  let restarting = false;
  const restartFloor = () => {
    restarting = true;
    const wasRoof = onRoof;
    copyInv(saved, inv);
    resetHands();
    (wasRoof ? loadRoof() : loadFloor(floorIndex, true)).then(() => {
      restarting = false;
      if (wasRoof) placeInCar();
      player.health = Math.min(maxHealth, CHECKPOINT_HEALTH);
      player.z = player.vz = 0;
      player.blind = 0;
      radio(wasRoof ? "Back up. The bird's still coming: hold that roof." : "Back on your feet. Again, and quieter.");
    }, swallow);
  };

  const objectiveText = (): string => {
    if (onRoof) {
      if (extract?.state === "landed") return "Get in the helicopter";
      return "Hold the roof until the helicopter lands";
    }
    const pct = run ? ` ${Math.floor((run.t / run.total) * 100)}%` : "";
    const done = (kind: Station["kind"]) => stations.filter((s) => s.kind === kind && s.done).length;
    const count = (kind: Station["kind"]) => stations.filter((s) => s.kind === kind).length;
    switch (floorIndex) {
      case 0:
        if (gatesOpen || doors[0]?.open) return "Take the elevator up";
        return `Get past security: hack the terminals ${done("T")}/${count("T")}, or use the staff door`;
      case 1:
        if (floorDone) return "Take the elevator up";
        if (run) return `Downloading the access codes${pct}`;
        if (!doors[0]?.open) return doors[0]?.known ? "Open the server closet" : "Find the server closet code at the IT terminal";
        return "Download the access codes in the server closet";
      case 2:
        return floorDone ? "Take the elevator up" : `Pull the fuses to cut the laser grid ${done("F")}/${count("F")}`;
      case 3: {
        if (floorDone) return "Take the elevator up";
        if (boss && boss.dying === 0) {
          const inLobby = player.y > 20 && player.x > 13 && player.x < 26;
          return inLobby && !doors[1]?.open ? (doors[1]?.known ? "Get into the executive wing" : "Get into the executive wing: the code is at the front desk") : "Take down the head of security";
        }
        return "Pick up his badge";
      }
      default:
        if (finale > 0) return "Reach the elevator to the roof";
        if (!hasKey) return doors[0]?.open ? "Take the keycard" : doors[0]?.known ? "Open the security office" : "Find the security office code in the NOC";
        return run ? `Uploading the secrets${pct}` : "Upload the secrets at the rack";
    }
  };

  const COVER_CH = "deMQojtckXfhnbazOv";
  const findCover = (g: Guard, away = false): Spot | null => {
    let best: Spot | null = null;
    let bestD = away ? 4.5 : 3.2;
    const gx = Math.floor(g.x);
    const gy = Math.floor(g.y);
    const r = away ? 4 : 3;
    for (let y = gy - r; y <= gy + r; y++) {
      for (let x = gx - r; x <= gx + r; x++) {
        if (!walkCell(x, y)) continue;
        const cxp = x + 0.5;
        const cyp = y + 0.5;
        if (g.kind === "boss" && g.cover && Math.floor(g.cover.x) === x && Math.floor(g.cover.y) === y) continue;
        const px = player.x - cxp;
        const py = player.y - cyp;
        const pl = Math.hypot(px, py);
        if (pl < (away ? 4 : 2.5) || pl > GUARD_SEES + 2) continue;
        // Falling back to reload: the cover must hide him; otherwise it is cover he can shoot from.
        if (away && seesFrom(cxp, cyp, player.x, player.y)) {
          const covered = N4.some(([dx, dy]) => {
            const ch = cellAt(x + dx, y + dy);
            return (COVER_CH.includes(ch) || (ch === "#" && inside(x + dx, y + dy)) || (onRoof && ch === "W")) && (dx * px + dy * py) / pl > 0.6;
          });
          if (!covered) continue;
        }
        if (!away) {
          const covered = N4.some(([dx, dy]) => {
            const ch = cellAt(x + dx, y + dy);
            const cover = COVER_CH.includes(ch) || (ch === "#" && inside(x + dx, y + dy));
            return cover && (dx * px + dy * py) / pl > 0.6;
          });
          if (!covered) continue;
        }
        const d = Math.hypot(cxp - g.x, cyp - g.y);
        if (d >= bestD) continue;
        if (guards.some((o) => o !== g && o.cover && Math.floor(o.cover.x) === x && Math.floor(o.cover.y) === y)) continue;
        if ((!away && !seesFrom(cxp, cyp, player.x, player.y)) || !seesFrom(g.x, g.y, cxp, cyp)) continue;
        best = { x: cxp, y: cyp };
        bestD = d;
      }
    }
    return best;
  };
  /** A cell to one side of you, a few steps away and reachable: where a flanker goes. */
  const flankCell = (g: Guard): number => {
    const from = Math.atan2(g.y - player.y, g.x - player.x);
    const side = Math.random() < 0.5 ? 1 : -1;
    for (let k = 0; k < 10; k++) {
      const a = from + side * (1.2 + k * 0.12) * (k % 2 ? -1 : 1);
      const r = rand(3, 5.5);
      const x = Math.floor(player.x + Math.cos(a) * r);
      const y = Math.floor(player.y + Math.sin(a) * r);
      if (!walkCell(x, y)) continue;
      const f = flow[y * MAP_W + x];
      if (f > 0 && f < 16) return y * MAP_W + x;
    }
    return -1;
  };
  /** Walks a guard along his path; false when there is no path left. */
  const followPath = (g: Guard, speed: number, dt: number): boolean => {
    if (!g.path.length) return false;
    const next = g.path[0];
    const tx = (next % MAP_W) + 0.5;
    const ty = Math.floor(next / MAP_W) + 0.5;
    const l = Math.hypot(tx - g.x, ty - g.y);
    if (l < 0.12) {
      g.path.shift();
      return g.path.length > 0;
    }
    const s = Math.min(l, speed * dt);
    const bx = g.x;
    const by = g.y;
    move(g, ((tx - g.x) / l) * s, ((ty - g.y) / l) * s, 0.25);
    if (g.x === bx && g.y === by) {
      g.path.length = 0;
      return false;
    }
    if (!g.sees) g.heading = Math.atan2(tx - bx, ty - by);
    g.walk += dt * (speed / 1.3);
    return true;
  };

  /** A guard who has not noticed you: walks his round or holds his post, looking around. */
  const calmMove = (g: Guard, dt: number) => {
    g.look += dt;
    if (g.kind !== "patrol" && g.kind !== "hunter") {
      g.heading = g.postAngle + Math.sin(g.look * 0.5) * 0.7;
      return;
    }
    if (g.wait > 0) {
      g.wait -= dt;
      g.heading += Math.sin(g.look * 1.3) * dt * 0.8;
      return;
    }
    if (!g.path.length) {
      if (!g.route.length) {
        g.wait = 2;
        return;
      }
      g.routeAt = (g.routeAt + 1) % g.route.length;
      g.path = pathTo(cellOf(g), g.route[g.routeAt]);
      if (!g.path.length) {
        g.wait = 1.5;
        return;
      }
    }
    if (!followPath(g, PATROL_SPEED * (g.alert ? 1.5 : 1), dt) && !g.path.length) g.wait = rand(1.2, 3);
  };

  const updateGuard = (g: Guard, dt: number) => {
    if (g.dying > 0) {
      g.dying -= dt;
      if (g.dying <= 0) g.dying = -1;
      return;
    }
    if (g.dying < 0) return;
    // A soldier on the rope only slides down.
    if (g.rope > 0) {
      g.rope = Math.max(0, g.rope - dt);
      g.z = (g.rope / 1.8) * 9;
      if (g.rope === 0) g.z = 0;
      return;
    }
    const dx = player.x - g.x;
    const dy = player.y - g.y;
    const dist = Math.max(0.01, Math.hypot(dx, dy));
    // Far away and calm, or far away and out of sight: think a few times a second.
    const slow = !g.alert ? dist > AI_FAR : dist > AI_FAR && !g.node.visible && g.burstLeft === 0;
    if (slow) {
      g.skip += dt;
      if (g.skip < (g.alert ? 0.12 : 0.25)) return;
      dt = g.skip;
    }
    g.skip = 0;
    g.hurt = Math.max(0, g.hurt - dt);
    g.reload = Math.max(0, g.reload - dt);
    g.stagger = Math.max(0, g.stagger - dt);
    g.chase = Math.max(0, g.chase - dt);
    g.crouch = Math.max(0, g.crouch - dt);
    g.lastSeen += dt;
    const diff = DIFFICULTIES[difficulty];
    let sees = false;
    const low = crouched();
    const range = GUARD_SEES * (low && !g.alert ? 0.7 : 1) * (player.blind > 0 ? 1 : 1);
    if (dist < range) {
      if (g.alert) sees = seesFrom(g.x, g.y, player.x, player.y);
      else {
        const ahead = Math.cos(Math.atan2(dx, dy) - g.heading);
        if ((dist < 2.2 || ahead > 0.45) && seesFrom(g.x, g.y, player.x, player.y) && !(low && dist > 2.2 && behindLow(g.x, g.y))) sees = true;
      }
    }
    if (!g.alert) {
      if (sees) {
        g.suspicion += dt * (dist < 4 ? 3 : 1.4) * (low ? 0.5 : 1);
        if (g.suspicion >= 1) spot(g);
      } else g.suspicion = Math.max(0, g.suspicion - dt * 0.4);
    }
    g.sees = sees && g.alert;
    if (g.sees) {
      g.chase = Math.max(g.chase, CHASE_SECONDS);
      g.lastSeen = 0;
      g.lastX = player.x;
      g.lastY = player.y;
      if (g.type === "boss" && !g.seenOnce) {
        g.seenOnce = true;
        radio(`${KESSLER}Wrong building. Nobody walks off my floor.`);
        radio("That's Kessler, head of security. Plates and a rifle: go for the head.");
      }
    }
    // A burst already started finishes (while he still sees you).
    if (g.burstLeft > 0) {
      g.burstT -= dt;
      if (g.burstT <= 0) {
        if (g.sees && g.mag > 0 && floorClock > GRACE_SECONDS) guardFire(g, dist);
        g.burstLeft--;
        g.burstT = g.stats.gap;
        if (phase !== "play" || downT > 0 || failT > 0) return;
      }
    }
    if (g.mag <= 0 && g.reloading <= 0) {
      g.reloading = g.stats.reload;
      g.cover = findCover(g, true);
      g.coverFor = g.stats.reload;
      g.burstLeft = 0;
    }
    if (!g.alert || (!g.sees && g.chase <= 0)) {
      calmMove(g, dt);
      return;
    }
    const nx = dx / dist;
    const ny = dy / dist;
    const speed = g.stats.speed;
    if (g.stagger > 0) {
      move(g, -nx * 1.4 * dt, -ny * 1.4 * dt, 0.25);
      return;
    }
    // Reloading: fall back to cover that hides him, or away from you; ducked down if it is low.
    if (g.reloading > 0) {
      g.reloading -= dt;
      g.ps.reload = 1 - g.reloading / g.stats.reload;
      const atCover = !g.cover || Math.hypot(g.cover.x - g.x, g.cover.y - g.y) < 0.15;
      if (atCover && guardCover(g)) g.crouch = Math.max(g.crouch, Math.min(0.4, g.reloading + 0.2));
      if (g.reloading <= 0) {
        g.reloading = 0;
        g.ps.reload = 0;
        g.mag = g.stats.mag;
        g.cover = null;
        g.coverFor = 0;
      } else if (g.crouch > 0) g.heading = Math.atan2(dx, dy);
      else if (g.cover) {
        const tx = g.cover.x - g.x;
        const ty = g.cover.y - g.y;
        const l = Math.hypot(tx, ty);
        if (l > 0.1) {
          move(g, (tx / l) * Math.min(l, speed * 1.2 * dt), (ty / l) * Math.min(l, speed * 1.2 * dt), 0.25);
          g.walk += dt * 1.2;
          g.heading = Math.atan2(tx, ty);
        } else g.heading = Math.atan2(dx, dy);
      } else if (dist < 7) {
        const bx = g.x;
        const by = g.y;
        move(g, -nx * speed * 0.8 * dt, -ny * speed * 0.8 * dt, 0.25);
        if (g.x !== bx || g.y !== by) g.walk += dt;
        g.heading = Math.atan2(dx, dy);
      }
      return;
    }
    // Flankers go round to your side; the boss swaps between flanking and cover.
    g.flankFor -= dt;
    if (g.role === "flank" && g.flankFor <= 0 && (g.sees || g.lastSeen < 2) && dist < 14) {
      g.flankFor = rand(6, 9);
      const cell = flankCell(g);
      g.path = cell >= 0 ? pathTo(cellOf(g), cell).slice(0, 14) : [];
      if (g.type === "boss" && Math.random() < 0.4) g.path.length = 0;
    }
    if (g.crouch > 0) {
      // Ducked: he stays put behind his cover and watches.
      g.heading = Math.atan2(dx, dy);
    } else if (g.role === "flank" && g.path.length && g.flankFor > 0) {
      followPath(g, speed * 1.2, dt);
      if (g.sees) g.heading = Math.atan2(dx, dy);
    } else if (g.sees) {
      // Cover behind a desk or a partition edge when one is near; the boss keeps moving between them.
      g.coverFor -= dt;
      if (g.coverFor <= 0) {
        g.cover = findCover(g);
        g.coverFor = g.type === "boss" ? rand(1.4, 2.4) : g.type === "soldier" ? rand(2, 3.2) : rand(2.5, 4);
      }
      if (g.cover) {
        const tx = g.cover.x - g.x;
        const ty = g.cover.y - g.y;
        const l = Math.hypot(tx, ty);
        if (l > 0.1) {
          const s = Math.min(l, speed * 1.2 * dt);
          move(g, (tx / l) * s, (ty / l) * s, 0.25);
          g.walk += dt;
        }
      } else {
        g.strafeFor -= dt;
        if (g.strafeFor <= 0) {
          g.strafe = Math.random() < 0.5 ? -1 : 1;
          g.strafeFor = rand(0.8, 2);
        }
        const toward = dist > (g.type === "soldier" || g.type === "boss" ? 4.5 : GUARD_KEEPS) ? 1 : 0;
        const bx = g.x;
        const by = g.y;
        move(g, (nx * toward - ny * g.strafe * 0.55) * speed * dt, (ny * toward + nx * g.strafe * 0.55) * speed * dt, 0.25);
        if (g.x === bx && g.y === by) g.strafe *= -1;
        g.walk += dt;
      }
      g.heading = Math.atan2(dx, dy);
    } else {
      // Hunt: follow the way to you through the doors.
      g.cover = null;
      g.coverFor = 0;
      const gx = Math.floor(g.x);
      const gy = Math.floor(g.y);
      const here = walkCell(gx, gy) ? flow[gy * MAP_W + gx] : -1;
      let best = -1;
      let tx = player.x;
      let ty = player.y;
      for (const [ddx, ddy] of N4) {
        if (!walkCell(gx + ddx, gy + ddy)) continue;
        const f = flow[(gy + ddy) * MAP_W + gx + ddx];
        if (f >= 0 && (best < 0 || f < best)) {
          best = f;
          tx = gx + ddx + 0.5;
          ty = gy + ddy + 0.5;
        }
      }
      if (here === 0 || (here > 0 && best >= here)) {
        tx = player.x;
        ty = player.y;
      }
      const l = Math.hypot(tx - g.x, ty - g.y) || 1;
      move(g, ((tx - g.x) / l) * speed * dt, ((ty - g.y) / l) * speed * dt, 0.25);
      g.heading = Math.atan2(tx - g.x, ty - g.y);
      g.walk += dt;
    }
    // Pulling the trigger.
    if (g.burstLeft > 0 || g.reload > 0 || floorClock <= GRACE_SECONDS || g.mag <= 0) return;
    const army = g.type === "soldier" || g.type === "boss";
    if (g.sees) {
      g.reload = rand(...g.stats.every) / Math.sqrt(diff.accuracy);
      g.burstLeft = Math.min(g.mag, g.type === "soldier" ? diff.burst : g.stats.burst);
      g.burstT = 0;
      // Soldiers often drop to a knee for a burst.
      if (g.type === "soldier" && g.crouch <= 0 && Math.random() < 0.35) g.crouch = g.burstLeft * g.stats.gap + rand(0.5, 1.2);
      if (army) sound.armyShot(Math.sin(relAngle(g.x, g.y)), dist);
    } else if (army && g.lastSeen < 2.5 && dist < 18 && g.role === "push" && seesFrom(g.x, g.y, g.lastX, g.lastY)) {
      // Suppressing fire at where you were: rounds snapping into your cover while someone goes round.
      g.reload = rand(...g.stats.every) * 1.6;
      g.mag = Math.max(0, g.mag - 3);
      g.ps.recoil = 1;
      sound.armyShot(Math.sin(relAngle(g.x, g.y)), dist);
      if (g.ch.muzzle) g.ch.muzzle.getWorldPosition(vA);
      else vA.set(g.x * U, 1.4, g.y * U);
      const ex = g.lastX - g.x;
      const ey = g.lastY - g.y;
      const el = Math.hypot(ex, ey) || 1;
      let s = 0.5;
      while (s < el + 3 && !opaque(g.x + (ex / el) * s, g.y + (ey / el) * s)) s += 0.25;
      vB.set((g.x + (ex / el) * s + rand(-0.3, 0.3)) * U, rand(0.5, 1.6), (g.y + (ey / el) * s + rand(-0.3, 0.3)) * U);
      addTracer(vA, vB, THEIR_TRACER);
      addSpark(vB);
      if (Math.hypot(vB.x / U - player.x, vB.z / U - player.y) < 1.5) shake = Math.max(shake, 0.01);
    }
  };

  /** Doors want open when you come near and the elevator is yours; they close behind you on a ride. */
  const updateCars = (dt: number) => {
    for (const car of cars) {
      const d = Math.hypot(car.x - player.x, car.y - player.y);
      let want = false;
      if (phase === "play" && !(ride && ride.car === car)) {
        if (car.roof) want = true;
        else if (car.up) {
          if (floorDone && d < 3.2) {
            if (alarm && car.call !== 0) {
              if (car.call < 0) car.call = CALL_SECONDS;
              car.call = Math.max(0, car.call - dt);
              want = car.call === 0;
            } else want = true;
          }
        } else if (floorIndex === LAST) want = finale > 0 ? d < 3.2 : d < 1.3;
        else want = d < 3.2;
      }
      car.open = Math.min(1, Math.max(0, car.open + (want ? dt : -dt) / DOOR_SECONDS));
    }
  };

  const showResults = (won: boolean, reason: string) => {
    if (phase === "results") return;
    phase = "results";
    keypad = null;
    trigger = false;
    sound.alarm(false);
    sound.helicopter(false);
    sound.wind(false);
    if (won) sound.win();
    if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
    const diff = DIFFICULTIES[difficulty];
    const accuracy = shots ? Math.round((hits / shots) * 100) : 0;
    const score = Math.max(
      0,
      Math.round(((won ? 5000 : 0) + kills * 60 + headshots * 30 + intel * 400 + accuracy * 12 - alarms * 350 - deaths * 600 - civiliansHit * 500 + (won ? Math.max(0, 1200 - elapsed) * 3 : floorIndex * 300)) * diff.score),
    );
    const rank = !won ? "C" : score >= 9000 ? "S" : score >= 7000 ? "A" : score >= 5000 ? "B" : "C";
    const best = readBest();
    if (score > best && !godUsed && !testUsed) {
      try {
        localStorage.setItem(BEST_KEY, String(score));
      } catch {
        // Storage can be unavailable; the score still shows.
      }
    }
    const time = `${Math.floor(elapsed / 60)}:${String(Math.floor(elapsed % 60)).padStart(2, "0")}`;
    setText(resultsEl.querySelector(".raid-kicker")!, `${testUsed ? "Test run · " : ""}${godUsed ? "God mode · " : ""}${diff.name} · ${won ? "Mission complete" : "Mission failed"}`);
    setText(resultsEl.querySelector("h2")!, won ? "You're out with the secrets." : reason === "Locked down" ? "Locked down." : "Caught.");
    setText(resultsEl.querySelector(".raid-rank b")!, rank);
    setText(resultsEl.querySelector(".raid-rank span")!, `Score ${score}`);
    const rows: [string, string][] = [
      ["Time", time],
      ["Kills", String(kills)],
      ["Headshots", String(headshots)],
      ["Accuracy", `${accuracy}%`],
      ["Alarms raised", String(alarms)],
      ["Intel found", `${intel} / ${FLOORS.length}`],
      ["Deaths", String(deaths)],
      ["Civilians hit", String(civiliansHit)],
      ["Floor reached", onRoof || won ? "Roof" : String(Math.min(floorIndex + 1, FLOORS.length))],
    ];
    resultsEl.querySelector("dl")!.innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
    setText(
      resultsEl.querySelector(".raid-best")!,
      godUsed ? "God mode was on: the best score is not saved." : testUsed ? "Test tools were used: the best score is not saved." : score > best ? "A new best score." : `Best score ${best}`,
    );
    resultsEl.classList.add("shown", won ? "won" : "lost");
    lastSummary = `${won ? "Out with the secrets" : reason}: rank ${rank}, score ${score}, ${kills} down, ${accuracy}% accuracy.`;
  };
  let lastSummary = "";

  // ---- the floor's job, pickups and interactions ----
  /** Ammunition into reserve, up to what each kind can hold; returns whether anything went in. */
  const giveAmmo = (ammo: AmmoType, n: number) => {
    const max = WEAPON_IDS.find((id) => WEAPONS[id].ammo === ammo)!;
    const before = inv.reserve[ammo];
    inv.reserve[ammo] = Math.min(WEAPONS[max].reserveMax, before + n);
    return inv.reserve[ammo] > before;
  };
  const AMMO_NAME: Record<AmmoType, string> = { pistol: "Pistol rounds", rifle: "Rifle rounds", shell: "Shells" };
  const takePickup = (p: Pickup): boolean => {
    switch (p.kind) {
      case "medkit":
        if (player.health >= maxHealth) return false;
        player.health = Math.min(maxHealth, player.health + MEDKIT_HEAL);
        showBanner(`Medkit +${MEDKIT_HEAL}`);
        sound.pickup();
        return true;
      case "intel":
        intel++;
        showBanner(`Intel ${intel} of ${FLOORS.length}`);
        radio("Nice find. That's worth something to the right people.");
        sound.pickup();
        return true;
      case "ammo": {
        const ammo = p.ammo ?? "pistol";
        const usable = ammo === "pistol" || (ammo === "rifle" && inv.owned.rifle) || (ammo === "shell" && inv.owned.shotgun);
        const n = ammo === "rifle" ? 30 : ammo === "shell" ? 6 : 12;
        if (!(usable ? giveAmmo(ammo, n) : giveAmmo("pistol", 12))) return false;
        showBanner(`${usable ? AMMO_NAME[ammo] : AMMO_NAME.pistol} +${usable ? n : 12}`);
        sound.pickupAmmo();
        return true;
      }
      case "locker": {
        let any = giveAmmo("pistol", 36);
        if (inv.owned.rifle) any = giveAmmo("rifle", 90) || any;
        if (inv.owned.shotgun) any = giveAmmo("shell", 16) || any;
        if (!any) return false;
        showBanner("Ammo locker: reserves filled");
        sound.pickupAmmo();
        return true;
      }
      default: {
        const id = p.kind as WeaponId;
        if (inv.owned[id]) {
          // One you have: take what is in it.
          if (id === "shield") {
            if (inv.shield >= WEAPONS.shield.durability) return false;
            inv.shield = WEAPONS.shield.durability;
            showBanner("A fresh shield");
          } else {
            if (!giveAmmo(WEAPONS[id].ammo, id === "rifle" ? 30 : 6)) return false;
            showBanner(`${AMMO_NAME[WEAPONS[id].ammo]} +${id === "rifle" ? 30 : 6}`);
          }
          sound.pickupAmmo();
          return true;
        }
        inv.owned[id] = true;
        if (id === "shield") inv.shield = WEAPONS.shield.durability;
        else {
          inv.mag[id as "rifle" | "shotgun"] = WEAPONS[id].magazine;
          giveAmmo(WEAPONS[id].ammo, id === "rifle" ? 30 : 6);
        }
        sound.pickup();
        showBanner(`Picked up ${WEAPONS[id].name} · ${owned().indexOf(id) + 1}`);
        if (id === "rifle") radio("His rifle's yours now. Full auto: short bursts, it climbs. Right click for the red dot, again to drop it.");
        else if (id === "shotgun") radio("A shotgun. Brutal up close, useless across a room.");
        else radio("His riot shield. Right click raises and lowers it; the pistol fires past its edge.");
        selectWeapon(id);
        return true;
      }
    }
  };
  const updateObjectives = (dt: number, pressedE: boolean) => {
    let usedE = pressedE;
    const takeE = () => {
      const was = usedE;
      usedE = false;
      return was;
    };
    for (const p of pickups) {
      if (p.taken || !near(p.at, REACH + 0.15)) continue;
      if (!takePickup(p)) continue;
      p.taken = true;
      stow(p.node);
      if (p.spot) p.spot.intensity = p.spot.base = 0;
    }
    if (keycardAt && !hasKey && near(keycardAt, REACH)) {
      hasKey = true;
      keyDoorOpen = true;
      flowFrom = -1;
      if (keycardNode) stow(keycardNode);
      if (keycardSpot) keycardSpot.intensity = keycardSpot.base = 0;
      if (keyDoorNode) {
        keyDoorNode.visible = false;
        blockers.splice(blockers.indexOf(keyDoorNode), 1);
      }
      sound.pickup();
      showBanner("Keycard: the server room is open");
    }
    if (badgeAt && badgeNode?.visible && near(badgeAt, REACH + 0.2)) {
      badgeNode.visible = false;
      sound.pickup();
      unlockFloor("Badge taken: the elevator is yours");
    }

    let busyHere = false;
    // Keypad doors.
    const door = doors.find((d) => !d.open && near(d, 2.05));
    if (door && !keypad) {
      prompt = { key: "E", text: door.known ? `Enter the door code · ${door.code}` : "Enter the door code", bar: null, warn: false };
      if (takeE()) {
        keypad = { door, input: "", flash: 0, ok: false };
        keys.clear();
        trigger = false;
      }
    }
    // Notes.
    const note = notes.find((n) => !n.read && near(n, 1.1));
    if (note && !prompt) {
      prompt = { key: "E", text: "Read the note", bar: null, warn: false };
      if (takeE()) {
        note.read = true;
        learnCode(note.door);
      }
    }
    // Terminals and cabinets you hold E at.
    const holdable = (s: Station) => !s.done && (s.kind === "Y" || s.kind === "F" || (s.kind === "T" && floorIndex === 0));
    const s = stations.find((st) => holdable(st) && near(st, USE_REACH));
    if (s && !prompt) {
      const need = s.kind === "Y" ? READ_SECONDS : HOLD_SECONDS;
      if (keys.has("KeyE") && !keypad) {
        if (holdAt !== s) hold = 0;
        holdAt = s;
        hold += dt;
        busyHere = true;
        if (hold >= need) {
          completeStation(s);
          holdAt = null;
          hold = 0;
        }
      } else {
        holdAt = null;
        hold = 0;
      }
      if (!s.done) prompt = { key: "Hold E", text: s.kind === "Y" ? "Read the door code" : s.kind === "F" ? "Pull the fuse" : "Hack the terminal", bar: hold / need, warn: false };
    } else if (!s) {
      holdAt = null;
      hold = 0;
    }
    // The download (open office) and the upload (server floor).
    if (floorIndex === 1 && !run && !prompt) {
      const t = stations.find((st) => st.kind === "T" && !st.done && near(st, USE_REACH));
      if (t) {
        prompt = { key: "E", text: "Start the download", bar: null, warn: false };
        if (takeE()) {
          startRun(t, DOWNLOAD_SECONDS, "Downloading the access codes", () => {
            finishStation(t);
            backupT = 0;
            unlockFloor("Access codes downloaded: the elevator is yours");
          });
          backupT = BACKUP_SECONDS;
          radio("Download's running. Backup security is on its way: about half a minute.");
        }
      }
    }
    if (floorIndex === LAST && !onRoof && hasKey && rackAt && !run && finale <= 0 && !floorDone && near(rackAt, USE_REACH + 0.3)) startRun(rackAt, UPLOAD_SECONDS, "Uploading the secrets", startFinale);
    if (run) {
      const r = run;
      const close = near(r.at, STAY_RANGE);
      if (close) {
        r.t += dt;
        busyHere = true;
      }
      r.spawnClock += dt;
      if (r.spawned < REINFORCE_MAX && r.spawnClock >= REINFORCE_EVERY) {
        r.spawnClock = 0;
        if (reinforce()) r.spawned++;
      }
      const pct = Math.floor((r.t / r.total) * 100);
      if (!prompt || close) prompt = close ? { key: "", text: `${r.label} · ${pct}%`, bar: r.t / r.total, warn: false } : { key: "", text: "Paused · get back in range", bar: r.t / r.total, warn: true };
      if (r.t >= r.total) {
        run = null;
        r.finish();
      }
    }
    if (backupT > 0 && floorIndex === 1) {
      backupT -= dt;
      if (backupT <= 0) {
        backupT = 0;
        raiseAlarm("Backup security has arrived.");
        for (let i = 0; i < 2; i++) reinforce();
      }
    }
    if (busyHere) {
      tickClock += dt;
      if (tickClock >= 0.5) {
        tickClock = 0;
        sound.progressTick();
      }
    } else tickClock = 0.4;

    // The lockdown: the army comes up the stairs in waves.
    if (finale > 0) {
      finale -= dt;
      const into = FINALE_SECONDS - finale;
      if (finaleWave < FINALE_WAVES.length && into >= FINALE_WAVES[finaleWave]) {
        finaleWave++;
        sound.armyRadio();
        for (let i = 0; i < WAVE_SIZE; i++) reinforce("soldier");
      }
      if (finale <= 0) {
        finale = 0;
        failReason = "Locked down";
        failT = 2.6;
        setText(downEl.querySelector("h2")!, "Locked down.");
        setText(downEl.querySelector("p")!, "The building sealed before you reached the elevator.");
        sound.alarm(false);
        sound.lose();
        return;
      }
    }

    // The elevator up: locked until the floor's job is done.
    const up = cars.find((c) => c.up);
    if (up && near(up, 1.9) && !prompt) {
      if (!floorDone) prompt = { key: "", text: `Elevator locked · ${objectiveText()}`, bar: null, warn: true };
      else if (alarm && up.call > 0) prompt = { key: "", text: `Alarm is up · the elevator is on its way · ${Math.ceil(up.call)} s`, bar: 1 - up.call / CALL_SECONDS, warn: true };
    }
  };
  const completeStation = (s: Station) => {
    if (s.kind === "Y") {
      s.done = true;
      sound.done();
      learnCode(s.door);
      return;
    }
    finishStation(s);
    const left = stations.filter((st) => st.kind === s.kind && !st.done).length;
    if (s.kind === "T") {
      if (!left) {
        gatesOpen = true;
        camsOff = true;
        flowFrom = -1;
        for (const f of flaps) f.visible = false;
        mats.gateLamp.color.setHex(MINT);
        showBanner("Cameras down, gates open");
        radio("Cameras are dark and the gates are open. Go.");
      } else showBanner(`Terminal hacked · ${left} to go`);
    } else if (s.kind === "F") {
      if (!left) unlockFloor("Laser grid down: the elevator is yours");
      else showBanner(`Fuse pulled · ${left} to go`);
      // The first fuse brings the first soldier: an army rifleman sent ahead. His rifle is the prize.
      if (floorIndex === 2 && left === stations.filter((st) => st.kind === "F").length - 1 && reinforce("soldier")) {
        sound.armyRadio();
        radio("Heads up: the army's sent a rifleman up ahead of the rest. Drop him and take his rifle.");
      }
    }
  };

  // ---- the roof ----
  const heliAt = (h: Heli, x: number, y: number, z: number, yaw: number, dt: number) => {
    h.node.position.set(x, y, z);
    h.node.rotation.y = yaw;
    h.rotor.rotation.y += dt * 28;
    h.tail.rotation.x += dt * 40;
    h.strobe.visible = Math.sin(roofClock * 8) > 0.6;
  };
  const lerp3 = (out: THREE.Vector3, ax: number, ay: number, az: number, bx: number, by: number, bz: number, t: number) => out.set(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t);
  const stairWave = (i: number) => {
    const d = stairDoors[i % stairDoors.length];
    if (!d) return;
    let alive = 0;
    for (const g of guards) if (g.dying === 0) alive++;
    const n = Math.min(ROOF_ALIVE - alive, difficulty === 0 ? 2 : i >= 3 ? 3 : 2);
    for (let k = 0; k < n; k++) spawnGuard(d.x + rand(-0.3, 0.3), d.y + rand(-0.2, 0.2) + k * 0.05, "hunter", k === 2 ? "armored" : "soldier");
    if (n > 0) {
      d.open = 1.6;
      sound.armyRadio();
    }
  };
  const DROP = { x: 36.5, y: 14.5 };
  const stepRoof = (dt: number) => {
    roofClock += dt;
    const into = roofClock;
    if (into > 0.5 && into - dt <= 0.5) {
      radio("You're on the roof. The bird is a minute and a half out, and the army is on the stairs.");
      radio("Hold the roof. Use the air conditioning units for cover.");
    }
    while (roofWave < ROOF_STAIR_WAVES.length && into >= ROOF_STAIR_WAVES[roofWave]) {
      if (ROOF_STAIR_WAVES[roofWave] < roofHold - 8) stairWave(roofWave);
      roofWave++;
    }
    for (const d of stairDoors) {
      d.open = Math.max(0, d.open - dt);
      d.node.rotation.y = -Math.min(1, d.open) * 1.6;
    }
    // The troop helicopter: in over the far side, soldiers down the rope, away again.
    if (troop) {
      const t = troop;
      t.t += dt;
      const hx = DROP.x * U;
      const hz = DROP.y * U;
      if (t.state === "wait") {
        if (into >= roofHold * 0.4) {
          t.state = "in";
          t.t = 0;
          sound.helicopter(true, 1);
          radio("Hostile helicopter! They're roping onto the roof, east side.");
        }
      } else if (t.state === "in") {
        const k = smooth(t.t / 7);
        lerp3(vA, cx + 160, 45, cz - 90, hx, 10.5, hz, k);
        heliAt(t.h, vA.x, vA.y, vA.z, Math.atan2(hx - (cx + 160), hz - (cz - 90)) * (1 - k) + -Math.PI / 2 * k, dt);
        if (t.t >= 7) {
          t.state = "drop";
          t.t = 0;
        }
      } else if (t.state === "drop") {
        heliAt(t.h, hx + Math.sin(roofClock * 0.7) * 0.4, 10.5 + Math.sin(roofClock * 1.3) * 0.2, hz, -Math.PI / 2, dt);
        const total = difficulty === 0 ? 3 : 4;
        if (t.dropped < total && t.t >= 0.6 + t.dropped * 1.2) {
          t.dropped++;
          const g = spawnGuard(DROP.x + rand(-0.06, 0.06), DROP.y + 0.08, "hunter", "soldier");
          g.rope = 1.8;
          g.z = 9;
          sound.rope();
        }
        if (ropeNode) {
          ropeNode.visible = true;
          ropeNode.scale.y = 10;
          // Hanging from the door, swinging a little in the rotor wash.
          ropeNode.position.set(hx + Math.sin(roofClock * 1.9) * 0.12, 5.2, hz + Math.sin(roofClock * 1.3) * 0.1);
          ropeNode.rotation.set(Math.sin(roofClock * 1.3) * 0.03, 0, Math.sin(roofClock * 1.9) * 0.035);
        }
        if (t.dropped >= total && t.t >= 0.6 + total * 1.2 + 1.5) {
          t.state = "out";
          t.t = 0;
          if (ropeNode) ropeNode.visible = false;
        }
      } else if (t.state === "out") {
        const k = smooth(t.t / 8);
        lerp3(vA, hx, 10.5, hz, cx - 200, 60, cz + 160, k);
        heliAt(t.h, vA.x, vA.y, vA.z, -Math.PI / 2 + k * 2.2, dt);
        if (t.t >= 8) {
          t.state = "gone";
          t.h.node.visible = false;
        }
      }
    }
    // The extraction: on final as the time runs out, down on the pad, its door open.
    if (extract) {
      const e = extract;
      e.t += dt;
      const px = PAD.x * U;
      const pz = PAD.y * U;
      if (e.state === "wait") {
        if (into >= roofHold - 10) {
          e.state = "in";
          e.t = 0;
          sound.helicopter(true, 1);
          radio("Your ride's on final. Keep the pad clear!");
          if (roofSpot) e.h.mount.add(roofSpot);
        }
      } else if (e.state === "in") {
        const k = e.t / 10;
        if (k < 0.7) lerp3(vA, cx - 180, 50, cz - 150, px, 9, pz, smooth(k / 0.7));
        else lerp3(vA, px, 9, pz, px, 0.02, pz, smooth((k - 0.7) / 0.3));
        heliAt(e.h, vA.x, vA.y, vA.z, Math.PI + (1 - smooth(Math.min(1, k / 0.8))) * -0.9, dt);
        if (e.t >= 10) {
          e.state = "landed";
          e.t = 0;
          showBanner("The helicopter is down: get in");
          radio("On the pad! Get in, get in!");
          for (let y = 13; y <= 16; y++) {
            const c = y * MAP_W + 29;
            if (Math.floor(player.x) !== 29 || Math.floor(player.y) !== y) heldCells.add(c);
          }
          flowFrom = -1;
        }
      } else if (e.state === "landed") {
        heliAt(e.h, px, 0.02, pz, Math.PI, dt);
        // The door faces west; walk up to it and you are in.
        const doorX = PAD.x - 0.95;
        const doorY = PAD.y + 0.1;
        const d = Math.hypot(player.x - doorX, player.y - doorY);
        if (d < 1.6) prompt = { key: "", text: "Boarding", bar: null, warn: false };
        if (d < 1.0) board();
      }
    }
    // The searchlight finds you; the rotor wash and the sound follow the nearest helicopter.
    let nearest = Infinity;
    let pan = 0;
    for (const h of helis) {
      if (!h.node.visible || h.node.position.x > cx + 300) continue;
      const d = Math.hypot(h.node.position.x - player.x * U, h.node.position.y - EYE, h.node.position.z - player.y * U);
      if (d < nearest) {
        nearest = d;
        pan = Math.sin(relAngle(h.node.position.x / U, h.node.position.z / U));
      }
    }
    if (nearest < Infinity) sound.setHelicopterDistance(Math.min(1, nearest / 90), pan);
    if (roofSpot) {
      roofSpot.target.position.lerp(vB.set(player.x * U, 0, player.y * U), Math.min(1, dt * 2.5));
      roofSpot.target.updateMatrixWorld();
      const holder = roofSpot.parent?.parent as THREE.Object3D | undefined;
      const h = helis.find((x) => x.node === holder);
      if (h) h.beam.lookAt(roofSpot.target.position);
      roofSpot.intensity = h && h.node.visible && h.node.position.x < cx + 300 ? 160 : 0;
    }
    if (windsock) {
      windsock.rotation.y = 0.6 + Math.sin(roofClock * 0.4) * 0.35 + Math.sin(roofClock * 2.3) * 0.08;
      windsock.rotation.x = -0.1 + Math.sin(roofClock * 1.7) * 0.06;
    }
  };
  /** You are in: the helicopter lifts off with you, then the results. */
  const board = () => {
    if (phase !== "play") return;
    phase = "extract";
    boardT = 0;
    trigger = false;
    keypad = null;
    camFrom.p.copy(camera.position);
    camFrom.q.copy(camera.quaternion);
    radio("Wheels up. Good work.");
    sound.alarm(false);
  };
  const stepExtract = (dt: number) => {
    boardT += dt;
    if (!extract) return;
    const h = extract.h;
    if (boardT < AERIAL_AT) {
      const px = PAD.x * U;
      const pz = PAD.y * U;
      const t = Math.max(0, boardT - 1.3);
      const up = smooth(t / 5.5);
      heliAt(h, px - up * 30 - t * t * 0.6, 0.02 + up * 32, pz + up * 10, Math.PI + up * 0.7, dt);
      h.node.rotation.x = -smooth(t / 2) * 0.12;
      h.node.rotation.z = Math.sin(boardT * 1.1) * 0.03;
    } else stepAerial(boardT - AERIAL_AT, dt);
    updateCinema(dt);
    if (boardT > AERIAL_AT + AERIAL_LEN) showResults(true, "");
  };

  // ---- the ending: outside, pulling away from the helicopter, and the tower goes up ----
  type Particle = { p: THREE.Vector3; v: THREE.Vector3; life: number; max: number; c: THREE.Color; size: number; grow: number; g: number; drag: number; spin: number };
  /** A pool of particles drawn as one instanced mesh: additive ones fade to black, the others shrink away. */
  const particles = (geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, additive: boolean) => {
    const mesh = new THREE.InstancedMesh(geo, mat, cap);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.visible = false;
    scene.add(mesh);
    const list: Particle[] = Array.from({ length: cap }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), life: 0, max: 1, c: new THREE.Color(), size: 1, grow: 0, g: 0, drag: 0, spin: 0 }));
    let n = 0;
    const col = new THREE.Color();
    const axis = new THREE.Vector3(1, 0.6, 0.3).normalize();
    return {
      mesh,
      add(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, color: number, size: number, grow = 0, g = 0, drag = 0, spin = 0) {
        if (n >= cap) return;
        const q = list[n++];
        q.p.set(x, y, z);
        q.v.set(vx, vy, vz);
        q.life = q.max = life;
        q.c.setHex(color);
        q.size = size;
        q.grow = grow;
        q.g = g;
        q.drag = drag;
        q.spin = spin;
      },
      update(dt: number) {
        for (let i = 0; i < n; i++) {
          const q = list[i];
          q.life -= dt;
          if (q.life <= 0) {
            list[i] = list[--n];
            list[n] = q;
            i--;
            continue;
          }
          q.v.y -= q.g * dt;
          if (q.drag) q.v.multiplyScalar(Math.max(0, 1 - q.drag * dt));
          q.p.addScaledVector(q.v, dt);
          const k = q.life / q.max;
          let s = q.size + q.grow * (q.max - q.life);
          if (!additive) s *= Math.min(1, k * 3);
          qA.setFromAxisAngle(axis, q.spin * (q.max - q.life));
          mtx.compose(q.p, qA, vA.setScalar(s));
          mesh.setMatrixAt(i, mtx);
          mesh.setColorAt(i, additive ? col.copy(q.c).multiplyScalar(k * k) : q.c);
        }
        mesh.count = n;
        mesh.visible = n > 0;
        if (n) {
          mesh.instanceMatrix.needsUpdate = true;
          mesh.instanceColor!.needsUpdate = true;
        }
      },
      clear() {
        n = 0;
        mesh.count = 0;
        mesh.visible = false;
      },
    };
  };
  const fx = particles(shapes.puff, mats.fx, 700, true);
  const smoke = particles(shapes.puff, mats.smoke, 220, false);
  const debris = particles(box(1, 1, 1), mats.debris, 140, false);
  const updateCinema = (dt: number) => {
    fx.update(dt);
    smoke.update(dt);
    debris.update(dt);
  };
  const AERIAL_AT = 4.6; // seconds after boarding: cut to the outside
  const AERIAL_LEN = 13;
  const BLAST_AT = [3.2, 3.75, 4.3, 4.85, 5.4, 6.1]; // the five floors from the bottom up, then the roof
  const aerCam = new THREE.Vector3();
  const aerLook = new THREE.Vector3();
  const aer = { on: false, from: new THREE.Vector3(), camEnd: new THREE.Vector3(), lookEnd: new THREE.Vector3(), cross: false, blasts: 0 };
  const TOWER = new THREE.Vector3();
  const WIDE = new THREE.Vector3();
  const pointOnFacade = (y: number, h: number, out: THREE.Vector3, normal: THREE.Vector3) => {
    const side = Math.floor(Math.random() * 4);
    const hw = (MAP_W * U) / 2 + 0.3;
    const hd = (MAP_H * U) / 2 + 0.3;
    const a = rand(-1, 1);
    if (side === 0) out.set(cx + a * hw, 0, cz - hd), normal.set(0, 0, -1);
    else if (side === 1) out.set(cx + a * hw, 0, cz + hd), normal.set(0, 0, 1);
    else if (side === 2) out.set(cx - hw, 0, cz + a * hd), normal.set(-1, 0, 0);
    else out.set(cx + hw, 0, cz + a * hd), normal.set(1, 0, 0);
    out.y = y + rand(-h / 2, h / 2);
    return out;
  };
  /** One floor goes: windows out as glowing shards, a fireball along the facade, debris, smoke. */
  const blast = (y: number, h: number, big: boolean) => {
    const n = big ? 1.6 : 1;
    for (let i = 0; i < 70 * n; i++) {
      pointOnFacade(y, h, vB, vC);
      const sp = rand(8, 22);
      fx.add(vB.x, vB.y, vB.z, vC.x * sp + rand(-4, 4), rand(2, 12), vC.z * sp + rand(-4, 4), rand(1.2, 2.2), Math.random() < 0.6 ? 0xfff0c0 : 0x9fd4ff, rand(0.25, 0.5), 0, 9, 0.2);
    }
    for (let i = 0; i < 26 * n; i++) {
      pointOnFacade(y, h, vB, vC);
      fx.add(vB.x + vC.x * 2, vB.y, vB.z + vC.z * 2, vC.x * rand(2, 6), rand(1, 5), vC.z * rand(2, 6), rand(0.9, 1.6), Math.random() < 0.5 ? 0xff7a1a : 0xffb347, rand(3, 6), rand(4, 9), -1, 0.8);
    }
    for (let i = 0; i < 18 * n; i++) {
      pointOnFacade(y, h, vB, vC);
      const sp = rand(6, 16);
      debris.add(vB.x, vB.y, vB.z, vC.x * sp + rand(-3, 3), rand(4, 14), vC.z * sp + rand(-3, 3), rand(2.5, 4), 0x2a2a2e, rand(0.3, 1.1), 0, 9.8, 0.05, rand(3, 9));
    }
    for (let i = 0; i < 10 * n; i++) {
      pointOnFacade(y, h, vB, vC);
      smoke.add(vB.x + vC.x * 3, vB.y, vB.z + vC.z * 3, vC.x * rand(1, 3) + 1.5, rand(2, 4), vC.z * rand(1, 3), rand(5, 8), Math.random() < 0.5 ? 0x2a2a30 : 0x3a3536, rand(2.5, 4), rand(0.8, 1.6));
    }
    if (big) {
      // The shockwave: a ring of light that rushes out, and a flash.
      fx.add(cx, y + 4, cz, 0, 0, 0, 0.7, 0xfff3d8, 10, 150, 0, 0);
      fx.add(cx, y + 8, cz, 0, 6, 0, 1.1, 0xff8a3a, 18, 24, 0, 0);
      for (const l of activeSpots) l.intensity = 0;
    }
  };
  const startAerial = () => {
    aer.on = true;
    aer.from.copy(extract!.h.node.position);
    aer.cross = false;
    aer.blasts = 0;
    fog.near = 160;
    fog.far = 900;
    sound.wind(false);
    if (roofSpot) roofSpot.intensity = 0;
    for (const h of helis) h.beam.visible = false;
    if (troop) troop.h.node.visible = false;
    TOWER.set(cx, -floorBase(FLOORS.length) * 0.45, cz);
    WIDE.set(cx + 88, 64, cz + 112);
    // Towers standing between the camera and the HQ step aside for the shot.
    vB.copy(TOWER).sub(WIDE);
    const len = vB.length();
    vB.normalize();
    for (const o of city.children) {
      if (!(o as THREE.Mesh).isMesh || (o as THREE.InstancedMesh).isInstancedMesh || o === ground) continue;
      vC.copy(o.position).add(city.position).sub(WIDE);
      const along = vC.dot(vB);
      if (along > 0 && along < len + 30 && vC.addScaledVector(vB, -along).setY(0).length() < 32) o.visible = false;
    }
  };
  const stepAerial = (t: number, dt: number) => {
    if (!aer.on) startAerial();
    const h = extract!.h;
    // The helicopter flies off, nose down a little; later its silhouette crosses the burning tower.
    if (t < 7.5) {
      vA.set(-1, 0.28, 0.45).normalize();
      h.node.position.copy(aer.from).addScaledVector(vA, 12 * t + 0.9 * t * t);
      heliAt(h, h.node.position.x, h.node.position.y, h.node.position.z, Math.atan2(vA.x, vA.z), dt);
      h.node.rotation.x = 0.15;
    } else {
      // A line across the frame between the camera and the tower.
      vB.copy(TOWER).sub(WIDE).normalize(); // forward
      vC.crossVectors(vB, vU.set(0, 1, 0)).normalize(); // right
      const k = (t - 7.5) / 5;
      vA.copy(WIDE).addScaledVector(vB, 60).addScaledVector(vC, -70 + 140 * k);
      vA.y += 6 + k * 4;
      heliAt(h, vA.x, vA.y, vA.z, Math.atan2(vC.x, vC.z), dt);
      h.node.rotation.x = 0.12;
      h.node.rotation.z = -0.08;
    }
    // The camera: close behind the helicopter, then up and back to take in the whole tower.
    const near = smooth(t / 3);
    if (t < 3) {
      aerCam.copy(h.node.position).add(vA.set(10 + 34 * near, 3 + 26 * near, 14 + 50 * near));
      if (t === 0 || aer.camEnd.lengthSq() === 0) aer.camEnd.copy(aerCam);
      aer.camEnd.copy(aerCam);
      aerLook.copy(h.node.position).lerp(TOWER, smooth((t - 0.6) / 2.4));
      aer.lookEnd.copy(aerLook);
    } else {
      const k = smooth((t - 3) / 4.5);
      aerCam.copy(aer.camEnd).lerp(WIDE, k);
      aerLook.copy(aer.lookEnd).lerp(TOWER, k);
    }
    // The blasts climb the floors; each one is heard a moment later across the distance.
    while (aer.blasts < BLAST_AT.length && t >= BLAST_AT[aer.blasts]) {
      const i = aer.blasts++;
      const roofBlast = i === facade.length;
      const f = facade[Math.min(i, facade.length - 1)];
      if (f) blast(roofBlast ? 1.5 : f.y, roofBlast ? 4 : f.h, roofBlast);
      // Heard a moment later: explosion() delays and dulls by distance itself.
      const metres = aerCam.distanceTo(TOWER);
      sound.explosion(metres);
      if (roofBlast) {
        sound.explosion(metres * 0.8);
        player.blind = Math.max(player.blind, 0.5);
        shake = 0.02;
      }
    }
    // The window bands: lights flicker out floor by floor ahead of the blasts, then the fires glow.
    for (let i = 0; i < facade.length; i++) {
      const m = facade[i].mat;
      const gone = aer.blasts > i;
      const flicker = t > BLAST_AT[i] - 0.9;
      if (gone) m.color.setRGB(1.4 + Math.random() * 0.6, 0.45 + Math.random() * 0.2, 0.1);
      else if (flicker) m.color.setHex(Math.random() < 0.45 ? 0x111111 : 0xffe2b8);
      else m.color.setHex(0xffe2b8);
    }
    // Fire and smoke keep pouring out of the floors that went.
    for (let i = 0; i < Math.min(aer.blasts, facade.length); i++) {
      const f = facade[i];
      if (Math.random() < dt * 60) {
        pointOnFacade(f.y, f.h, vB, vC);
        fx.add(vB.x + vC.x, vB.y, vB.z + vC.z, vC.x * 1.5, rand(3, 6), vC.z * 1.5, rand(0.6, 1.1), Math.random() < 0.5 ? 0xff6a1a : 0xffa13a, rand(1.8, 3.4), rand(1.5, 3), -1, 0.5);
      }
      if (Math.random() < dt * 3) {
        pointOnFacade(f.y, f.h, vB, vC);
        smoke.add(vB.x + vC.x * 2, vB.y + 2, vB.z + vC.z * 2, 2 + vC.x, rand(3, 5), vC.z, rand(6, 9), 0x2c2b2f, rand(2.5, 4), rand(1, 2));
      }
    }
    // The rotor fades into the distance.
    sound.setHelicopterDistance(Math.min(1, h.node.position.distanceTo(aerCam) / 160), 0);
  };

  const step = (dt: number) => {
    const pressedE = ePressed;
    ePressed = false;
    // Effects run even when paused, so nothing freezes mid-air.
    updateEffects(dt);
    hitmark = Math.max(0, hitmark - dt);
    headshotFlash = Math.max(0, headshotFlash - dt);
    banner = Math.max(0, banner - dt);
    player.hurt = Math.max(0, player.hurt - dt);
    player.land = Math.max(0, player.land - dt);
    player.blind = Math.max(0, player.blind - dt);
    shake *= Math.exp(-dt * 9);
    for (const a of arcs) a.life = Math.max(0, a.life - dt);
    if (keypad) keypad.flash = Math.max(0, keypad.flash - dt);
    // The radio types its line, holds it, then takes the next.
    if (!radioLine && radioQueue.length) {
      radioLine = radioQueue.shift()!;
      radioShown = 0;
      radioHold = 0;
    }
    if (radioLine) {
      radioShown += dt * 45;
      if (radioShown >= radioLine.length) {
        radioHold += dt;
        if (radioHold > 3.4) radioLine = "";
      }
    }
    if (alarmSoundT > 0) {
      alarmSoundT -= dt;
      if (alarmSoundT <= 0 && finale <= 0) sound.alarm(false);
    }
    prompt = null;

    if (phase === "intro") {
      const line = INTRO[introLine];
      if (line) {
        introChars += dt * 40;
        if (introChars >= line.length) {
          introHold += dt;
          if (introHold > 0.9) {
            introLine++;
            introChars = 0;
            introHold = 0;
          }
        }
      } else {
        introHold += dt;
        if (introHold > 0.6 && !loading) startPlay();
      }
      return;
    }
    if (phase === "extract") {
      stepExtract(dt);
      return;
    }
    if (phase === "results" && aer.on) {
      // The tower keeps burning behind the results.
      boardT += dt;
      stepAerial(boardT - AERIAL_AT, dt);
      updateCinema(dt);
      return;
    }
    if (phase !== "play" || paused()) return;

    if (downT > 0 || restarting) {
      if (downT > 0) {
        downT -= dt;
        if (downT <= 0) restartFloor();
      }
      return;
    }
    if (failT > 0) {
      failT -= dt;
      if (failT <= 0) showResults(false, failReason);
      return;
    }

    if (loading && !ride) return;
    elapsed += dt;
    floorClock += dt;
    spotCooldown = Math.max(0, spotCooldown - dt);
    updateCars(dt);

    // The elevator ride: doors close, the car hums and shakes, the next floor (or the roof) replaces this one.
    if (ride) {
      const r = ride;
      r.t += dt;
      if (r.phase === "closing") {
        if (r.car.open <= 0) {
          r.phase = "moving";
          r.t = 0;
        }
      } else {
        shake = Math.max(shake, 0.005);
        // The next floor is built while the car rides; the doors stay shut until it is ready.
        if (!r.swapped && !r.loading && r.t >= RIDE_SECONDS / 2) {
          r.loading = true;
          const [u, v] = carLocal(r.car, player.x, player.y);
          const rel = player.yaw - carYaw(r.car);
          const arrive = () => {
            const to = cars.find((c) => !c.up)!;
            const [x, y] = fromLocal(to.dir, u, v);
            player.x = Math.floor(to.x) + x;
            player.y = Math.floor(to.y) + y;
            player.px = player.x;
            player.py = player.y;
            player.yaw = carYaw(to) + rel;
            player.health = Math.min(maxHealth, player.health + FLOOR_HEAL);
            // A few rounds for the pistol on every floor, so you are never left with nothing.
            inv.reserve.pistol = Math.max(inv.reserve.pistol, 24);
            copyInv(inv, saved);
            r.car = to;
          };
          (r.exit ? loadRoof(arrive) : loadFloor(floorIndex + 1, false, arrive)).then(() => {
            r.swapped = true;
          }, swallow);
        }
        if (r.swapped && r.t >= RIDE_SECONDS) {
          ride = null;
          sound.ding();
          if (!onRoof) radio(ARRIVE[floorIndex]);
        }
      }
      return;
    }

    // Weapons: switching, reloading, the sights, the trigger.
    sinceShot += dt;
    const wantAds = adsHeld && weapon !== "shield" && !wantWeapon && reloadT < 0 && !keypad;
    ads = Math.min(1, Math.max(0, ads + (wantAds ? dt : -dt) / 0.15));
    finishSwitch();
    stepReload(dt);
    fireCooldown = Math.max(0, fireCooldown - dt);
    if (pumpSoundT > 0) {
      pumpSoundT -= dt;
      if (pumpSoundT <= 0) {
        sound.shotgunPump();
        addCasing(true);
      }
    }
    if (trigger && !keypad && !wantWeapon && fireCooldown <= 0) {
      const auto = WEAPONS[weapon].fireMode === "auto";
      if (auto || triggerFresh) fire();
    }
    triggerFresh = false;
    if (muzzleLight.intensity > 0) muzzleLight.intensity = Math.max(0, muzzleLight.intensity - dt * 500);

    // Walking, crouching and jumping: W forward, S back, A left, D right; the arrow keys turn without a mouse.
    const forward = keypad ? 0 : (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0) - (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0);
    const right = keypad ? 0 : (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
    const turn = keypad ? 0 : (keys.has("ArrowRight") ? 1 : 0) - (keys.has("ArrowLeft") ? 1 : 0);
    player.yaw += turn * TURN_SPEED * dt;
    const wantCrouch = !keypad && (keys.has("ControlLeft") || keys.has("ControlRight"));
    player.crouch = Math.min(1, Math.max(0, player.crouch + (wantCrouch ? dt : -dt) * 7));
    const running = (keys.has("ShiftLeft") || keys.has("ShiftRight")) && player.crouch < 0.3;
    if (running && (forward || right)) adsHeld = false; // sprinting takes you off the sights
    player.px = player.x;
    player.py = player.y;
    const st = WEAPONS[weapon];
    const carry = weapon === "shield" && shieldRaised ? st.raisedSpeed : st.moveSpeed;
    const pace = (running ? SPRINT : 1) * (1 - player.crouch * (1 - CROUCH_SPEED)) * carry * (1 - ads * 0.4);
    if (forward || right) {
      const len = Math.hypot(forward, right);
      const speed = WALK * pace * dt;
      const f = (forward / len) * speed;
      const r = (right / len) * speed;
      const cos = Math.cos(player.yaw);
      const sin = Math.sin(player.yaw);
      move(player, cos * f - sin * r, sin * f + cos * r, PLAYER_RADIUS);
      player.walk += dt * pace;
      player.moving = Math.min(1, player.moving + dt * 6);
      if (player.z === 0) {
        stepClock += dt;
        if (stepClock >= (running ? 0.32 : player.crouch > 0.5 ? 0.6 : 0.45)) {
          stepClock = 0;
          sound.step(running, player.crouch > 0.5);
        }
      }
    } else {
      stepClock = 0.3;
      player.moving = Math.max(0, player.moving - dt * 6);
    }
    if (player.z > 0 || player.vz > 0) {
      player.vz -= GRAVITY * dt;
      player.z += player.vz * dt;
      if (player.z <= 0) {
        player.z = 0;
        player.vz = 0;
        player.land = 0.18;
        sound.step(true);
      }
    }

    for (const car of cars) {
      if (ride || car.open < 0.95 || onRoof) continue;
      const goesUp = car.up && floorDone;
      const exits = !car.up && floorIndex === LAST && finale > 0;
      if ((goesUp || exits) && inCar(car)) {
        ride = { car, phase: "closing", t: 0, swapped: false, loading: false, exit: exits };
        adsHeld = false;
        shieldRaised = false;
        keypad = null;
        trigger = false;
        if (exits) {
          finale = 0;
          radio("Doors are shut. Next stop, the roof.");
        }
      }
    }

    updateObjectives(dt, pressedE);
    if (failT > 0 || phase !== "play") return;
    if (onRoof) {
      stepRoof(dt);
      if (phase !== "play") return;
    }
    stepFlashbangs(dt);

    // Cameras: a sweep, a cone, and the alarm when you stay in view.
    for (const cam of cams) {
      if (cam.dead || camsOff) {
        cam.sees = false;
        cam.seen = 0;
        continue;
      }
      cam.t += dt;
      cam.yaw = cam.base + Math.sin(cam.t * cam.speed + cam.phase) * cam.amp;
      const dx = player.x - cam.mx;
      const dy = player.y - cam.my;
      let sees = false;
      if (Math.hypot(dx, dy) < CAM_RANGE && Math.abs(wrap(Math.atan2(dy, dx) - cam.yaw)) < CAM_FOV && seesFrom(cam.sx, cam.sy, player.x, player.y)) sees = true;
      cam.sees = sees;
      if (sees) {
        cam.seen += dt * (crouched() ? 0.6 : 1);
        if (cam.seen > CAM_NOTICE) {
          if (!alarm) raiseAlarm("A camera saw you.");
          else for (const g of guards) g.chase = Math.max(g.chase, CHASE_SECONDS);
        }
      } else cam.seen = Math.max(0, cam.seen - dt);
    }
    // Tripwires: cross one with your feet below the beam and the alarm goes.
    for (const w of wires) {
      w.flash = Math.max(0, w.flash - dt);
      const line = (w.alongX ? w.y : w.x) + 0.5;
      const a = w.alongX ? player.py : player.px;
      const b = w.alongX ? player.y : player.x;
      const along = w.alongX ? player.x : player.y;
      const lo = w.alongX ? w.x : w.y;
      const crossed = (a - line) * (b - line) <= 0 || Math.abs(b - line) < 0.08;
      if (crossed && along > lo && along < lo + 1 && player.z < WIRE_HEIGHT && w.flash <= 0) {
        w.flash = 1;
        raiseAlarm("You tripped a laser wire.");
      }
    }

    updateFlow();
    for (const g of guards) {
      updateGuard(g, dt);
      if (phase !== "play" || downT > 0 || failT > 0) return;
    }
    for (const c of civs) updateCiv(c, dt);
  };

  /** Calm until shooting or an alarm; then they run a few steps and cower. */
  const panicCiv = (c: Civ) => {
    if (c.state !== "calm") return;
    c.state = c.sit ? "cower" : "flee";
    c.sit = false;
    c.ps.sit = false;
    c.fleeFor = rand(1.2, 2);
  };
  const updateCiv = (c: Civ, dt: number) => {
    if (c.state === "down") {
      c.dying = Math.max(0, c.dying - dt);
      return;
    }
    const dx = c.x - player.x;
    const dy = c.y - player.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 26 && c.state === "calm") return;
    c.t += dt;
    if (alarm) panicCiv(c);
    if (c.witness > 0) {
      c.witness -= dt;
      if (c.witness <= 0) {
        // Still close and still watched: they call it in.
        c.witness = -1;
        if (dist < 7 && seesFrom(c.x, c.y, player.x, player.y)) raiseAlarm("A civilian called security.");
      }
    }
    if (c.state === "flee") {
      c.fleeFor -= dt;
      const l = dist || 1;
      const bx = c.x;
      const by = c.y;
      move(c, (dx / l) * 2.2 * dt, (dy / l) * 2.2 * dt, 0.2);
      if (c.x !== bx || c.y !== by) c.yaw = Math.atan2(c.x - bx, c.y - by);
      if (c.fleeFor <= 0 || (c.x === bx && c.y === by)) c.state = "cower";
    }
  };

  const startPlay = () => {
    phase = "play";
    floorClock = 0;
    copyInv(inv, saved);
    radio(ARRIVE[floorIndex]);
  };
  const beginIntro = () => {
    if (phase !== "menu") return;
    sound.start();
    lock();
    maxHealth = DIFFICULTIES[difficulty].health;
    player.health = maxHealth;
    phase = "intro";
    introLine = 0;
    introChars = 0;
    introHold = 0;
    if (import.meta.env.DEV) {
      const start = Number(hud.querySelector<HTMLSelectElement>("[data-test-floor]")?.value ?? 0);
      if (start > 0) testJump(start);
    }
    // The first floor was built before the difficulty was chosen: Easy has no extra guards.
    if (!DIFFICULTIES[difficulty].extra) {
      for (const g of guards) {
        const ch = map[Math.floor(g.y)]?.[Math.floor(g.x)];
        if (ch === "g") {
          g.dying = -1;
          g.node.visible = false;
          g.node.position.y = -50;
        }
      }
      guards = guards.filter((g) => g.dying !== -1);
    }
  };
  const skipIntro = () => {
    if (phase === "intro" && !loading) startPlay();
  };

  const poseGuard = (g: Guard, dt: number) => {
    const ps = g.ps;
    g.node.position.set(g.x * U, g.z, g.y * U);
    g.node.rotation.y = g.heading;
    ps.recoil = Math.max(0, (ps.recoil ?? 0) - dt * 10);
    if (g.dying !== 0) {
      ps.fall = g.dying > 0 ? 1 - g.dying / 0.7 : 1;
      ps.pose = "idle";
      ps.aim = false;
      ps.stagger = 0;
      g.ch.setVisor(0x000000, 0);
      g.ch.setTint(0);
      return;
    }
    ps.fall = 0;
    const moved = Math.abs(g.walk - (g.node.userData.walk ?? 0)) > 1e-4;
    g.node.userData.walk = g.walk;
    ps.pose = g.rope > 0 ? "rope" : g.crouch > 0 ? (moved ? "crouchWalk" : "crouch") : moved ? (g.alert ? "run" : "walk") : "idle";
    ps.gait = g.walk * 9;
    ps.aim = g.alert && g.rope <= 0;
    ps.stagger = Math.min(1, g.stagger * 4);
    ps.look = g.alert ? 0 : Math.sin(g.look * 0.5) * 0.4;
    if (g.reloading <= 0) ps.reload = 0;
    const visor = g.type === "boss" ? GOLD : g.type === "soldier" ? (g.alert ? CORAL : 0x7fe08a) : g.alert ? CORAL : g.suspicion > 0 ? ACCENT : 0x6cc4ff;
    if (g.node.userData.visor !== visor) {
      g.node.userData.visor = visor;
      g.ch.setVisor(visor, g.type === "soldier" ? 0.6 : 2);
    }
    const tint = g.hurt > 0 ? 1 : 0;
    if (g.node.userData.tint !== tint) {
      g.node.userData.tint = tint;
      g.ch.setTint(tint);
    }
  };
  const ACT_POSE: Record<Civ["act"], PoseState["pose"]> = { type: "typing", sip: "sipping", talk: "talking", work: "typing" };
  const poseCiv = (c: Civ) => {
    const ps = c.ps;
    c.node.position.set(c.x * U, 0, c.y * U);
    c.node.rotation.y = c.yaw;
    ps.fall = c.state === "down" ? 1 - c.dying / 0.6 : 0;
    ps.pose = c.state === "cower" ? "cower" : c.state === "flee" ? "run" : c.state === "down" ? "idle" : ACT_POSE[c.act];
    ps.gait = c.t * 12;
    ps.sit = c.sit && c.state === "calm";
    ps.look = c.state === "calm" ? Math.sin(c.t * 0.45 + c.x) * 0.3 : 0;
  };

  const draw = (dt: number, clock: number) => {
    const playing = phase === "play" && !paused();
    const moving = playing && !keypad && !ride && player.moving > 0.05;
    const bob = moving && player.z === 0 ? Math.sin(player.walk * 10) * 0.035 * (1 - player.crouch * 0.5) : 0;
    const dip = player.land > 0 ? Math.sin((player.land / 0.18) * Math.PI) * 0.07 : 0;
    if ((phase === "extract" || phase === "results") && aer.on) {
      // Outside: the helicopter pulling away, the tower going up behind it.
      camera.position.copy(aerCam);
      camera.position.y += (Math.random() - 0.5) * shake * 20;
      camera.lookAt(aerLook);
    } else if (phase === "extract" && extract) {
      // Riding out on the bench, looking through the open door at the roof falling away.
      const h = extract.h;
      h.node.updateMatrixWorld();
      vA.set(-0.5, 1.55, -0.2).applyMatrix4(h.node.matrixWorld);
      vB.set(3, 1.2 - Math.min(1, boardT / 4) * 1.2, 0.6).applyMatrix4(h.node.matrixWorld);
      look.position.copy(vA);
      look.lookAt(vB);
      // Object3D.lookAt points +z at the target; a camera looks down -z.
      look.rotateY(Math.PI);
      const k = smooth(boardT / 1.1);
      camera.position.copy(camFrom.p).lerp(vA, k);
      camera.quaternion.copy(camFrom.q).slerp(look.quaternion, k);
    } else {
      camera.position.set(player.x * U, EYE - player.crouch * CROUCH_DROP + bob + player.z - dip, player.y * U);
      camera.rotation.y = -player.yaw - Math.PI / 2 + (Math.random() - 0.5) * shake - anim.viewYaw;
      camera.rotation.x = player.pitch + (Math.random() - 0.5) * shake + shake * 0.5 + anim.viewPitch;
      camera.rotation.z = 0;
    }
    // Your hands: shown only in play; the muzzle light stays in the scene (its intensity goes to 0) so the
    // light count never changes.
    const showGun = phase === "play" && downT <= 0 && failT <= 0;
    guns[weapon].node.visible = showGun;
    if (!showGun) muzzleLight.intensity = 0;
    anim.walk = player.walk;
    anim.moving = moving ? player.moving : 0;
    anim.crouch = player.crouch;
    anim.lower = keypad ? 1 : 0;
    anim.empty = magOf(weapon) === 0 && weapon !== "shotgun";
    anim.shieldUp = weapon === "shield" && shieldRaised;
    if (phase !== "play") ads = 0;
    anim.ads = ads;
    // The sights zoom in a little (the rifle's red dot more); the mouse slows with the zoom.
    const fov = 74 * (1 - ads * (weapon === "rifle" ? 0.3 : 0.15));
    if (Math.abs(camera.fov - fov) > 1e-3) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    animateWeapon(guns[weapon], anim, dt);
    camera.updateMatrixWorld();
    guns[weapon].muzzle.getWorldPosition(vA);
    muzzleLight.position.copy(camera.worldToLocal(vA));

    // Posing: everyone in view, but the calm and the far only every second or third frame.
    poseTick++;
    for (let i = 0; i < guards.length; i++) {
      const g = guards[i];
      if (!g.node.visible) {
        g.node.position.set(g.x * U, g.z, g.y * U);
        continue;
      }
      if (!g.alert && g.dying === 0 && (i + poseTick) % 2 && Math.hypot(g.x - player.x, g.y - player.y) > 12) continue;
      poseGuard(g, dt);
      poseCharacter(g.ch, g.ps, clock);
    }
    for (let i = 0; i < civs.length; i++) {
      const c = civs[i];
      if (!c.node.visible) continue;
      if (c.state === "calm" && (i + poseTick) % 3 && Math.hypot(c.x - player.x, c.y - player.y) > 9) continue;
      poseCiv(c);
      poseCharacter(c.ch, c.ps, clock);
    }
    for (const cam of cams) {
      if (cam.dead) continue;
      cam.head.rotation.y = -cam.yaw - Math.PI / 2;
      cam.cone.visible = !camsOff;
      cam.cone.material = cam.sees ? mats.coneHot : mats.coneIdle;
      cam.led.material = camsOff ? mats.camLedOff : mats.camLed;
    }
    for (const w of wires) w.beam.visible = w.flash > 0 ? Math.sin(clock * 40) > 0 : true;
    for (const d of doors) {
      d.t = Math.min(1, Math.max(0, d.t + (d.open ? dt : -dt) / 0.8));
      d.leaves[0].position.x = -0.475 - d.t * 0.9;
      d.leaves[1].position.x = 0.475 + d.t * 0.9;
      d.lamp.color.setHex(d.open ? MINT : keypad?.door === d && keypad.flash > 0 && !keypad.ok ? 0xffffff : CORAL);
    }
    for (const car of cars) {
      car.doors[0].position.x = -0.28 - car.open * 0.48;
      car.doors[1].position.x = 0.28 + car.open * 0.48;
      const usable = car.roof || (car.up ? floorDone : floorIndex !== LAST || finale > 0);
      car.arrow.color.setHex(usable ? ACCENT : CORAL);
      const movingCar = ride?.car === car && ride.phase === "moving";
      drawIndicator(car, car.roof ? "R" : String(floorIndex + 1), movingCar);
    }
    // The car you ride counts up while the next floor is built.
    if (ride && !cars.includes(ride.car)) drawIndicator(ride.car, ride.exit ? "R" : String(floorIndex + 1), ride.phase === "moving");
    for (const node of [keycardNode, badgeNode]) {
      if (!node?.visible) continue;
      node.rotation.y += dt * 2;
      node.position.y = (node === badgeNode ? 0.6 : 1.1) + Math.sin(clock * 2.4) * 0.08;
    }
    for (const p of pickups) {
      if (p.taken) continue;
      if (p.lift > 0) {
        p.node.rotation.y += dt * 0.8;
        p.node.position.y = p.lift + Math.sin(clock * 2 + p.at.x) * 0.05;
      } else animatePickup(p.node.children[0], clock, p.phase);
    }
    tex.mist.offset.x = clock * 0.004;
    tex.mist.offset.y = clock * 0.002;
    mats.beacon.color.setScalar(Math.sin(clock * 3) > 0 ? 1 : 0.15).multiply(BEACON);
    if (finale > 0 && floorMats) {
      const pulse = 0.55 + 0.45 * Math.sin(clock * 6);
      for (const l of activeSpots) {
        if (!l.lamp) continue;
        l.color.setHex(ALARM);
        l.intensity = 26 * pulse;
      }
      floorMats.ceiling.emissive.setHex(ALARM);
      floorMats.ceiling.emissiveIntensity = 0.4 + pulse;
      hemi.color.setHex(0xff6a5a);
    }

    // People you cannot see (behind solid walls, or far) are not drawn, posed or (when calm) thought about often.
    cullT -= dt;
    if (cullT <= 0) {
      cullT = 0.12;
      // Hidden people also skip their bones' and hit boxes' matrices (a dozen bones and boxes each).
      for (const g of guards) g.node.visible = g.node.matrixWorldAutoUpdate = g.dying !== -1 || Math.hypot(g.x - player.x, g.y - player.y) < 18 ? inView(g.x, g.y) : false;
      for (const c of civs) c.node.visible = c.node.matrixWorldAutoUpdate = inView(c.x, c.y);
    }
    updateLightPool(dt);
    renderer.render(scene, camera);

    // HUD.
    hud.classList.toggle("hud-off", phase !== "play");
    hudT -= dt;
    if (hudT <= 0) {
      // Text that changes slowly is rebuilt five times a second, not every frame.
      hudT = 0.2;
      setText(floorEl, onRoof ? "Roof" : `Floor ${floorIndex + 1} / ${FLOORS.length}`);
      setText(floorName, onRoof ? "Extraction" : THEMES[floorIndex].name);
      setText(objectiveEl, objectiveText());
      let codes = "";
      for (const d of doors) if (d.known && !d.open) codes += `${codes ? " · " : ""}Door code ${d.code}`;
      setText(codesEl, codes);
      const list = owned();
      for (const s of slotEls) {
        const have = inv.owned[s.id];
        s.node.classList.toggle("owned", have);
        s.node.classList.toggle("on", have && (wantWeapon ?? weapon) === s.id);
        if (!have) continue;
        setText(s.key, String(list.indexOf(s.id) + 1));
        setText(s.ammo, s.id === "shield" ? `${Math.ceil((inv.shield / WEAPONS.shield.durability) * 100)}%` : `${magOf(s.id)} · ${reserveOf(s.id)}`);
        css(s.bar, "width", s.id === "shield" ? `${Math.round((inv.shield / WEAPONS.shield.durability) * 100)}%` : `${Math.round((magOf(s.id) / WEAPONS[s.id].magazine) * 100)}%`);
      }
    }
    alarmEl.classList.toggle("shown", alarm);
    const timerName = onRoof && extract && extract.state !== "landed" ? "Extraction" : finale > 0 ? "Lockdown" : backupT > 0 ? "Backup arrives" : "";
    const timerLeft = timerName === "Extraction" ? roofHold - roofClock : timerName === "Lockdown" ? finale : backupT;
    timerEl.classList.toggle("shown", !!timerName && phase === "play");
    if (timerName) {
      setText(timerLabel, timerName);
      setNum(timerNum, Math.max(0, Math.ceil(timerLeft)), clockText);
    }
    const fightingBoss = !!boss && boss.dying === 0 && boss.seenOnce && phase === "play";
    bossEl.classList.toggle("shown", fightingBoss);
    if (fightingBoss && boss) css(bossBar, "width", pct(Math.max(0, boss.health) / boss.maxHealth));
    css(bannerEl, "opacity", op(banner / 0.4));
    radioEl.classList.toggle("shown", !!radioLine && phase !== "intro" && phase !== "results");
    const enemy = radioLine.startsWith(KESSLER);
    radioEl.classList.toggle("enemy", enemy);
    setText(radioWho, enemy ? "Security channel" : "Handler");
    // The typed-out line: a new substring only when another letter appears.
    const typed = Math.min(radioLine.length, Math.floor(radioShown)) + (radioLine.length << 12);
    if (numCache.get(radioText) !== typed || radioText.dataset.line !== radioLine) {
      numCache.set(radioText, typed);
      radioText.dataset.line = radioLine;
      setText(radioText, (enemy ? radioLine.slice(KESSLER.length) : radioLine).slice(0, Math.max(0, Math.floor(radioShown) - (enemy ? KESSLER.length : 0))));
    }
    promptEl.classList.toggle("shown", !!prompt && phase === "play" && !keypad);
    if (prompt) {
      setText(promptKey, prompt.key);
      css(promptKey, "display", prompt.key ? "" : "none");
      setText(promptText, prompt.text);
      promptEl.classList.toggle("warn", prompt.warn);
      promptEl.classList.toggle("bar", prompt.bar !== null);
      css(promptBar, "width", pct(Math.round(Math.min(1, prompt.bar ?? 0) * 200) / 200));
    }
    keypadEl.classList.toggle("shown", !!keypad);
    if (keypad) {
      digitEls.forEach((d, i) => setText(d, keypad!.input[i] ?? ""));
      keypadEl.classList.toggle("wrong", keypad.flash > 0 && !keypad.ok);
      keypadEl.classList.toggle("ok", keypad.ok);
    }
    for (const a of arcs) {
      css(a.node, "opacity", op(a.life));
      if (a.life > 0 && a.node.dataset.angle !== String(a.angle)) {
        a.node.dataset.angle = String(a.angle);
        css(a.node, "transform", `translate(-50%, -50%) rotate(${a.angle.toFixed(2)}rad)`);
      }
    }
    css(healthBar, "width", pct(Math.round((Math.max(0, player.health) / maxHealth) * 100) / 100));
    healthBar.classList.toggle("low", player.health <= maxHealth * 0.35);
    healthEl.classList.toggle("crouched", player.crouch > 0.5);
    setNum(healthNum, Math.max(0, Math.ceil(player.health)));
    setNum(livesEl, deaths, (d) => "●".repeat(Math.max(0, MAX_DEATHS - d)) + "○".repeat(Math.min(MAX_DEATHS, d)));
    // The ammo panel, rebuilt only when what it shows changes (a number made of its inputs).
    const reloading = reloadT >= 0;
    const shieldUp = weapon === "shield" && shieldRaised;
    const ammoKey = shieldUp ? -1 - Math.ceil((inv.shield / WEAPONS.shield.durability) * 100) : WEAPON_IDS.indexOf(weapon) + 4 * (magOf(weapon) + 100 * (reserveOf(weapon) + 1000 * (reloading ? 1 : 0)));
    if (numCache.get(ammoNum) !== ammoKey) {
      numCache.set(ammoNum, ammoKey);
      if (shieldUp) {
        setText(ammoNum, `${Math.ceil((inv.shield / WEAPONS.shield.durability) * 100)}%`);
        setText(ammoNote, "Shield up");
      } else {
        setText(ammoNum, reloading && !WEAPONS[weapon].reloadPerShell ? "··" : String(magOf(weapon)));
        setText(ammoNote, reloading ? "Reloading" : magOf(weapon) === 0 ? (reserveOf(weapon) ? "R to reload" : "No ammo") : `/ ${reserveOf(weapon)}`);
      }
    }
    css(hurtEl, "opacity", op(player.hurt / 0.4));
    css(flashEl, "opacity", op(player.blind / 1.2));
    alarmGlow.classList.toggle("shown", (alarm || finale > 0) && phase === "play");
    const gap = (Math.tan(currentSpread()) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * (window.innerHeight / 2);
    const size = PIXELS[Math.round(Math.min(160, 16 + gap * 2))];
    css(crosshairEl, "width", size);
    css(crosshairEl, "height", size);
    css(crosshairEl, "opacity", op(1 - ads * 1.5));
    css(hitEl, "opacity", op(hitmark / 0.18));
    hitEl.classList.toggle("kill", hitKind === "kill");
    hitEl.classList.toggle("head", hitKind === "head");
    css(headshotEl, "opacity", op(headshotFlash / 0.3));
    if (headshotFlash > 0) css(headshotEl, "transform", `translateX(-50%) scale(${(1 + Math.max(0, headshotFlash - HEADSHOT_SECONDS + 0.15) * 3).toFixed(2)})`);
    introEl.classList.toggle("shown", phase === "intro" || phase === "menu");
    introEl.classList.toggle("typing", phase === "intro");
    if (phase === "intro") introLines.forEach((p, i) => setText(p, i < introLine ? INTRO[i] : i === introLine ? (INTRO[i] ?? "").slice(0, Math.floor(introChars)) : ""));
    downEl.classList.toggle("shown", downT > 0 || failT > 0 || restarting);
    startEl.classList.toggle("shown", phase === "menu");
    if (phase === "menu") for (let i = 0; i < diffButtons.length; i++) diffButtons[i].classList.toggle("on", i === difficulty);
    pausedEl.classList.toggle("shown", paused());
    host.classList.toggle("locked", locked);
    fadeEl.classList.toggle("shown", phase === "extract" && boardT > AERIAL_AT - 0.6 && boardT < AERIAL_AT + 0.05);
  };
  const BEACON = new THREE.Color(0xff2a1a);
  let poseTick = 0;

  const finish = () => {
    if (lastSummary) toast.info("Raid the HQ", lastSummary);
    onExit();
  };

  let booted = false;
  let frame = 0;
  let last = performance.now();
  let clock = 0;
  // The resolution is chosen once, from the screen (see ratioCap), and changes only when the window does:
  // changing it reallocates the drawing buffer, a visible hitch, so it never adapts during play.
  let ratio = ratioCap();
  // The last 120 frame times, for the F8 graph and its p99 and worst.
  const GRAPH = 120;
  const frameMs = new Float32Array(GRAPH);
  const sortedMs = new Float32Array(GRAPH);
  let frameAt = 0;
  // One dt per frame for everything, from the rAF timestamps: averaged over the last four frames so a
  // jittery timestamp does not make motion uneven, and capped so one long frame never teleports anyone.
  const recentDt = new Float32Array(4).fill(1 / 60);
  let recentAt = 0;
  let perfTime = 0;
  let perfFrames = 0;
  let showFps = false;
  const graph = document.createElement("canvas");
  graph.width = GRAPH * 2;
  graph.height = 48;
  graph.style.cssText = "display:block;margin-top:4px;width:240px;height:48px";
  const graphCtx = graph.getContext("2d");
  const fpsText = document.createElement("span");
  const fpsEl = el(".raid-fps");
  const countLights = () => {
    let n = muzzleLight.intensity > 0 ? 1 : 0;
    for (const slot of pool) if (slot.light.intensity > 0) n++;
    if (roofSpot && roofSpot.intensity > 0) n++;
    return n;
  };
  const drawGraph = () => {
    if (!graphCtx) return;
    const c = graphCtx;
    c.clearRect(0, 0, graph.width, graph.height);
    const y = (ms: number) => graph.height - Math.min(graph.height, (ms / 50) * graph.height);
    c.fillStyle = "rgba(255,255,255,0.18)";
    c.fillRect(0, y(16.7), graph.width, 1);
    c.fillStyle = "rgba(255,107,87,0.35)";
    c.fillRect(0, y(33.3), graph.width, 1);
    for (let i = 0; i < GRAPH; i++) {
      const ms = frameMs[(frameAt + i) % GRAPH];
      c.fillStyle = ms > 33.4 ? "#ff6b57" : ms > 20 ? "#ffb81f" : "#4fd6aa";
      const top = y(ms);
      c.fillRect(i * 2, top, 2, graph.height - top);
    }
  };
  const loop = (now: number) => {
    const raw = Math.max(0, (now - last) / 1000);
    last = now;
    frameMs[frameAt] = raw * 1000;
    frameAt = (frameAt + 1) % GRAPH;
    recentDt[recentAt] = Math.min(raw, 0.05);
    recentAt = (recentAt + 1) % recentDt.length;
    const dt = (recentDt[0] + recentDt[1] + recentDt[2] + recentDt[3]) / 4;
    clock += dt;
    // The mouse first: this frame's aim is what the step shoots along and what the frame shows.
    applyLook();
    step(dt);
    draw(dt, clock);
    perfTime += raw;
    perfFrames++;
    if (showFps) drawGraph();
    if (perfTime >= 1) {
      if (showFps) {
        sortedMs.set(frameMs);
        sortedMs.sort();
        setText(
          fpsText,
          `${Math.round(perfFrames / perfTime)} fps · p99 ${sortedMs[Math.floor(GRAPH * 0.99)].toFixed(1)} ms · worst ${sortedMs[GRAPH - 1].toFixed(1)} ms · ${renderer.info.render.calls} draws · ${countLights()} lights · ${renderer.info.programs?.length ?? 0} shaders · ${ratio.toFixed(2)}x`,
        );
      }
      perfTime = 0;
      perfFrames = 0;
    }
    frame = requestAnimationFrame(loop);
  };
  /** Loading with real stages: textures, the first floor, the lighting and shaders; then the loop starts. */
  const boot = async () => {
    report("Drawing textures", 0.2, 0);
    let t0 = performance.now();
    for (let i = 0; i < texJobs.length; i++) {
      texJobs[i]();
      if (performance.now() - t0 > SLICE_MS) {
        report("Drawing textures", 0.2 + (0.1 * (i + 1)) / texJobs.length, 0);
        await nextFrame();
        if (disposed) throw ABORT;
        t0 = performance.now();
      }
    }
    await drive(floorSteps(0, true), (label, f) => report(label, 0.3 + 0.45 * f, f));
    report("Preparing lights and materials", 0.76, 1);
    await nextFrame();
    if (disposed) throw ABORT;
    envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envMap;
    makeProbes();
    await nextFrame();
    if (disposed) throw ABORT;
    const probe = new THREE.Group();
    for (const m of Object.values(mats)) for (const one of Array.isArray(m) ? m : [m]) probe.add(new THREE.Mesh(box(0.1, 0.1, 0.1), one));
    await compileStaged((f) => report("Preparing weapons, people and materials", 0.78 + 0.2 * f, 1), [city, ...probe.children]);
    swapIn();
    report("Ready", 1, 1);
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (disposed) throw ABORT;
    booted = true;
    last = performance.now();
    frame = requestAnimationFrame(loop);
    onReady();
  };
  boot().catch((e: unknown) => {
    if (e !== ABORT) onError(e instanceof Error ? e : new Error(String(e)));
  });

  // ---- the controls ----
  const canvas = renderer.domElement;
  const lock = () => {
    const request = canvas.requestPointerLock?.() as unknown as Promise<void> | undefined;
    request?.catch?.(() => {});
  };
  const submitCode = () => {
    if (!keypad || keypad.input.length < 4) return;
    const k = keypad;
    if (k.input === k.door.code) {
      k.ok = true;
      k.door.open = true;
      k.door.known = true;
      flowFrom = -1;
      sound.done();
      showBanner("Door open");
      setTimeout(() => {
        if (keypad === k) keypad = null;
      }, 350);
    } else {
      k.flash = 0.5;
      k.door.wrong++;
      sound.empty();
      k.input = "";
      if (k.door.wrong % 3 === 0) {
        keypad = null;
        raiseAlarm("Three wrong codes.");
      }
    }
  };
  /**
   * The god-mode cheat code (`iddqd`, letters in sequence within 2 s, no modifiers), in every build:
   * toggles taking no damage, with a short notice. A run that had it on never records a best score.
   */
  const godCode = cheatMatcher(GOD_MODE_CODE, CHEAT_WINDOW_MS);
  const toggleGod = () => {
    god = !god;
    if (god) godUsed = true;
    hud.dataset.god = god ? "on" : "off";
    showBanner(god ? "GOD MODE ON" : "GOD MODE OFF");
  };
  const cheat = (e: KeyboardEvent) => {
    if (phase !== "play" && phase !== "intro") return;
    if (!godCode(e)) return;
    toggleGod();
  };
  /** Dev only: jump to a floor (0..4) or the roof (5), with the weapons found below it. */
  const testJump = (to: number) => {
    if (loading || ride || restarting) return;
    testUsed = true;
    for (const id of WEAPON_IDS) {
      if (!inv.owned[id]) continue;
      if (id === "shield") inv.shield = Math.max(inv.shield, WEAPONS.shield.durability);
      else inv.mag[id] = Math.max(inv.mag[id], WEAPONS[id].magazine);
      inv.reserve[WEAPONS[id].ammo] = Math.max(inv.reserve[WEAPONS[id].ammo], Math.floor(WEAPONS[id].reserveMax / 2));
    }
    keypad = null;
    trigger = false;
    sound.alarm(false);
    resetHands();
    const roof = to >= FLOORS.length;
    floorIndex = Math.min(to, LAST);
    (roof ? loadRoof(placeInCar) : loadFloor(to, true)).then(() => {
      copyInv(inv, saved);
      floorClock = 0;
      showBanner(roof ? "Test: the roof" : `Test: floor ${to + 1}`);
      if (phase === "play" && !roof) radio(ARRIVE[floorIndex]);
    }, swallow);
  };
  /** Dev only: the current floor's job, done (on the roof, the helicopter comes down now). */
  const testFinish = () => {
    testUsed = true;
    if (onRoof) {
      if (extract && extract.state === "wait") {
        roofClock = Math.max(roofClock, roofHold - 2);
        extract.state = "in";
        extract.t = 8;
        sound.helicopter(true, 0.5);
        if (roofSpot) extract.h.mount.add(roofSpot);
        if (troop && troop.state === "wait") {
          troop.state = "gone";
          troop.h.node.visible = false;
        }
      }
      return;
    }
    for (const d of doors) {
      d.open = d.known = true;
    }
    flowFrom = -1;
    if (floorIndex === 0) for (const s of stations) if (s.kind === "T" && !s.done) completeStation(s);
    if (floorIndex === 1) {
      const t = stations.find((s) => s.kind === "T");
      if (t && !t.done) finishStation(t);
      run = null;
      backupT = 0;
      unlockFloor("Test: access codes downloaded");
    }
    if (floorIndex === 2) for (const s of stations) if (s.kind === "F" && !s.done) completeStation(s);
    if (floorIndex === 3) unlockFloor("Test: badge taken");
    if (floorIndex === LAST && finale <= 0) {
      run = null;
      hasKey = keyDoorOpen = true;
      startFinale();
    }
  };
  /** Dev only: F9 next floor (Shift: previous, the roof counts), F10 finish the objective, F11 god mode. */
  const testKeys = (e: KeyboardEvent): boolean => {
    if (!["F9", "F10", "F11"].includes(e.code)) return false;
    e.preventDefault();
    if (e.repeat || (phase !== "play" && phase !== "intro")) return true;
    if (e.code === "F11") {
      testUsed = true;
      toggleGod();
    } else if (e.code === "F10") {
      if (phase === "play") testFinish();
    } else {
      const at = onRoof ? FLOORS.length : floorIndex;
      const to = Math.max(0, Math.min(FLOORS.length, at + (e.shiftKey ? -1 : 1)));
      if (to !== at) testJump(to);
    }
    return true;
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!booted) {
      if (e.code === "Escape") onExit();
      return;
    }
    // Ctrl crouches: none of its combinations (reload, find, save, print, close...) may reach the browser or the app.
    if ((e.ctrlKey || e.metaKey) && e.code !== "Escape" && phase !== "results") {
      e.preventDefault();
      e.stopPropagation();
    }
    if (import.meta.env.DEV && testKeys(e)) return;
    cheat(e);
    // The ending can be skipped once it has run a second.
    if (phase === "extract") {
      if (["Escape", "Enter", "Space"].includes(e.code) && boardT > 1) {
        e.preventDefault();
        showResults(true, "");
      }
      return;
    }
    if (e.code === "Escape") {
      // While the mouse is held the browser releases it on Esc (and the game pauses); a second Esc leaves.
      if (keypad) keypad = null;
      if (!locked) {
        if (phase === "results") finish();
        else onExit();
      }
      return;
    }
    if (e.code === "F8" && !e.repeat) {
      showFps = !showFps;
      fpsEl.classList.toggle("shown", showFps);
      if (!fpsText.parentNode) fpsEl.append(fpsText, graph);
      setText(fpsText, "… fps");
      e.preventDefault();
      return;
    }
    if (e.code === "KeyM" && !e.repeat && !e.ctrlKey) {
      muted = !muted;
      sound.setMuted(muted);
    }
    if (phase === "menu") {
      if (e.code === "Digit1" || e.code === "Digit2" || e.code === "Digit3") difficulty = Number(e.code.slice(-1)) - 1;
      if (e.code === "Enter") beginIntro();
      return;
    }
    if (phase === "intro") {
      if (["KeyE", "Enter", "Space"].includes(e.code)) skipIntro();
      if (e.code === "Space") e.preventDefault();
      return;
    }
    if (phase === "results") {
      if (e.code === "Enter") finish();
      return;
    }
    if (keypad) {
      e.preventDefault();
      const digit = /^(Digit|Numpad)(\d)$/.exec(e.code);
      if (digit && keypad.input.length < 4 && !keypad.ok) {
        keypad.input += digit[2];
        sound.progressTick();
        if (keypad.input.length === 4) setTimeout(submitCode, 220);
      } else if (e.code === "Backspace") keypad.input = keypad.input.slice(0, -1);
      else if (e.code === "Enter" || e.code === "NumpadEnter") submitCode();
      else if (e.code === "KeyE" && !e.repeat) keypad = null;
      return;
    }
    if (phase !== "play") return;
    const slot = /^Digit([1-9])$/.exec(e.code);
    if (slot && !e.repeat) {
      const id = owned()[Number(slot[1]) - 1];
      if (id) selectWeapon(id);
    }
    if (e.code === "KeyQ" && !e.repeat && inv.owned[lastWeapon]) selectWeapon(lastWeapon);
    if (e.code === "KeyR") startReload();
    if (e.code === "KeyE" && !e.repeat) ePressed = true;
    if (e.code === "Space" && !e.repeat && !ride && player.z === 0 && player.vz === 0 && downT <= 0 && player.crouch < 0.3) {
      player.vz = JUMP_SPEED;
      player.z = 0.0001;
    }
    keys.add(e.code);
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Tab"].includes(e.code)) e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
  const onPointerDown = (e: PointerEvent) => {
    const target = e.target as HTMLElement;
    if (!booted) return;
    const diffButton = target.closest<HTMLElement>("[data-diff]");
    if (diffButton) {
      if (phase === "menu") difficulty = Number(diffButton.dataset.diff);
      return;
    }
    if (target.closest("[data-leave]")) {
      finish();
      return;
    }
    if (phase === "extract") {
      if (boardT > 1) showResults(true, "");
      return;
    }
    if (phase === "menu") {
      if (e.button === 0 && target.closest("[data-start]")) beginIntro();
      return;
    }
    if (phase === "results") return;
    if (!locked) {
      if (e.button === 0) lock();
      return;
    }
    if (e.button === 0 && phase === "intro") skipIntro();
    // Buttons in play are read from mouse events (onMouseDown): pointer events merge a second button
    // pressed while one is held into a move, which once left the trigger held after its release.
  };
  /** The buttons in play: left fires while it is physically held, right toggles the sights or the shield. */
  const onMouseDown = (e: MouseEvent) => {
    if (!booted || phase !== "play" || !locked) return;
    if (e.button === 2) {
      // Right click toggles: the shield up or down, any other weapon onto its sights or off them.
      if (!busy() && !wantWeapon) {
        if (weapon === "shield") shieldRaised = !shieldRaised;
        else adsHeld = !adsHeld;
      }
    } else if (e.button === 0 && !busy()) {
      trigger = true;
      triggerFresh = true;
    }
  };
  const onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) trigger = false;
  };
  const onVisibility = () => {
    if (document.hidden) {
      trigger = false;
      keys.clear();
    }
  };
  const onWheel = (e: WheelEvent) => {
    if (phase !== "play" || !locked || busy()) return;
    e.preventDefault();
    const now = performance.now();
    if (now - wheelT < 140 || Math.abs(e.deltaY) < 1) return;
    wheelT = now;
    cycleWeapon(e.deltaY > 0 ? 1 : -1);
  };
  const onContextMenu = (e: Event) => e.preventDefault();
  // Mouse movement since the last frame: raw, no smoothing or acceleration.
  let lookX = 0;
  let lookY = 0;
  function applyLook() {
    if (lookX || lookY) {
      const turn = MOUSE_TURN * (camera.fov / 74);
      player.yaw += lookX * turn;
      player.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, player.pitch - lookY * turn));
      anim.lookX += lookX;
      anim.lookY += lookY;
    }
    lookX = lookY = 0;
  }
  const onMouseMove = (e: MouseEvent) => {
    // The left button's real state rides on every move: a release the game missed ends the burst here.
    if (!(e.buttons & 1)) trigger = false;
    if (!locked || phase !== "play" || ride?.phase === "moving" || keypad) return;
    lookX += e.movementX;
    lookY += e.movementY;
  };
  const onLockChange = () => {
    locked = document.pointerLockElement === canvas;
    // Esc during the ending releases the mouse: that skips it too.
    if (!locked && phase === "extract" && boardT > 1) showResults(true, "");
    if (locked) everLocked = true;
    else {
      keys.clear();
      keypad = null;
      trigger = false;
      shieldRaised = false;
      adsHeld = false;
    }
  };
  const onBlur = () => {
    keys.clear();
    trigger = false;
    shieldRaised = false;
    adsHeld = false;
  };
  const onResize = () => {
    if (ratio !== ratioCap()) {
      ratio = ratioCap();
      renderer.setPixelRatio(ratio);
    }
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  };
  // Capture: the game sees its keys before anything else on the page does.
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", onBlur);
  window.addEventListener("resize", onResize);
  host.addEventListener("pointerdown", onPointerDown);
  host.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mouseup", onMouseUp);
  document.addEventListener("visibilitychange", onVisibility);
  host.addEventListener("wheel", onWheel, { passive: false });
  host.addEventListener("contextmenu", onContextMenu);
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("pointerlockchange", onLockChange);
  if (import.meta.env.DEV) {
    // Development only (stripped from the production build): a handle for automated checks.
    (window as unknown as Record<string, unknown>).__raid = {
      THREE,
      renderer,
      scene,
      camera,
      player,
      inv,
      get guards() {
        return guards;
      },
      get civs() {
        return civs;
      },
      get phase() {
        return phase;
      },
      get roof() {
        return { onRoof, roofClock, roofHold, troop: troop?.state, extract: extract?.state };
      },
      load: (f: number) => loadFloor(f, true),
      loadRoof: () => loadRoof(placeInCar),
      skipRoof: (t: number) => {
        roofClock = t;
      },
      give: (id: WeaponId) => {
        inv.owned[id] = true;
        if (id === "shield") inv.shield = WEAPONS.shield.durability;
        else inv.mag[magKey(id)] = WEAPONS[id].magazine;
        inv.reserve[WEAPONS[id].ammo] = WEAPONS[id].reserveMax;
        selectWeapon(id);
      },
      fire: () => {
        targets.length = 0;
        fire();
      },
      god: () => {
        god = true;
      },
      stats: () => ({ shots, hits, headshots }),
      get input() {
        return { trigger, locked, phase, busy: busy(), wantWeapon, fireCooldown, weapon };
      },
      forceLock: () => {
        locked = everLocked = true;
      },
      aim: (on: boolean) => {
        adsHeld = on;
      },
      trigger: (on: boolean) => {
        trigger = on;
        triggerFresh = on;
      },
      lastHit: () => (window as unknown as { __lastHit?: unknown }).__lastHit,
      info: () => ({ draws: renderer.info.render.calls, tris: renderer.info.render.triangles, lights: countLights(), programs: renderer.info.programs?.length, guards: guards.length, civs: civs.length }),
    };
  }
  return () => {
    disposed = true;
    cancelAnimationFrame(frame);
    document.documentElement.classList.remove("playing-game");
    if (document.pointerLockElement === canvas) document.exitPointerLock();
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("resize", onResize);
    host.removeEventListener("pointerdown", onPointerDown);
    host.removeEventListener("mousedown", onMouseDown);
    window.removeEventListener("mouseup", onMouseUp);
    document.removeEventListener("visibilitychange", onVisibility);
    host.removeEventListener("wheel", onWheel);
    host.removeEventListener("contextmenu", onContextMenu);
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("pointerlockchange", onLockChange);
    if (import.meta.env.DEV) delete (window as unknown as Record<string, unknown>).__raid;
    sound.dispose();
    for (const h of helis) h.dispose();
    for (const d of perFloorDisposables.splice(0)) d.dispose();
    for (const c of probeChars) c.dispose();
    scene.traverse((o) => {
      if (o instanceof THREE.InstancedMesh) o.dispose();
      if ((o instanceof THREE.Mesh || o instanceof THREE.Line) && !(o instanceof THREE.SkinnedMesh)) {
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
      }
    });
    for (const g of geoCache.values()) g.dispose();
    for (const g of Object.values(shapes)) g.dispose();
    for (const m of Object.values(mats)) for (const one of Array.isArray(m) ? m : [m]) one.dispose();
    for (const t of tex.all) t.dispose();
    hitMat.dispose();
    warmTarget.dispose();
    tracerGeo.dispose();
    disposePeople();
    disposeWeapons();
    envMap?.dispose();
    pmrem.dispose();
    renderer.dispose();
    canvas.remove();
    hud.innerHTML = "";
  };
}

export function RaidGame({ onExit }: { onExit(): void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const hudRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [boot, setBoot] = useState({ progress: 0.2, step: "Starting the engine", built: 0 });
  const [failure, setFailure] = useState<Error | null>(null);
  // A failure while building (no WebGL, say) goes to the error boundary around the game.
  if (failure) throw failure;

  useEffect(() => {
    const host = hostRef.current;
    const hud = hudRef.current;
    if (!host || !hud) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    let shown = { step: "", progress: 0 };
    const report = (step: string, progress: number, built: number) => {
      if (cancelled || (step === shown.step && progress - shown.progress < 0.01 && progress < 1)) return;
      shown = { step, progress };
      setBoot((b) => ({ step, progress: Math.max(b.progress, progress), built: Math.max(b.built, built) }));
    };
    // Start after the loading screen has painted.
    const frame = requestAnimationFrame(() => {
      if (cancelled) return;
      try {
        stop = runRaid(host, hud, onExit, report, () => !cancelled && setReady(true), (e) => !cancelled && setFailure(e));
      } catch (e) {
        setFailure(e instanceof Error ? e : new Error(String(e)));
      }
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      stop?.();
    };
  }, [onExit]);

  return (
    <div ref={hostRef} className={ready ? "raid-game" : "raid-game raid-loading"} aria-label="Raid the headquarters: a hidden game. Press Escape to leave.">
      <div ref={hudRef} className="raid-hud" />
      {!ready && <RaidLoadingScreen progress={boot.progress} step={boot.step} plan={FLOORS[0]} built={boot.built} />}
    </div>
  );
}
