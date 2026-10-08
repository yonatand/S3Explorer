import { useEffect, useRef } from "react";
import { toast } from "../store/toasts";

// A hidden game on the start screen (started by clicking a server five times, see
// TransferBackdrop). Your first connection slides to the middle of the window and the things
// servers fear come at it in waves; click to make the nearest server fire a pulse. The page's own
// content is hidden while playing (see `.playing-game` in styles.css) and everything is drawn on a
// transparent canvas over the backdrop, so the real servers stay where they are and do the
// shooting. When the connection is destroyed the game closes itself and reports the score.

const BEST_KEY = "s3x.gameBest";
const CORE_HEALTH = 5;
const CORE = { width: 280, height: 136 };
/** The cloud on a connection's badge (the lucide "cloud" icon, 24 x 24), and the dark ink it is drawn in. */
const CLOUD = new Path2D("M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z");
const BADGE_INK = "#18181b";

const SLIDE_SECONDS = 0.75; // how long the connection takes to travel from its tile to the middle
const DEATH_SECONDS = 2.6; // how long the destruction plays before the game closes
const WAVE_PAUSE = 2.4; // seconds between waves
const BOSS_EVERY = 5; // every fifth wave brings a DDoS
const BOSS_SPAWNS_EVERY = 2.3; // seconds between the bugs a DDoS sends out
const BULLET_SPEED = 950; // px per second
const BULLET_REACH = 1.6; // seconds a pulse flies before it fades
const COMBO_STEP = 5; // hits in a row per extra score multiplier
const MAX_MULTIPLIER = 5;
const RAPID_SECONDS = 6; // how long the rapid-fire power-up lasts
const RAPID_EVERY = 0.28; // seconds between automatic shots per server

/** The `life` given to a pulse that hit something, so it is not mistaken for one that faded out (a miss). */
const USED = -1;

const SPARK_LIFE = 0.45;
const RING_LIFE = 0.32;
const POPUP_LIFE = 0.8;
const SHAKE_LIFE = 0.25;
/** The canvas is drawn at no more than this many device pixels per CSS pixel: sharper costs frames on a large window. */
const MAX_PIXEL_RATIO = 1.5;

const HEADING = '"Gabarito Variable", sans-serif';
const BODY = '"Rubik Variable", sans-serif';

interface Point {
  x: number;
  y: number;
}
interface Moving extends Point {
  vx: number;
  vy: number;
}
interface Box extends Point {
  width: number;
  height: number;
}

/**
 * What comes at the connection: things that are bad for servers. `speed` multiplies the wave's
 * speed; `fromWave` is the first wave a kind may appear in (the DDoS only comes as a boss).
 */
const KINDS = {
  bug: { size: 10, health: 1, speed: 1, points: 10, damage: 1, fromWave: 1 },
  surge: { size: 9, health: 1, speed: 1.9, points: 20, damage: 1, fromWave: 3 },
  worm: { size: 11, health: 1, speed: 0.9, points: 15, damage: 1, fromWave: 4 }, // splits into two bugs
  ransomware: { size: 15, health: 3, speed: 0.6, points: 40, damage: 2, fromWave: 6 },
  ddos: { size: 34, health: 14, speed: 0.3, points: 300, damage: 3, fromWave: Infinity }, // sends out bugs
} as const;
type Kind = keyof typeof KINDS;
interface Enemy extends Moving {
  kind: Kind;
  health: number;
  /** Seconds until a DDoS sends out its next bug. */
  untilSpawn: number;
}
/** A pulse; `life` counts down in seconds. */
interface Shot extends Moving {
  life: number;
}
/** A fragment thrown out by a hit, drawn as a short streak in `color`. */
interface Spark extends Shot {
  color: string;
}
/** A shock ring that grows from a point and fades; `reach` is how far it spreads, in px. */
interface Ring extends Point {
  life: number;
  color: string;
  reach: number;
}
/** Words that rise from a hit and fade: the points scored, or what a power-up gave. */
interface Popup extends Point {
  life: number;
  words: string;
  color: string;
}
/** Drifts across the window. Shooting it repairs the connection, makes every server fire by itself, or clears the field. */
type Effect = "repair" | "rapid" | "firewall";
interface PowerUp extends Moving {
  effect: Effect;
}
const POWER_UPS: Record<Effect, { sign: string; words: string }> = {
  repair: { sign: "+", words: "Repaired" },
  rapid: { sign: "»", words: "Rapid fire" },
  firewall: { sign: "#", words: "Firewall" },
};

