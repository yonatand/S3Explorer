/**
 * Sound for the hidden raid game, synthesised with the Web Audio API so the game ships no audio files.
 * Every method is a silent no-op before start() and after dispose(), and never throws: a broken audio
 * device must not break the game.
 */
export interface RaidSound {
  /** Call from a user gesture (the first click); creates or resumes the AudioContext. */
  start(): void;
  /** Stops everything and closes the AudioContext. */
  dispose(): void;
  setMuted(muted: boolean): void;
  shot(): void;
  /** One full-auto round; safe to call ~11 times a second (overlapping rounds are capped). */
  rifleShot(): void;
  shotgunShot(): void;
  shotgunPump(): void;
  shellInsert(): void;
  /** Mag out, mag in, bolt: about one second. */
  rifleReload(): void;
  weaponSwitch(): void;
  /** A bullet hitting a riot shield. */
  shieldHit(): void;
  shieldBreak(): void;
  /** A tick when your bullet hits a guard; a headshot is a brighter double tick. */
  hit(headshot: boolean): void;
  kill(): void;
  /** pan -1..1 (left..right of the player), distance in cells: quieter and duller far away. */
  guardShot(pan: number, distance: number): void;
  /** A three-round rifle burst from a soldier; pan and distance as guardShot. */
  armyShot(pan: number, distance: number): void;
  /** Squelch, a burst of radio chatter, squelch. */
  armyRadio(): void;
  /** Bang then a ringing tone that fades over a few seconds. Pair with deafen() for the muffled world. */
  flashbang(): void;
  /** Muffles everything (except the ringing) and lets it clear over the given seconds. */
  deafen(seconds: number): void;
  hurt(): void;
  /** One footstep; steps never overlap themselves. Crouched steps are quieter and softer. */
  step(running: boolean, crouching?: boolean): void;
  spotted(): void;
  progressTick(): void;
  done(): void;
  ding(): void;
  pickup(): void;
  pickupAmmo(): void;
  reload(): void;
  empty(): void;
  /** A looping building alarm; off stops it. */
  alarm(on: boolean): void;
  /** A looping rotor. distance 0 (overhead) .. 1 (far off, faint). */
  helicopter(on: boolean, distance?: number): void;
  /** Moves the running helicopter: distance 0..1 as helicopter(), pan -1..1. */
  setHelicopterDistance(distance: number, pan?: number): void;
  /** A looping outdoor wind bed. */
  wind(on: boolean): void;
  /** Outdoors the room reverb is mostly bypassed. */
  setOutdoor(on: boolean): void;
  /** A rappelling zip down the rope. */
  rope(): void;
  /**
   * A building-sized explosion `distance` metres away: a deep boom and rumble with a crackle of debris after
   * it, duller and later (sound travels about 343 m/s) the further off it is.
   */
  explosion(distance: number): void;
  win(): void;
  lose(): void;
}

const MASTER = 0.4;
/** Beyond this many live one-shots new ones are dropped, so a firefight cannot pile up nodes. */
const MAX_VOICES = 32;
const MAX_GUARD_SHOTS = 6;
const MAX_RIFLE = 4;
/** The roof's wind bed: quiet (12 dB under what it was). */
const WIND = 0.055;
const ROOM = 0.5;

interface Voice {
  c: AudioContext;
  t: number;
  out: GainNode;
  add<T extends AudioNode>(n: T): T;
  play(s: AudioScheduledSourceNode, at: number, until: number, offset?: number): void;
}

interface Loop {
  g: GainNode;
  nodes: AudioNode[];
  p?: StereoPannerNode;
  lp?: BiquadFilterNode;
}

type Add = <T extends AudioNode>(n: T) => T;

