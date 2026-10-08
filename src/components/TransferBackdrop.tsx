import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import * as api from "../lib/api";
import { DefendGame } from "./DefendGame";

/** Grid cell size in px. Keep in sync with `--cell` on `.backdrop` in styles.css. */
const CELL = 48;
/** A server covers exactly 2 x 2 grid cells, so its edges lie on grid lines and it reads as part of the grid. */
const SERVER_W = 2 * CELL;
const SERVER_H = 2 * CELL;
/** A server is a case holding this many stacked units. */
const UNITS = [0, 1, 2];
const UNIT_H = 22;
const UNIT_STEP = 28;
/** A pulse is drawn as three overlapping dashes that share a leading edge: a comet with a fading tail. */
const PULSE_LAYERS = ["pulse-tail", "pulse-body", "pulse-head"];

type Cell = [x: number, y: number];

/** Where a connection tile sits in the window, in px, and the colour of its badge. */
interface TileBox {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

/** A pulse follows grid lines through these corner points, then rests until its cycle restarts. */
interface Route {
  points: Cell[];
  /** Length of one cycle; the pulse travels during the first third of it. */
  seconds: number;
  /** Negative, so the routes are out of step with each other from the first frame. */
  delay: number;
  /** Only on deliveries: the connection tile the pulse goes into. */
  to?: TileBox;
}

function subscribeToResize(onChange: () => void) {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

/** Whole grid cells that fit in the window, as "columns,rows" (a string, so equal sizes compare equal). */
const gridSize = () => `${Math.floor(window.innerWidth / CELL)},${Math.floor(window.innerHeight / CELL)}`;

const toPath = (points: Cell[]) => "M" + points.map(([x, y]) => `${x * CELL} ${y * CELL}`).join(" L");

/**
 * A small rack server centred on a grid cell: a case, three units, each with two lights and vents.
 * Behind it a ring the shape of the case keeps expanding and fading, like a signal going out.
 * `color` tints its lights and ring; without it they use the accent colour. It can be clicked,
 * which does nothing visible (see the hidden game in TransferBackdrop).
 */
function ServerDrawing({
  at: [x, y],
  ringDelay,
  color,
  onClick,
}: {
  at: Cell;
  ringDelay: number;
  color?: string;
  onClick(): void;
}) {
  return (
    <g
      className="server"
      transform={`translate(${x * CELL - SERVER_W / 2} ${y * CELL - SERVER_H / 2})`}
      style={{ "--pulse-color": color } as CSSProperties}
      onClick={onClick}
    >
      <rect className="server-ring" width={SERVER_W} height={SERVER_H} rx={9} style={{ animationDelay: `${ringDelay}s` }} />
      <rect className="server-case" width={SERVER_W} height={SERVER_H} rx={9} />
      {UNITS.map((unit) => {
        const top = 9 + unit * UNIT_STEP;
        const middle = top + UNIT_H / 2;
        return (
          <g key={unit}>
            <rect className="server-unit" x={7} y={top} width={SERVER_W - 14} height={UNIT_H} rx={4} />
            <circle className="server-light" cx={16} cy={middle} r={2.5} style={{ animationDelay: `${unit * -0.9}s` }} />
            <circle className="server-light off" cx={24} cy={middle} r={2.5} />
            <path className="server-vent" d={`M38 ${middle - 3}h42M38 ${middle + 3}h42`} />
          </g>
        );
      })}
    </g>
  );
}

/** Longer than any tile animation (screen entrance, page scroll, reorder slide), in ms. */
const SETTLE_MS = 450;

/** The edges of the whole tile list in the window, in px. */
interface ListBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * The connection tiles currently in view, and the list that holds them. They are measured from the
 * page instead of computed, so the backdrop follows the real layout through resizing, scrolling
 * and connections being added.
 */
function useTileBoxes(): { tiles: TileBox[]; list: ListBox | null } {
  const [boxes, setBoxes] = useState<{ tiles: TileBox[]; list: ListBox | null }>({ tiles: [], list: null });
  useEffect(() => {
    const measure = () => {
      const list = document.querySelector(".saved-list")?.getBoundingClientRect();
      const tiles = [...document.querySelectorAll(".saved-row:not(.saved-new)")]
        .map((tile) => {
          const r = tile.getBoundingClientRect();
          const badge = tile.querySelector(".saved-icon");
          const color = badge ? getComputedStyle(badge).backgroundColor : "";
          return { x: r.x, y: r.y, width: r.width, height: r.height, color };
        })
        // Tiles scrolled out of the list are not on screen.
        .filter((box) => list && box.y >= list.top - 1 && box.y + box.height <= list.bottom + 1);
      const next = { tiles, list: list ? { left: list.left, right: list.right, top: list.top, bottom: list.bottom } : null };
      // Keep the old value when nothing moved, so measuring does not cause a re-render loop.
      setBoxes((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    };
    // Tiles slide for a moment when the screen appears, the list scrolls or they are reordered, so
    // every change is measured at once and again when things have settled.
    let settle = 0;
    const measureNowAndSettled = () => {
      measure();
      window.clearTimeout(settle);
      settle = window.setTimeout(measure, SETTLE_MS);
    };
    measureNowAndSettled();
    const observer = new MutationObserver(measureNowAndSettled);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", measureNowAndSettled);
    document.addEventListener("scroll", measureNowAndSettled, true);
    return () => {
      window.clearTimeout(settle);
      observer.disconnect();
      window.removeEventListener("resize", measureNowAndSettled);
      document.removeEventListener("scroll", measureNowAndSettled, true);
    };
  }, []);
  return boxes;
}

/** The grid crossing nearest to the middle of a tile. */
const tileCell = (box: TileBox): Cell => [
  Math.round((box.x + box.width / 2) / CELL),
  Math.round((box.y + box.height / 2) / CELL),
];

/** A pulse's dashes slide this many path units in one journey: the 100-unit path plus the tail. */
const PULSE_TRAVEL = 132;

/**
 * Seconds into a delivery's cycle at which the pulse reaches the edge of its tile: the route is
 * walked in small steps until a step lands inside the tile.
 */
function arrivalSeconds(points: Cell[], to: TileBox, seconds: number): number {
  const STEP = 2;
  let walked = 0;
  let toEdge: number | null = null;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = [points[i - 1][0] * CELL, points[i - 1][1] * CELL];
    const [x1, y1] = [points[i][0] * CELL, points[i][1] * CELL];
    const length = Math.abs(x1 - x0) + Math.abs(y1 - y0);
    for (let d = 0; d < length && toEdge === null; d += STEP) {
      const x = x0 + ((x1 - x0) * d) / length;
      const y = y0 + ((y1 - y0) * d) / length;
      if (x >= to.x && x <= to.x + to.width && y >= to.y && y <= to.y + to.height) toEdge = walked + d;
    }
    walked += length;
  }
  // Fraction of the route covered at the edge, then of the journey (which also slides the tail out).
  const journey = (((toEdge ?? walked) / walked) * 100) / PULSE_TRAVEL;
  return (journey * seconds) / 3;
}

/** The hidden game starts after this many clicks on a server within this long. */
const SECRET_CLICKS = 5;
const SECRET_WINDOW_MS = 2000;

/**
 * Decoration behind the start screen: three servers scattered on a faint grid, and pulses that
 * wander along the grid lines. Some run between servers, others head off into the grid or arrive
 * from it, and each server delivers to a connection tile, which glows as the pulse goes in.
 */
export function TransferBackdrop() {
  const [columns, rows] = useSyncExternalStore(subscribeToResize, gridSize).split(",").map(Number);
  const { tiles, list } = useTileBoxes();

  // Hidden game: clicking a server SECRET_CLICKS times in quick succession starts it.
  const [playing, setPlaying] = useState(false);
  const clicks = useRef<number[]>([]);
  const countClick = () => {
    const now = Date.now();
    clicks.current = [...clicks.current.filter((t) => now - t < SECRET_WINDOW_MS), now];
    if (clicks.current.length >= SECRET_CLICKS) {
      clicks.current = [];
      // The game is played at the window's default size: lock the window there first, so the game
      // measures the final layout, and start even if the window could not be locked.
      void api
        .lockWindowSize(true)
        .catch(() => {})
        .then(() => setPlaying(true));
    }
  };
  const stopPlaying = useCallback(() => {
    setPlaying(false);
    api.lockWindowSize(false).catch(() => {});
  }, []);

  // The frame the servers and routes are laid out on, in grid cells. With tiles on screen it hugs
  // them, so the picture stays together on a large window; otherwise it is the window itself.
  const cell = (px: number) => Math.round(px / CELL);
  const [left, right, top, bottom, middle] = list
    ? [
        Math.max(2, cell(list.left) - 2),
        Math.min(columns - 2, cell(list.right) + 1),
        Math.max(1, cell(list.top) - 4),
        Math.min(rows - 1, cell(list.bottom) + 3),
        cell((list.left + list.right) / 2),
      ]
    : [2, columns - 2, 1, rows - 1, Math.round(columns / 2)];

  // Deliberately uneven, so the servers look scattered around the content instead of pinned to corners:
  // one beside the tiles on the right, one under them, one low on the left edge.
  const topRight: Cell = [right + 1, top + 3];
  const bottomRight: Cell = [right - 5, bottom - 1];
  const bottomLeft: Cell = [left, bottom - 3];
  const servers = [topRight, bottomRight, bottomLeft];

  // Each server delivers to one tile and reaches it without passing under any other tile, so a
  // pulse is only ever seen going into the tile whose colour it carries:
  // - the server in the right margin goes along the top row into its right-most tile,
  // - the server in the left margin goes along the bottom row into its left-most tile,
  // - the server below the tiles comes up from underneath into the middle of the bottom row.
  // The tiles are opaque, so the pulse disappears under the tile as if it went inside. The pulse,
  // the tile's glow and the sending server all take the colour of that tile's badge.

  // Tiles in one row share a top edge; allow a few px for a tile that is still sliding into place.
  const inRowOf = (row: TileBox) => tiles.filter((t) => Math.abs(t.y - row.y) < 8);
  const topRow = tiles.length ? inRowOf(tiles[0]) : [];
  const bottomRow = tiles.length ? inRowOf(tiles[tiles.length - 1]) : [];
  const fromSide = (from: Cell, to: TileBox): Cell[] => {
    const [x, y] = tileCell(to);
    return [from, [from[0], y], [x, y]];
  };
  const fromBelow = (from: Cell, to: TileBox): Cell[] => {
    const [x, y] = tileCell(to);
    // The first grid row under the tiles, or the server's own row if there is none in between.
    const corridor = Math.min(from[1], Math.ceil((to.y + to.height + 8) / CELL));
    return [from, [from[0], corridor], [x, corridor], [x, y]];
  };
  const deliveries: (Route & { to: TileBox; arrival: number })[] =
    tiles.length === 0
      ? []
      : [
          { to: topRow[topRow.length - 1], points: fromSide(topRight, topRow[topRow.length - 1]), seconds: 10, delay: -8 },
          {
            to: bottomRow[Math.floor(bottomRow.length / 2)],
            points: fromBelow(bottomRight, bottomRow[Math.floor(bottomRow.length / 2)]),
            seconds: 12,
            delay: -3,
          },
          { to: bottomRow[0], points: fromSide(bottomLeft, bottomRow[0]), seconds: 11, delay: -5 },
        ].map((delivery) => ({ ...delivery, arrival: arrivalSeconds(delivery.points, delivery.to, delivery.seconds) }));

  const routes: Route[] = [
    // Server to server, with a jog on the way down the right edge.
    { points: [topRight, [right + 1, top + 8], [right, top + 8], [right, bottom - 1], bottomRight], seconds: 13, delay: -1 },
    // Out of a server and off into the grid.
    { points: [topRight, [right + 1, top], [middle + 3, top], [middle + 3, top + 2]], seconds: 11, delay: -6 },
    { points: [bottomLeft, [left, top + 6], [left - 1, top + 6], [left - 1, top + 2]], seconds: 12, delay: -9 },
    // Arriving at a server from somewhere in the grid.
    { points: [[middle - 2, bottom], [middle - 2, bottom - 1], [left, bottom - 1], bottomLeft], seconds: 14, delay: -11 },
    // Passing through without touching a server.
    { points: [[left, top + 2], [left, top], [middle - 3, top]], seconds: 9, delay: -4 },
    ...deliveries,
  ];

  return (
    <>
      <svg className="backdrop" aria-hidden="true">
        {deliveries.map(({ to: { color, ...box }, seconds, delay, arrival }, i) => (
          // A blurred copy of the tile behind it: only its soft edge shows, as a glow around the tile.
          // Its cycle starts later than the pulse's by the time the pulse needs to reach the tile.
          <rect
            key={i}
            className="tile-aura"
            {...box}
            rx={14}
            style={{ "--seconds": `${seconds}s`, "--delay": `${delay + arrival}s`, "--pulse-color": color } as CSSProperties}
          />
        ))}
        {routes.map((route, i) => (
          <g
            key={i}
            className={`backdrop-pulse ${route.to ? "delivery" : ""}`}
            style={
              {
                "--seconds": `${route.seconds}s`,
                "--delay": `${route.delay}s`,
                "--pulse-color": route.to?.color,
              } as CSSProperties
            }
          >
            {PULSE_LAYERS.map((layer) => (
              <path key={layer} className={layer} d={toPath(route.points)} pathLength={100} />
            ))}
          </g>
        ))}
        {/* Same order as the deliveries, so each server shows the colour of the tile it sends to. */}
        {servers.map((cell, i) => (
          <ServerDrawing key={i} at={cell} ringDelay={i * -1.7} color={deliveries[i]?.to.color} onClick={countClick} />
        ))}
        {/* The game gets a fourth shooter, at the top of the window; it is not part of the backdrop otherwise. */}
        {playing && <ServerDrawing at={[Math.round(columns / 2), 2]} ringDelay={-0.8} onClick={countClick} />}
      </svg>
      {playing && <DefendGame onExit={stopPlaying} />}
    </>
  );
}
