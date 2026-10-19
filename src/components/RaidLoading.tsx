import { useEffect, useRef, useState, type CSSProperties } from "react";

/** One at a time while the raid loads. */
const TIPS = [
  "Door codes are on sticky notes and IT terminals: read them with E, then type them on the keypad.",
  "Tripwires sit at ankle height. Jump them with Space, or find another way round.",
  "Cameras sweep. Stay out of the cone, or shoot them out.",
  "Intel files are optional, but each one adds to your score.",
  "A headshot drops a guard at once. The head of security takes three.",
  "Staff are not the target. Shooting near them makes them call security.",
  "Desks, cabinets and partitions are cover. Guards use them too.",
  "M mutes, Esc pauses.",
];
const FLOORS_SHOWN = 5;
const WINDOWS = 6;

/**
 * The raid's loading screen, shared by the download step and the game itself: the headquarters lights
 * up floor by floor, the first floor's plan draws itself as it is built, and the real step and
 * percentage show under it. The bar only ever moves forward.
 */
export function RaidLoadingScreen({ progress, step, plan, built = 0 }: { progress: number; step: string; plan?: string[]; built?: number }) {
  const [tip, setTip] = useState(() => Math.floor(Math.random() * TIPS.length));
  const shown = useRef(0);
  shown.current = Math.max(shown.current, Math.min(1, progress));
  const p = shown.current;
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const id = window.setInterval(() => setTip((t) => (t + 1) % TIPS.length), 3400);
    return () => window.clearInterval(id);
  }, []);

  // The floor plan, row by row as far as the build has got.
  useEffect(() => {
    const canvas = canvasRef.current;
    const c = canvas?.getContext("2d");
    if (!canvas || !c || !plan) return;
    const s = 5;
    const rows = Math.round(Math.min(1, Math.max(0, (built - 0.05) / 0.6)) * plan.length);
    c.clearRect(0, 0, canvas.width, canvas.height);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < plan[y].length; x++) {
        const ch = plan[y][x];
        if (ch === "." || "GHBCNI+=KgEArsuJq".includes(ch)) {
          c.fillStyle = "rgba(255, 255, 255, 0.05)";
          c.fillRect(x * s, y * s, s, s);
          continue;
        }
        c.fillStyle = "#XSV".includes(ch) ? "#d9dbe2" : ch === "W" ? "#6cc4ff" : "PU".includes(ch) ? "#ffb81f" : "TYFDLR".includes(ch) ? "#4fd6aa" : "rgba(255, 184, 31, 0.5)";
        c.fillRect(x * s, y * s, s - 1, s - 1);
      }
    }
  }, [plan, built]);

  return (
    <div className="raid-boot" role="status" aria-live="polite">
      <span className="raid-kicker">Hidden level</span>
      <h2>Raid the HQ</h2>
      <div className="raid-hq" aria-hidden="true">
        <svg viewBox="0 0 84 112" width="84" height="112">
          <rect className="raid-hq-body" x="6" y="6" width="72" height="104" rx="2" />
          {Array.from({ length: FLOORS_SHOWN }, (_, f) => {
            const lit = p >= 0.2 + (f + 1) * 0.16;
            const y = 6 + 104 - (f + 1) * 20 + 6;
            return (
              <g key={f} className={lit ? "lit" : undefined}>
                {Array.from({ length: WINDOWS }, (_, w) => (
                  <rect key={w} x={12 + w * 10.6} y={y} width="7" height="9" style={{ "--i": w } as CSSProperties} />
                ))}
              </g>
            );
          })}
        </svg>
        {plan && <canvas ref={canvasRef} width={plan[0].length * 5} height={plan.length * 5} />}
      </div>
      <p className="raid-step">{step}</p>
      <div className="raid-progress">
        <i style={{ transform: `scaleX(${p})` }} />
      </div>
      <div className="raid-progress-row">
        <b>{Math.floor(p * 100)}%</b>
        <small>Esc to cancel</small>
      </div>
      <p key={tip} className="raid-tip">
        {TIPS[tip]}
      </p>
    </div>
  );
}