export function createRaidSound(): RaidSound {
  let ctx: AudioContext | null = null;
  /** Everything but the flashbang ring goes into bus, then the deafen lowpass, then master. */
  let bus: GainNode | null = null;
  let dlp: BiquadFilterNode | null = null;
  let master: GainNode | null = null;
  let send: GainNode | null = null;
  let ret: GainNode | null = null;
  let noise: AudioBuffer | null = null;
  let muted = false;
  let disposed = false;
  let outdoor = false;
  let voices = 0;
  let stepUntil = 0;
  const caps: Record<string, number> = {};
  const loops: Record<string, Loop | undefined> = {};

  const rnd = (a: number, b: number) => a + Math.random() * (b - a);
  const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x || 0));

  /** Takes a slot of a capped sound for ms; false when it is full. */
  function cap(k: string, max: number, ms: number) {
    if ((caps[k] || 0) >= max) return false;
    caps[k] = (caps[k] || 0) + 1;
    setTimeout(() => caps[k]--, ms);
    return true;
  }

  function init() {
    const c = new AudioContext();
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    comp.connect(c.destination);
    master = c.createGain();
    master.gain.value = muted ? 0 : MASTER;
    master.connect(comp);
    dlp = c.createBiquadFilter();
    dlp.frequency.value = 20000;
    dlp.connect(master);
    bus = c.createGain();
    bus.connect(dlp);

    // One shared short room: a decaying noise impulse, darkened so the tail does not hiss.
    const len = Math.floor(c.sampleRate * 0.9);
    const ir = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    const verb = c.createConvolver();
    verb.buffer = ir;
    const tone = c.createBiquadFilter();
    tone.frequency.value = 3500;
    ret = c.createGain();
    ret.gain.value = outdoor ? ROOM * 0.12 : ROOM;
    send = c.createGain();
    send.connect(verb).connect(tone).connect(ret).connect(bus);

    noise = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const n = noise.getChannelData(0);
    for (let i = 0; i < n.length; i++) n[i] = Math.random() * 2 - 1;
    ctx = c;
  }

  /** A one-shot's private chain; every node it creates is disconnected once its sources have ended. */
  function voice(level: number, rev: number, pan = 0, dest: AudioNode | null = bus): Voice | null {
    if (!ctx || !dest || !send || muted || voices >= MAX_VOICES || ctx.state !== "running") return null;
    const c = ctx;
    const nodes: AudioNode[] = [];
    let pending = 0;
    let done = false;
    const add = <T extends AudioNode>(n: T) => (nodes.push(n), n);
    const out = add(c.createGain());
    out.gain.value = level;
    let tail: AudioNode = out;
    if (pan) {
      const p = add(c.createStereoPanner());
      p.pan.value = clamp(pan, -1, 1);
      tail = out.connect(p);
    }
    tail.connect(dest);
    if (rev) {
      const r = add(c.createGain());
      r.gain.value = rev;
      tail.connect(r).connect(send);
    }
    voices++;
    const finish = () => {
      if (done) return;
      done = true;
      voices--;
      for (const n of nodes) n.disconnect();
    };
    return {
      c,
      t: c.currentTime + 0.005,
      out,
      add,
      play(s, at, until, offset = 0) {
        pending++;
        add(s).addEventListener("ended", () => --pending === 0 && finish());
        if (s instanceof AudioBufferSourceNode) s.start(at, offset);
        else s.start(at);
        s.stop(until);
      },
    };
  }

  /** Attack then exponential decay; returns when the envelope is silent. */
  function env(g: GainNode, t: number, peak: number, a: number, d: number) {
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    return t + a + d + 0.02;
  }

  /** Filtered noise; with f1 the filter sweeps from f to f1 over the sound. */
  function burst(v: Voice, t: number, type: BiquadFilterType, f: number, q: number, peak: number, a: number, d: number, dest: AudioNode = v.out, f1 = f) {
    const s = v.c.createBufferSource();
    s.buffer = noise;
    const fl = v.add(v.c.createBiquadFilter());
    fl.type = type;
    fl.frequency.setValueAtTime(f, t);
    if (f1 !== f) fl.frequency.exponentialRampToValueAtTime(f1, t + a + d);
    fl.Q.value = q;
    const g = v.add(v.c.createGain());
    s.connect(fl).connect(g).connect(dest);
    // A random offset into the noise and a slight rate change, so repeats are never sample-identical.
    s.playbackRate.value = rnd(0.92, 1.08);
    v.play(s, t, env(g, t, peak, a, d), rnd(0, 0.4));
  }

  function tone(v: Voice, t: number, type: OscillatorType, f0: number, f1: number, peak: number, a: number, d: number, dest: AudioNode = v.out) {
    const o = v.c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + a + d);
    const g = v.add(v.c.createGain());
    o.connect(g).connect(dest);
    v.play(o, t, env(g, t, peak, a, d));
  }

  /** A struck bell: inharmonic partials that die faster the higher they are. */
  function bell(v: Voice, t: number, f: number, peak: number, d: number) {
    tone(v, t, "sine", f, f, peak, 0.002, d);
    tone(v, t, "sine", f * 2.76, f * 2.76, peak * 0.3, 0.002, d * 0.4);
    tone(v, t, "sine", f * 5.4, f * 5.4, peak * 0.12, 0.001, d * 0.15);
  }

  /** A struck steel plate: partials close together, so it clanks rather than rings. */
  function plate(v: Voice, t: number, f: number, peak: number, d: number) {
    for (const [m, p, k] of [[1, 1, 1], [1.47, 0.6, 0.7], [2.09, 0.4, 0.45], [2.63, 0.25, 0.3]])
      tone(v, t, "sine", f * m, f * m * 0.985, peak * p, 0.001, d * k);
  }

  function notes(freqs: number[], gap: number, type: OscillatorType, peak: number, d: number, level: number) {
    const v = voice(level, 0.3);
    if (!v) return;
    freqs.forEach((f, i) => {
      tone(v, v.t + i * gap, type, f, f, peak, 0.005, d);
      tone(v, v.t + i * gap, "sine", f * 2, f * 2, peak * 0.2, 0.005, d * 0.5);
    });
  }

  function click(v: Voice, t: number, f: number, peak: number) {
    burst(v, t, "bandpass", f, 3, peak, 0.001, 0.02);
    tone(v, t, "square", f * 0.5, f * 0.4, peak * 0.15, 0.001, 0.012);
  }

  /** A metal part sliding home: a click with a dull knock under it. */
  function clack(v: Voice, t: number, f: number, peak: number) {
    click(v, t, f * rnd(0.92, 1.08), peak);
    burst(v, t, "lowpass", 450, 1, peak * 0.6, 0.002, 0.05);
  }

  function gunshot(v: Voice, t: number, r: number, bright: number) {
    burst(v, t, "highpass", 2200 * r, 0.7, 0.9 * bright, 0.001, rnd(0.06, 0.09));
    burst(v, t, "lowpass", 1400 * r, 0.8, 1, 0.001, rnd(0.14, 0.2));
    tone(v, t, "sine", 160 * r, 42, 1, 0.002, 0.16);
  }

  /** Enemy fire: k=1 is the guard pistol, higher is sharper and shorter. */
  function far(pan: number, distance: number, k: number, rounds: number) {
    const gap = 0.085;
    const d = clamp(distance, 0, 40);
    if (!ctx || !cap("far", MAX_GUARD_SHOTS, 250 + d * 8 + rounds * gap * 1000)) return;
    const v = voice(0.75 / (1 + d * 0.22), Math.min(0.9, 0.3 + d * 0.04), pan);
    if (!v) return;
    const muffle = v.add(v.c.createBiquadFilter());
    muffle.frequency.value = Math.max(450, 7000 / (1 + d * 0.45));
    muffle.connect(v.out);
    const s = 2 - k;
    for (let i = 0; i < rounds; i++) {
      // Roughly the sound's travel time across the cells.
      const t = v.t + d * 0.008 + i * gap * rnd(0.9, 1.1);
      const r = rnd(0.85, 1.05) * k;
      burst(v, t, "highpass", 2000 * r, 0.7, 0.7, 0.001, 0.07 * s, muffle);
      burst(v, t, "lowpass", 1200 * r, 0.8, 1, 0.001, 0.17 * s, muffle);
      tone(v, t, "sine", 140 * r, 40, 0.9, 0.002, 0.15 * s, muffle);
    }
  }

  function stopLoop(k: string) {
    const s = loops[k];
    if (!s) return;
    loops[k] = undefined;
    if (ctx) s.g.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
    setTimeout(() => {
      for (const n of s.nodes) {
        try {
          if (n instanceof AudioScheduledSourceNode) n.stop();
        } catch {
          /* already stopped or context closed */
        }
        n.disconnect();
      }
    }, 500);
  }

  /** A continuous sound: build wires sources into g; every node goes through add and is torn down by stopLoop. */
  function loop(k: string, level: number, rev: number, build: (c: AudioContext, add: Add, g: GainNode) => Partial<Loop> | void) {
    if (loops[k] || !ctx || !bus || !send) return;
    const c = ctx;
    const nodes: AudioNode[] = [];
    const add = <T extends AudioNode>(n: T) => (nodes.push(n), n);
    const g = add(c.createGain());
    g.gain.value = 0;
    g.gain.setTargetAtTime(level, c.currentTime, 0.1);
    g.connect(bus);
    if (rev) g.connect(gain(c, add, rev)).connect(send);
    const l: Loop = { g, nodes, ...build(c, add, g) };
    loops[k] = l;
    for (const n of nodes) if (n instanceof AudioScheduledSourceNode) n.start();
    return l;
  }

  const osc = (c: AudioContext, add: Add, type: OscillatorType, f: number) => {
    const o = add(c.createOscillator());
    o.type = type;
    o.frequency.value = f;
    return o;
  };
  const gain = (c: AudioContext, add: Add, v: number) => {
    const g = add(c.createGain());
    g.gain.value = v;
    return g;
  };
  const filt = (c: AudioContext, add: Add, type: BiquadFilterType, f: number, q = 1) => {
    const fl = add(c.createBiquadFilter());
    fl.type = type;
    fl.frequency.value = f;
    fl.Q.value = q;
    return fl;
  };
  /** Looping noise at a slightly different rate each time, so two beds never line up. */
  const hiss = (c: AudioContext, add: Add) => {
    const s = add(c.createBufferSource());
    s.buffer = noise;
    s.loop = true;
    s.playbackRate.value = rnd(0.9, 1.1);
    return s;
  };
  /** Slow modulation of p: an LFO at f Hz scaled by depth. */
  const lfo = (c: AudioContext, add: Add, f: number, depth: number, p: AudioParam, type: OscillatorType = "sine") =>
    osc(c, add, type, f).connect(gain(c, add, depth)).connect(p);
  /** Turns a sine LFO into sharp positive pulses, one per cycle. */
  const pulses = (c: AudioContext, add: Add, sharp: number) => {
    const w = add(c.createWaveShaper());
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) curve[i] = Math.pow(Math.max(0, i / 127.5 - 1), sharp);
    w.curve = curve;
    return w;
  };

  const ops = {
    start() {
      if (disposed) return;
      if (!ctx) init();
      if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => {});
    },
    dispose() {
      if (disposed) return;
      for (const k of Object.keys(loops)) stopLoop(k);
      disposed = true;
      if (ctx) void ctx.close().catch(() => {});
      ctx = bus = dlp = master = send = ret = null;
      noise = null;
    },
    setMuted(m: boolean) {
      muted = m;
      if (ctx && master) master.gain.setTargetAtTime(m ? 0 : MASTER, ctx.currentTime, 0.02);
    },
    setOutdoor(on: boolean) {
      outdoor = on;
      if (ctx && ret) ret.gain.setTargetAtTime(on ? ROOM * 0.12 : ROOM, ctx.currentTime, 0.15);
    },
    shot() {
      const v = voice(0.9, 0.35);
      if (!v) return;
      gunshot(v, v.t, rnd(0.9, 1.1), 1);
      // The slide cycling, just after the bang.
      burst(v, v.t + rnd(0.05, 0.07), "bandpass", 4200, 4, 0.12, 0.001, 0.025);
    },
    rifleShot() {
      if (!ctx || !cap("rifle", MAX_RIFLE, 200)) return;
      const v = voice(0.62, 0.25);
      if (!v) return;
      const r = rnd(0.9, 1.12);
      burst(v, v.t, "highpass", 3000 * r, 0.8, 1, 0.0005, rnd(0.03, 0.045));
      burst(v, v.t, "bandpass", 1700 * r, 0.9, 0.8, 0.001, rnd(0.07, 0.09));
      tone(v, v.t, "sine", 190 * r, 50, 0.9, 0.001, 0.08);
      burst(v, v.t + rnd(0.03, 0.04), "bandpass", 5200, 5, 0.1, 0.001, 0.015);
    },
    shotgunShot() {
      const v = voice(1, 0.5);
      if (!v) return;
      const r = rnd(0.9, 1.08);
      tone(v, v.t, "sine", 105 * r, 30, 1, 0.003, 0.42);
      burst(v, v.t, "lowpass", 750 * r, 0.9, 1, 0.002, rnd(0.3, 0.4));
      // The spread: a few cracks smeared over a few milliseconds.
      for (let i = 0; i < 3; i++) burst(v, v.t + rnd(0, 0.012), "bandpass", rnd(1800, 4200), 0.9, 0.55, 0.0008, rnd(0.07, 0.12));
      burst(v, v.t, "highpass", 2400 * r, 0.7, 0.7, 0.001, 0.09);
    },
    shotgunPump() {
      const v = voice(0.6, 0.15);
      if (!v) return;
      burst(v, v.t, "bandpass", 900, 1.2, 0.3, 0.02, 0.06);
      clack(v, v.t + 0.07, 1800, 0.7);
      burst(v, v.t + 0.13, "bandpass", 1100, 1.2, 0.3, 0.02, 0.05);
      clack(v, v.t + 0.2, 2300, 0.85);
    },
    shellInsert() {
      const v = voice(0.45, 0.12);
      if (!v) return;
      burst(v, v.t, "bandpass", rnd(2000, 2600), 2, 0.25, 0.01, 0.03);
      clack(v, v.t + rnd(0.04, 0.06), 2600, 0.6);
    },
    rifleReload() {
      const v = voice(0.6, 0.15);
      if (!v) return;
      clack(v, v.t, 1700, 0.6);
      burst(v, v.t + 0.02, "bandpass", 900, 1.5, 0.3, 0.02, 0.1);
      burst(v, v.t + 0.4, "bandpass", 1000, 1.5, 0.25, 0.04, 0.06);
      clack(v, v.t + 0.48, 1300, 0.9);
      clack(v, v.t + 0.78, 3000, 0.6);
      clack(v, v.t + 0.93, 2300, 0.9);
    },
    weaponSwitch() {
      const v = voice(0.45, 0.12);
      if (!v) return;
      burst(v, v.t, "bandpass", rnd(1000, 1400), 0.7, 0.35, 0.03, 0.1);
      clack(v, v.t + 0.14, 2200, 0.55);
    },
    shieldHit() {
      const v = voice(0.6, 0.3);
      if (!v) return;
      plate(v, v.t, rnd(1350, 2000), 0.5, rnd(0.18, 0.28));
      burst(v, v.t, "highpass", 4500, 0.7, 0.5, 0.0005, 0.025);
      burst(v, v.t, "lowpass", 380, 1, 0.6, 0.002, 0.07);
    },
    shieldBreak() {
      const v = voice(0.8, 0.45);
      if (!v) return;
      plate(v, v.t, rnd(500, 650), 0.6, 0.6);
      tone(v, v.t, "sine", 110, 40, 0.9, 0.003, 0.3);
      burst(v, v.t, "bandpass", 2500, 0.6, 0.9, 0.001, 0.3);
      burst(v, v.t, "highpass", 5000, 0.7, 0.6, 0.001, 0.4);
      // Pieces landing.
      for (let i = 0; i < 5; i++) {
        const t = v.t + rnd(0.15, 0.7);
        plate(v, t, rnd(2200, 3800), 0.12, 0.08);
        burst(v, t, "bandpass", rnd(3000, 6000), 4, 0.15, 0.001, 0.03);
      }
    },
    guardShot: (pan: number, distance: number) => far(pan, distance, 1, 1),
    armyShot: (pan: number, distance: number) => far(pan, distance, 1.3, 3),
    armyRadio() {
      const v = voice(0.4, 0.15, rnd(-0.3, 0.3));
      if (!v) return;
      // A tinny speaker band.
      const band = filt(v.c, v.add, "bandpass", 1500, 0.9);
      band.connect(v.out);
      const sq = (t: number) => {
        burst(v, t, "highpass", 2500, 0.7, 0.6, 0.002, 0.05);
        tone(v, t, "square", 1800, 1800, 0.12, 0.002, 0.04);
      };
      sq(v.t);
      let t = v.t + 0.07;
      const end = t + rnd(0.6, 1.1);
      while (t < end) {
        const d = rnd(0.05, 0.13);
        const f = rnd(110, 170);
        tone(v, t, "sawtooth", f, f * rnd(0.85, 1.15), 0.35, 0.01, d, band);
        burst(v, t, "bandpass", rnd(600, 2200), 3, 0.8, 0.01, d, band);
        t += d + rnd(0.01, 0.08);
      }
      sq(t + 0.02);
    },
    flashbang() {
      const v = voice(1, 0.6);
      if (!v) return;
      gunshot(v, v.t, 0.8, 1);
      burst(v, v.t, "lowpass", 2500, 0.7, 1, 0.001, 0.5);
      tone(v, v.t, "sine", 80, 28, 1, 0.003, 0.5);
      // The ringing is in the head, so it bypasses the deafen filter.
      const ring = voice(0.12, 0, 0, master);
      if (!ring) return;
      const f = rnd(3700, 4300);
      tone(ring, ring.t + 0.05, "sine", f, f * 0.97, 1, 0.08, 4);
      tone(ring, ring.t + 0.05, "sine", f * 1.006, f * 0.976, 0.5, 0.1, 3.5);
    },
    deafen(seconds: number) {
      if (!ctx || !dlp || !bus) return;
      const t = ctx.currentTime;
      const s = clamp(seconds, 0.2, 30);
      for (const [p, lo, hi] of [[dlp.frequency, 250, 20000], [bus.gain, 0.3, 1]] as const) {
        p.cancelScheduledValues(t);
        p.setValueAtTime(lo, t);
        p.setValueAtTime(lo, t + s * 0.3);
        p.exponentialRampToValueAtTime(hi, t + s);
      }
    },
    hit(headshot: boolean) {
      const v = voice(0.5, 0.1);
      if (!v) return;
      tone(v, v.t, "triangle", 1900, 1500, 0.4, 0.001, 0.045);
      burst(v, v.t, "highpass", 5000, 0.7, 0.3, 0.001, 0.02);
      if (headshot) {
        tone(v, v.t + 0.055, "triangle", 2700, 2300, 0.45, 0.001, 0.06);
        burst(v, v.t + 0.055, "highpass", 6000, 0.7, 0.3, 0.001, 0.025);
      }
    },
    kill() {
      const v = voice(0.7, 0.25);
      if (!v) return;
      // A body dropping on the floor, a beat after the shot.
      const t = v.t + 0.12;
      tone(v, t, "sine", 95, 38, 0.9, 0.004, 0.3);
      burst(v, t, "lowpass", 380, 0.8, 0.8, 0.004, 0.25);
      burst(v, t + 0.09, "lowpass", 600, 0.8, 0.35, 0.003, 0.12);
    },
    hurt() {
      const v = voice(0.7, 0.15);
      if (!v) return;
      tone(v, v.t, "sine", 120, 45, 1, 0.002, 0.22);
      burst(v, v.t, "bandpass", 700, 1.2, 0.8, 0.002, 0.14);
      tone(v, v.t, "sawtooth", 230, 160, 0.12, 0.01, 0.2);
    },
    step(running: boolean, crouching = false) {
      if (!ctx || ctx.currentTime < stepUntil) return;
      const v = voice(crouching ? 0.14 : running ? 0.45 : 0.3, 0.12);
      if (!v) return;
      stepUntil = v.t + (crouching ? 0.16 : running ? 0.08 : 0.12);
      const r = rnd(0.85, 1.15);
      if (crouching) {
        // Rolled onto the foot: a slower, darker press and only a hint of sole.
        burst(v, v.t, "lowpass", 200 * r, 0.8, 0.9, 0.015, 0.08);
        burst(v, v.t + 0.02, "bandpass", 1100 * r, 1, 0.12, 0.01, 0.04);
        return;
      }
      burst(v, v.t, "lowpass", 260 * r, 1, 0.9, 0.002, running ? 0.05 : 0.07);
      burst(v, v.t + 0.012, "bandpass", 1500 * r, 1.5, 0.35, 0.001, running ? 0.025 : 0.035);
    },
    spotted() {
      const v = voice(0.35, 0.3);
      if (!v) return;
      const lp = v.add(v.c.createBiquadFilter());
      lp.frequency.value = 3200;
      lp.connect(v.out);
      tone(v, v.t, "sawtooth", 520, 1040, 0.5, 0.004, 0.09, lp);
      tone(v, v.t + 0.1, "square", 1040, 1040, 0.35, 0.003, 0.22, lp);
      tone(v, v.t + 0.1, "sawtooth", 1560, 1560, 0.25, 0.003, 0.22, lp);
    },
    progressTick() {
      const v = voice(0.18, 0.1);
      if (v) tone(v, v.t, "sine", 1320, 1320, 1, 0.003, 0.05);
    },
    done: () => notes([523, 659, 784, 1047], 0.07, "triangle", 0.5, 0.45, 0.4),
    ding() {
      const v = voice(0.35, 0.35);
      if (!v) return;
      bell(v, v.t, 1319, 0.8, 1.4);
      bell(v, v.t + 0.35, 1047, 0.8, 1.8);
    },
    pickup: () => notes([784, 1175], 0.06, "triangle", 0.45, 0.18, 0.35),
    pickupAmmo() {
      const v = voice(0.45, 0.15);
      if (!v) return;
      // Loose rounds rattling, then the box settling.
      for (let i = 0; i < 4; i++) plate(v, v.t + rnd(0, 0.12), rnd(2800, 4200), 0.15, 0.05);
      clack(v, v.t + 0.14, 1600, 0.6);
      tone(v, v.t + 0.16, "triangle", 988, 988, 0.15, 0.005, 0.12);
    },
    reload() {
      const v = voice(0.6, 0.15);
      if (!v) return;
      click(v, v.t, 2600, 0.6);
      click(v, v.t + 0.2, 1900, 0.8);
      burst(v, v.t + 0.2, "lowpass", 500, 1, 0.4, 0.002, 0.05);
    },
    empty() {
      const v = voice(0.5, 0.1);
      if (v) click(v, v.t, 3400, 0.6);
    },
    explosion(distance: number) {
      const d = Math.max(0, Math.min(1500, distance || 0));
      const v = voice(Math.min(1, 1.15 / (1 + d / 220)), 0.45);
      if (!v) return;
      const lp = v.add(v.c.createBiquadFilter());
      lp.type = "lowpass";
      lp.frequency.value = Math.max(240, 9000 / (1 + d / 35));
      lp.connect(v.out);
      const t = v.t + Math.min(4, d / 343);
      // The boom: a falling sub tone and a thump, then a rolling rumble of low noise.
      tone(v, t, "sine", 72, 22, 1, 0.008, 2.6, lp);
      tone(v, t, "triangle", 130, 38, 0.55, 0.004, 0.9, lp);
      burst(v, t, "bandpass", 1100, 0.8, 0.7, 0.002, 0.35, lp, 300);
      for (let i = 0; i < 4; i++) burst(v, t + i * 0.42, "lowpass", 260 - i * 40, 0.8, 0.95 - i * 0.18, 0.02 + i * 0.05, 0.55, lp);
      // The crackle: debris and glass, scattered over a second and a half.
      for (let i = 0; i < 16; i++) burst(v, t + 0.12 + Math.random() * 1.6, "highpass", rnd(2200, 5200), 0.8, rnd(0.08, 0.32), 0.001, rnd(0.02, 0.07), lp);
    },
    rope() {
      const v = voice(0.45, 0.1);
      if (!v) return;
      const d = rnd(0.7, 0.9);
      burst(v, v.t, "bandpass", 700, 2, 0.8, 0.08, d, v.out, 2600);
      burst(v, v.t, "highpass", 5000, 0.7, 0.2, 0.1, d * 0.8);
      clack(v, v.t + d, 1500, 0.6);
    },
    alarm(on: boolean) {
      if (!on) return stopLoop("alarm");
      // A two-tone wail: a slow LFO sweeps two detuned square waves through a soft lowpass.
      loop("alarm", 0.13, 0.3, (c, add, g) => {
        const lp = filt(c, add, "lowpass", 2200, 1);
        lp.connect(g);
        const depth = gain(c, add, 180);
        osc(c, add, "triangle", 0.55).connect(depth);
        for (const f of [740, 744]) {
          const o = osc(c, add, "square", f);
          depth.connect(o.frequency);
          o.connect(lp);
        }
      });
    },
    helicopter(on: boolean, distance = 1) {
      if (!on) {
        if (ctx && loops.wind) loops.wind.g.gain.setTargetAtTime(WIND, ctx.currentTime, 0.6);
        return stopLoop("heli");
      }
      const l = loop("heli", 0, 0, (c, add, g) => {
        // Sources -> distance lowpass -> panner -> g (the distance level).
        const lp = filt(c, add, "lowpass", 2000, 0.7);
        const p = add(c.createStereoPanner());
        lp.connect(p).connect(g);
        // Rotor beat: one LFO drives a low thump and a sharper blade slap.
        const rotor = osc(c, add, "sine", rnd(4.7, 5.3));
        const thump = gain(c, add, 0);
        hiss(c, add).connect(filt(c, add, "lowpass", 120)).connect(thump);
        osc(c, add, "sine", 52).connect(gain(c, add, 0.5)).connect(thump);
        rotor.connect(pulses(c, add, 3)).connect(thump.gain);
        const slap = gain(c, add, 0);
        hiss(c, add).connect(filt(c, add, "bandpass", 850, 1.2)).connect(slap);
        rotor.connect(pulses(c, add, 10)).connect(gain(c, add, 0.7)).connect(slap.gain);
        // Turbine whine with a slight wobble.
        const whine = filt(c, add, "bandpass", 2600, 6);
        const w = osc(c, add, "sawtooth", 2600);
        lfo(c, add, 0.3, 15, w.frequency);
        w.connect(whine).connect(gain(c, add, 0.05)).connect(lp);
        thump.connect(lp);
        slap.connect(lp);
        return { lp, p };
      });
      if (l) ops.setHelicopterDistance(distance);
    },
    setHelicopterDistance(distance: number, pan = 0) {
      const l = loops.heli;
      if (!ctx || !l || !l.lp || !l.p) return;
      const n = Math.pow(1 - clamp(distance, 0, 1), 2);
      const t = ctx.currentTime;
      l.g.gain.setTargetAtTime(0.03 + 0.5 * n, t, 0.3);
      l.lp.frequency.setTargetAtTime(500 + 8000 * n, t, 0.3);
      l.p.pan.setTargetAtTime(clamp(pan, -1, 1), t, 0.3);
      // The rotor drowns the wind: it ducks as the helicopter comes close.
      const w = loops.wind;
      if (w) w.g.gain.setTargetAtTime(WIND * (1 - 0.85 * n), t, 0.4);
    },
    wind(on: boolean) {
      if (!on) return stopLoop("wind");
      // A soft, low rumble with slow gusts: two gentle lowpasses take out every hiss and whistle.
      loop("wind", WIND, 0, (c, add, g) => {
        const low = filt(c, add, "lowpass", 260, 0.5);
        lfo(c, add, rnd(0.05, 0.07), 70, low.frequency);
        const soft = filt(c, add, "lowpass", 420, 0.5);
        const gust = gain(c, add, 0.65);
        lfo(c, add, rnd(0.06, 0.09), 0.3, gust.gain);
        hiss(c, add).connect(low).connect(soft).connect(gust).connect(g);
      });
    },
    win: () => notes([392, 523, 659, 784, 1047], 0.12, "triangle", 0.5, 0.9, 0.45),
    lose: () => notes([392, 311, 262, 196], 0.22, "sawtooth", 0.25, 0.8, 0.35),
  };

  // Wrap every method: audio failures are swallowed so the game never sees them.
  const safe = {} as RaidSound;
  for (const [k, f] of Object.entries(ops) as [keyof RaidSound, (...a: unknown[]) => void][]) {
    (safe as unknown as Record<string, (...a: unknown[]) => void>)[k] = (...a) => {
      try {
        f(...a);
      } catch {
        /* audio is decoration */
      }
    };
  }
  return safe;
}