const centre = (b: Box): Point => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const inside = (p: Point, b: Box) => p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
/** A velocity of `speed` px per second from `from` towards `to`. */
const towards = (from: Point, to: Point, speed: number) => {
  const d = distance(from, to) || 1;
  return { vx: ((to.x - from.x) / d) * speed, vy: ((to.y - from.y) / d) * speed };
};

/** Each wave has more threats, closer together and faster, than the one before. */
const waveSize = (wave: number) => 4 + wave * 2;
const spawnEvery = (wave: number) => Math.max(0.34, 1.15 - wave * 0.07);
const waveSpeed = (wave: number) => Math.min(210, 66 + wave * 9);
const multiplierFor = (combo: number) => Math.min(MAX_MULTIPLIER, 1 + Math.floor(combo / COMBO_STEP));

/** Draws one threat centred on (x, y); `s` is its size (roughly its radius). Fill and stroke colour are the caller's. */
function drawThreat(ctx: CanvasRenderingContext2D, kind: Kind, x: number, y: number, s: number) {
  ctx.beginPath();
  if (kind === "bug") {
    // A beetle: an oval body with three legs a side and two feelers.
    ctx.ellipse(x, y, s * 0.62, s * 0.85, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    for (const side of [-1, 1]) {
      for (const leg of [-0.5, 0, 0.5]) {
        ctx.moveTo(x + side * s * 0.55, y + leg * s);
        ctx.lineTo(x + side * s * 1.15, y + leg * s * 1.5);
      }
      ctx.moveTo(x + side * s * 0.25, y - s * 0.8);
      ctx.lineTo(x + side * s * 0.55, y - s * 1.35);
    }
    ctx.stroke();
  } else if (kind === "surge") {
    // A lightning bolt.
    const bolt = [[0.2, -1.4], [-0.75, 0.15], [-0.05, 0.15], [-0.3, 1.4], [0.75, -0.25], [0.05, -0.25]];
    bolt.forEach(([px, py], i) => (i ? ctx.lineTo(x + px * s, y + py * s) : ctx.moveTo(x + px * s, y + py * s)));
    ctx.fill();
  } else if (kind === "worm") {
    // Three linked segments.
    for (const offset of [-1, 0, 1]) {
      ctx.moveTo(x + offset * s * 0.8 + s * 0.5, y);
      ctx.arc(x + offset * s * 0.8, y, s * 0.5, 0, Math.PI * 2);
    }
    ctx.fill();
  } else if (kind === "ransomware") {
    // A padlock: a body with a shackle over it.
    ctx.roundRect(x - s * 0.85, y - s * 0.25, s * 1.7, s * 1.25, 3);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y - s * 0.25, s * 0.52, Math.PI, 0);
    ctx.stroke();
  } else {
    // A DDoS: a spiked ball (the caller writes its name on it).
    for (let i = 0; i < 24; i++) {
      const angle = (i / 24) * Math.PI * 2;
      const radius = i % 2 ? s * 0.78 : s * 1.08;
      ctx.lineTo(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
    }
    ctx.closePath();
    ctx.fill();
  }
}

export function DefendGame({ onExit }: { onExit(): void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const css = getComputedStyle(document.documentElement);
    const color = (name: string) => css.getPropertyValue(name).trim();
    const paint = {
      accent: color("--accent"),
      danger: color("--danger"),
      success: color("--success"),
      text: color("--text"),
      muted: color("--muted"),
      surface: color("--bg-elev"),
      line: color("--border-strong"),
    };

    // The connection to protect is the first tile: its name, details, badge colour and place on the
    // page are read before the page's content is hidden. Without tiles (the connection form is
    // showing) it is the app itself, already in the middle.
    const firstTile = document.querySelector(".saved-row:not(.saved-new)");
    const badge = firstTile?.querySelector(".saved-icon");
    const connection = {
      name: firstTile?.querySelector(".saved-name")?.textContent ?? "S3 Explorer",
      details: [...(firstTile?.querySelectorAll(".saved-meta > span") ?? [])].map((part) => part.textContent).join(", "),
      color: badge ? getComputedStyle(badge).backgroundColor : paint.accent,
    };
    const tileBox = firstTile?.getBoundingClientRect();
    document.documentElement.classList.add("playing-game");

    let servers: Point[] = [];
    /** The connection's place in the middle of the window, and where it is right now (it slides there at the start). */
    let home: Box = { x: 0, y: 0, ...CORE };
    let core: Box = home;
    let slide = tileBox ? 0 : 1; // 0 at the tile, 1 in the middle

    const measure = () => {
      const scale = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
      canvas.width = window.innerWidth * scale;
      canvas.height = window.innerHeight * scale;
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      servers = [...document.querySelectorAll(".backdrop .server")].map((el) => {
        const r = el.getBoundingClientRect();
        return centre({ x: r.x, y: r.y, width: r.width, height: r.height });
      });
      home = { x: (window.innerWidth - CORE.width) / 2, y: (window.innerHeight - CORE.height) / 2, ...CORE };
      if (slide >= 1) core = home;
    };
    measure();

    let enemies: Enemy[] = [];
    let bullets: Shot[] = [];
    let sparks: Spark[] = [];
    let rings: Ring[] = [];
    let popups: Popup[] = [];
    let powerUps: PowerUp[] = [];
    /** Seconds left of the flash on the server that fired, by index. */
    const muzzle = new Map<number, number>();
    let hurt = 0; // seconds left of the red flash on the connection
    let shake = 0; // seconds left of the jolt when the connection is hit
    let dying = 0; // seconds left of the destruction, once the connection is gone
    let score = 0;
    let health = CORE_HEALTH;
    let combo = 0;
    let wave = 0;
    let toSpawn = 0;
    let untilSpawn = 0;
    let pause = WAVE_PAUSE; // counts down to the next wave
    let rapid = 0; // seconds of rapid fire left
    let untilRapidShot = 0;
    const best = Number(localStorage.getItem(BEST_KEY)) || 0;

    /** A point just outside the window, on a random side. */
    const edgePoint = (): Point => {
      const along = Math.random();
      return [
        { x: along * window.innerWidth, y: -40 },
        { x: window.innerWidth + 40, y: along * window.innerHeight },
        { x: along * window.innerWidth, y: window.innerHeight + 40 },
        { x: -40, y: along * window.innerHeight },
      ][Math.floor(Math.random() * 4)];
    };

    const spawn = (kind: Kind, from: Point = edgePoint()) => {
      const stats = KINDS[kind];
      enemies.push({ ...from, ...towards(from, centre(core), waveSpeed(wave) * stats.speed), kind, health: stats.health, untilSpawn: BOSS_SPAWNS_EVERY });
    };

    const spawnForWave = () => {
      const allowed = (Object.keys(KINDS) as Kind[]).filter((k) => KINDS[k].fromWave <= wave);
      // Bugs stay the most common; one time in three any kind the wave allows is picked.
      spawn(Math.random() < 0.34 ? allowed[Math.floor(Math.random() * allowed.length)] : "bug");
    };

    const startWave = () => {
      wave += 1;
      const boss = wave % BOSS_EVERY === 0;
      // A boss wave is the DDoS and a smaller escort.
      toSpawn = boss ? Math.ceil(waveSize(wave) / 2) : waveSize(wave);
      untilSpawn = 0;
      if (boss) spawn("ddos");
      // From the second wave on, one power-up drifts across, above or below the connection.
      if (wave >= 2) {
        const leftToRight = Math.random() < 0.5;
        const effect: Effect = health < CORE_HEALTH && Math.random() < 0.5 ? "repair" : Math.random() < 0.5 ? "rapid" : "firewall";
        powerUps.push({
          x: leftToRight ? -24 : window.innerWidth + 24,
          y: Math.random() < 0.5 ? core.y - 110 : core.y + core.height + 110,
          vx: leftToRight ? 120 : -120,
          vy: 0,
          effect,
        });
      }
    };

    /** A hit: fragments fly out at random, a ring spreads, and `words` (if any) rise from the spot. */
    const burst = (at: Point, tint: string, words = "", pieces = 14, reach = 34) => {
      for (let i = 0; i < pieces; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 90 + Math.random() * 230;
        sparks.push({ x: at.x, y: at.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: SPARK_LIFE * (0.6 + Math.random() * 0.4), color: tint });
      }
      rings.push({ x: at.x, y: at.y, life: RING_LIFE, color: tint, reach });
      if (words) popups.push({ x: at.x, y: at.y - 14, life: POPUP_LIFE, words, color: tint });
    };

    /** Remove a destroyed threat, score it, and let a worm leave two bugs behind. */
    const destroy = (enemy: Enemy) => {
      enemies = enemies.filter((e) => e !== enemy);
      const gained = KINDS[enemy.kind].points * multiplierFor(combo);
      score += gained;
      const boss = enemy.kind === "ddos";
      burst(enemy, paint.danger, `+${gained}`, boss ? 40 : 14, boss ? 90 : 34);
      if (enemy.kind === "worm") {
        for (const side of [-1, 1]) spawn("bug", { x: enemy.x + side * 16, y: enemy.y + side * 10 });
      }
    };

    const collect = (prize: PowerUp) => {
      powerUps = powerUps.filter((p) => p !== prize);
      burst(prize, prize.effect === "repair" ? paint.success : paint.accent, POWER_UPS[prize.effect].words, 20);
      if (prize.effect === "repair") health = Math.min(CORE_HEALTH, health + 1);
      if (prize.effect === "rapid") rapid = RAPID_SECONDS;
      if (prize.effect === "firewall") {
        // Everything on the field is destroyed, except a DDoS, which is only weakened.
        rings.push({ ...centre(core), life: RING_LIFE * 2, color: paint.accent, reach: Math.max(window.innerWidth, window.innerHeight) });
        for (const enemy of [...enemies]) {
          if (enemy.kind === "ddos") enemy.health -= 4;
          if (enemy.kind !== "ddos" || enemy.health <= 0) destroy(enemy);
        }
      }
    };

    const fireFrom = (shooter: number, at: Point) => {
      const from = servers[shooter];
      bullets.push({ ...from, ...towards(from, at, BULLET_SPEED), life: BULLET_REACH });
      muzzle.set(shooter, 0.18);
    };
    /** The server nearest the click takes the shot, so where you click decides the angle. */
    const fire = (at: Point) => {
      if (!servers.length) return;
      fireFrom(servers.reduce((nearest, s, i) => (distance(s, at) < distance(servers[nearest], at) ? i : nearest), 0), at);
    };

    /** The connection is gone: blow it apart, then let the destruction play before the game closes. */
    const destroyConnection = () => {
      dying = DEATH_SECONDS;
      shake = SHAKE_LIFE * 2.5;
      enemies = [];
      powerUps = [];
      bullets = [];
      const middle = centre(core);
      for (const [dx, dy] of [[0, 0], [-70, -30], [70, 30], [-50, 35], [60, -35]]) {
        burst({ x: middle.x + dx, y: middle.y + dy }, connection.color, "", 26, 120);
      }
      burst(middle, paint.danger, "", 30, 220);
      if (score > best) localStorage.setItem(BEST_KEY, String(score));
    };

    /** Move the connection along its slide: quick at first, easing into place. */
    const slideIn = (dt: number) => {
      if (slide >= 1 || !tileBox) return;
      slide = Math.min(1, slide + dt / SLIDE_SECONDS);
      const eased = 1 - (1 - slide) ** 3;
      const mix = (from: number, to: number) => from + (to - from) * eased;
      core = {
        x: mix(tileBox.x, home.x),
        y: mix(tileBox.y, home.y),
        width: mix(tileBox.width, home.width),
        height: mix(tileBox.height, home.height),
      };
    };

    /** Effects keep moving whatever else is going on: fragments, rings, words and flashes. */
    const stepEffects = (dt: number) => {
      for (const s of sparks) {
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        // Fragments slow down as they fly.
        s.vx *= 1 - 3 * dt;
        s.vy *= 1 - 3 * dt;
      }
      for (const p of popups) p.y -= 34 * dt;
      for (const fading of [...sparks, ...rings, ...popups]) fading.life -= dt;
      for (const [key, left] of muzzle) muzzle.set(key, left - dt);
      hurt -= dt;
      shake -= dt;
      sparks = sparks.filter((s) => s.life > 0);
      rings = rings.filter((r) => r.life > 0);
      popups = popups.filter((p) => p.life > 0);
    };

    const step = (dt: number) => {
      // Nothing attacks until the connection has arrived in the middle, or once it is gone.
      if (dying > 0 || slide < 1) return;

      // Waves: spawn the wave's threats one by one, then rest once the field is clear.
      if (toSpawn > 0) {
        untilSpawn -= dt;
        if (untilSpawn <= 0) {
          spawnForWave();
          toSpawn -= 1;
          untilSpawn = spawnEvery(wave);
        }
      } else if (enemies.length === 0) {
        pause -= dt;
        if (pause <= 0) {
          pause = WAVE_PAUSE;
          startWave();
        }
      }

      // Rapid fire: every server shoots at the threat closest to the connection.
      if (rapid > 0) {
        rapid -= dt;
        untilRapidShot -= dt;
        if (untilRapidShot <= 0 && enemies.length) {
          untilRapidShot = RAPID_EVERY;
          const closest = enemies.reduce((a, b) => (distance(b, centre(core)) < distance(a, centre(core)) ? b : a));
          servers.forEach((_, i) => fireFrom(i, closest));
        }
      }

      for (const m of [...enemies, ...bullets, ...powerUps]) {
        m.x += m.vx * dt;
        m.y += m.vy * dt;
      }
      for (const bullet of bullets) bullet.life -= dt;

      // A DDoS sends a bug towards the connection every so often.
      for (const boss of enemies.filter((e) => e.kind === "ddos")) {
        boss.untilSpawn -= dt;
        if (boss.untilSpawn > 0) continue;
        boss.untilSpawn = BOSS_SPAWNS_EVERY;
        spawn("bug", { x: boss.x, y: boss.y });
      }

      for (const bullet of bullets) {
        // A pulse that touches a power-up collects it.
        const prize = powerUps.find((p) => distance(p, bullet) < 22);
        if (prize) {
          bullet.life = USED;
          collect(prize);
          continue;
        }
        // A pulse that touches a threat damages it and is used up. Hits in a row raise the multiplier.
        const hit = enemies.find((e) => distance(e, bullet) < KINDS[e.kind].size + 11);
        if (!hit) continue;
        bullet.life = USED;
        hit.health -= 1;
        combo += 1;
        if (hit.health > 0) burst(hit, paint.danger, "", 5); // damaged but not destroyed: a few chips fly off
        else destroy(hit);
      }
      // A pulse that fades without hitting anything is a miss and ends the streak. Rapid fire is exempt.
      if (rapid <= 0 && bullets.some((b) => b.life <= 0 && b.life > -dt)) combo = 0;

      // A threat that gets inside the connection damages it.
      for (const enemy of enemies.filter((e) => inside(e, core))) {
        enemies = enemies.filter((e) => e !== enemy);
        health -= KINDS[enemy.kind].damage;
        combo = 0;
        hurt = 0.5;
        shake = SHAKE_LIFE;
        burst(enemy, paint.danger, "", 10);
      }

      bullets = bullets.filter((b) => b.life > 0);
      powerUps = powerUps.filter((p) => p.x > -40 && p.x < window.innerWidth + 40);
      if (health <= 0) destroyConnection();
    };

    const say = (words: string, x: number, y: number, font: string, fill: string) => {
      ctx.font = font;
      ctx.fillStyle = fill;
      ctx.fillText(words, x, y);
    };

    /** The connection, drawn like its tile on the start screen, with its health along the bottom. */
    const drawConnection = (clock: number) => {
      // Two outlines in its colour breathe around it like a shield, and turn red for a moment when it is hit.
      const breath = (Math.sin(clock * 2.2) + 1) / 2;
      ctx.strokeStyle = hurt > 0 ? paint.danger : connection.color;
      ctx.lineWidth = 2;
      for (const [gap, alpha] of [[9, 0.5], [20, 0.2]]) {
        const out = gap + breath * 4;
        ctx.globalAlpha = alpha * (0.55 + 0.45 * breath);
        ctx.beginPath();
        ctx.roundRect(core.x - out, core.y - out, core.width + out * 2, core.height + out * 2, 16 + out);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = paint.surface;
      ctx.strokeStyle = hurt > 0 ? paint.danger : paint.line;
      ctx.lineWidth = hurt > 0 ? 3 : 1.5;
      ctx.beginPath();
      ctx.roundRect(core.x, core.y, core.width, core.height, 16);
      ctx.fill();
      ctx.stroke();

      // Badge with the cloud from the tile.
      ctx.fillStyle = connection.color;
      ctx.beginPath();
      ctx.roundRect(core.x + 18, core.y + 18, 46, 46, 13);
      ctx.fill();
      ctx.save();
      ctx.translate(core.x + 18 + 11, core.y + 18 + 11);
      ctx.strokeStyle = BADGE_INK;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.stroke(CLOUD);
      ctx.restore();

      ctx.textAlign = "left";
      say(connection.name, core.x + 78, core.y + 38, `700 19px ${HEADING}`, paint.text);
      say(connection.details, core.x + 78, core.y + 57, `12px ${BODY}`, paint.muted);

      // Health: one segment per point, filling the width of the tile.
      const segment = (core.width - 36 - (CORE_HEALTH - 1) * 6) / CORE_HEALTH;
      say("Health", core.x + 18, core.y + core.height - 34, `12px ${BODY}`, paint.muted);
      for (let i = 0; i < CORE_HEALTH; i++) {
        ctx.fillStyle = i < health ? (health <= 2 ? paint.danger : paint.success) : paint.line;
        ctx.beginPath();
        ctx.roundRect(core.x + 18 + i * (segment + 6), core.y + core.height - 24, segment, 8, 4);
        ctx.fill();
      }
      ctx.textAlign = "center";
    };

    const drawServers = () => {
      servers.forEach((server, i) => {
        // A flash when it fires, and a glow while rapid fire lasts.
        const flash = muzzle.get(i) ?? 0;
        if (flash > 0) {
          ctx.strokeStyle = paint.accent;
          ctx.globalAlpha = flash / 0.18;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(server.x, server.y, 58 + (0.18 - flash) * 120, 0, Math.PI * 2);
          ctx.stroke();
        }
        if (rapid > 0) {
          ctx.strokeStyle = paint.accent;
          ctx.globalAlpha = 0.35;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(server.x, server.y, 70, 0, Math.PI * 2);
          ctx.stroke();
        }
      });
      ctx.globalAlpha = 1;
    };

    const draw = (clock: number) => {
      const [w, h] = [window.innerWidth, window.innerHeight];
      ctx.clearRect(0, 0, w, h);
      ctx.textAlign = "center";
      ctx.lineCap = "round";
      // A hit on the connection jolts the whole picture for a moment.
      ctx.save();
      if (shake > 0) ctx.translate((Math.random() - 0.5) * 14 * (shake / SHAKE_LIFE), (Math.random() - 0.5) * 14 * (shake / SHAKE_LIFE));

      // The connection is there until it is destroyed; then only its fragments are.
      if (dying <= 0) drawConnection(clock);
      drawServers();

      // Threats; one that takes several hits fades to show how much of it is left.
      ctx.fillStyle = paint.danger;
      ctx.strokeStyle = paint.danger;
      ctx.lineWidth = 2;
      for (const e of enemies) {
        ctx.globalAlpha = 0.4 + (0.6 * e.health) / KINDS[e.kind].health;
        drawThreat(ctx, e.kind, e.x, e.y, KINDS[e.kind].size);
      }
      ctx.globalAlpha = 1;
      for (const boss of enemies.filter((e) => e.kind === "ddos")) say("DDoS", boss.x, boss.y + 5, `700 14px ${HEADING}`, paint.surface);

      // Power-ups are rings with a sign.
      for (const p of powerUps) {
        const tint = p.effect === "repair" ? paint.success : paint.accent;
        ctx.strokeStyle = tint;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 15, 0, Math.PI * 2);
        ctx.stroke();
        say(POWER_UPS[p.effect].sign, p.x, p.y + 6, `700 18px ${HEADING}`, tint);
      }

      // Pulses: a bright head with a short tail, like the ones in the backdrop. The glow is a wider,
      // fainter stroke underneath; a canvas shadow would look the same but costs many frames.
      ctx.strokeStyle = paint.accent;
      for (const [width, alpha] of [[10, 0.22], [4, 1]]) {
        ctx.lineWidth = width;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        for (const b of bullets) {
          ctx.moveTo(b.x - b.vx * 0.035, b.y - b.vy * 0.035);
          ctx.lineTo(b.x, b.y);
        }
        ctx.stroke();
      }

      // Hits: fragments as short streaks along their path, spreading rings, and rising words.
      ctx.lineWidth = 2.5;
      for (const s of sparks) {
        ctx.strokeStyle = s.color;
        ctx.globalAlpha = Math.max(s.life / SPARK_LIFE, 0);
        ctx.beginPath();
        ctx.moveTo(s.x - s.vx * 0.03, s.y - s.vy * 0.03);
        ctx.lineTo(s.x, s.y);
        ctx.stroke();
      }
      for (const r of rings) {
        // A ring may be given a longer life than RING_LIFE (the firewall's); it then starts fully drawn.
        const left = Math.min(Math.max(r.life / RING_LIFE, 0), 1);
        ctx.strokeStyle = r.color;
        ctx.globalAlpha = left;
        ctx.lineWidth = 3 * left + 0.5;
        ctx.beginPath();
        ctx.arc(r.x, r.y, 8 + (1 - left) * r.reach, 0, Math.PI * 2);
        ctx.stroke();
      }
      for (const p of popups) {
        ctx.globalAlpha = Math.min(1, p.life / (POPUP_LIFE * 0.5));
        say(p.words, p.x, p.y, `700 15px ${HEADING}`, p.color);
      }
      ctx.globalAlpha = 1;
      ctx.restore();

      // Score, multiplier and wave in the top-left corner (the top middle belongs to the fourth server).
      const multiplier = multiplierFor(combo);
      ctx.textAlign = "left";
      say(`${score}`, 28, 44, `700 26px ${HEADING}`, paint.text);
      say(`Wave ${Math.max(wave, 1)}${multiplier > 1 ? `   x${multiplier}` : ""}   best ${Math.max(best, score)}   Esc to leave`, 28, 66, `13px ${BODY}`, paint.muted);
      if (rapid > 0) say(`Rapid fire ${Math.ceil(rapid)}`, 28, 88, `700 13px ${BODY}`, paint.accent);
      ctx.textAlign = "center";

      // Between waves, announce the next one above the connection.
      if (dying <= 0 && slide >= 1 && toSpawn === 0 && enemies.length === 0) {
        const next = wave + 1;
        const title = wave === 0 ? "Protect your connection" : next % BOSS_EVERY === 0 ? `Wave ${next}: a DDoS is coming` : `Wave ${next}`;
        say(title, w / 2, core.y - 44, `700 24px ${HEADING}`, paint.text);
        if (wave === 0) say("Click to shoot; the nearest server fires.", w / 2, core.y - 22, `13px ${BODY}`, paint.muted);
      }
      if (dying > 0) {
        // The words arrive a moment after the blast.
        ctx.globalAlpha = Math.min(1, (DEATH_SECONDS - dying) / 0.6);
        say("Connection lost", w / 2, h / 2 - 4, `700 38px ${HEADING}`, paint.text);
        say(`${score} points, wave ${wave}`, w / 2, h / 2 + 24, `15px ${BODY}`, paint.muted);
        ctx.globalAlpha = 1;
      }
    };

    /** The destruction has played out: report the score and go back to the start screen. */
    const finish = () => {
      toast.info("Connection lost", `You scored ${score} and reached wave ${wave}.${score > best ? " A new best." : ` Your best is ${best}.`}`);
      onExit();
    };

    let frame = 0;
    let clock = 0; // seconds since the game opened, for the idle animation of the connection
    let last = performance.now();
    const loop = (now: number) => {
      // A background tab can leave a long gap between frames; never simulate more than a tenth of a second at once.
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      clock += dt;
      slideIn(dt);
      step(dt);
      stepEffects(dt);
      draw(clock);
      if (dying > 0) {
        dying -= dt;
        if (dying <= 0) return finish();
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);

    const onPointerDown = (e: PointerEvent) => dying <= 0 && slide >= 1 && fire({ x: e.clientX, y: e.clientY });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onExit();
    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      document.documentElement.classList.remove("playing-game");
      canvas.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", measure);
    };
  }, [onExit]);

  // The canvas covers the window and takes every click, so nothing underneath can be pressed while playing.
  return <canvas ref={canvasRef} className="defend-game" aria-label="Protect your connection: a hidden game. Press Escape to leave." />;
}
