// Ambient magnetic field lines — the site's one piece of background life.
//
// ── Why this exists ────────────────────────────────────────────────────────
// `magnet-bg.png` was only ever on the landing page. Every other route
// rendered on flat `bg-surface` with no ambient layer at all, which is why the
// site read as static: of the animation used outside the landing page, 44 of 52
// instances were `animate-spin` and `animate-pulse` — spinners and skeletons,
// which signal *waiting* rather than life.
//
// So this mounts once in the root layout rather than per page.
//
// ── The geometry is a real dipole, not decoration ──────────────────────────
// Every line leaves the same north pole and returns to the same south pole.
// That shared convergence is the whole visual signature of a magnetic field,
// and getting it wrong is what the first attempt got wrong: when each loop had
// its own start and end point, nothing pinched and the result read as
// concentric ripples — a radar sweep, not a magnet.
//
// The axis is DIAGONAL. An earlier version ran it vertically, and the lines
// read as a north–south curtain rather than as a field: an arc only looks
// magnetic when you can see it turn. Now the poles sit off the right edge and
// below the bottom edge, so each line enters from the right, arcs out toward
// the middle of the screen, and returns to the bottom-right corner.
//
// Because the axis can point anywhere, the bulge is built from the axis rather
// than from the x-axis: `u` runs pole to pole, `p` is its perpendicular, and
// every control point is placed in terms of those two. The vertical version
// could hard-code "subtract from x"; this cannot.
//
// Three details carry the illusion:
//
//   1. `CROWD` packs the loops toward the pole. Real field lines are densest
//      where the flux is, and even spacing is the other thing that makes a
//      dipole look like an onion.
//   2. `SPREAD` pushes the control points out past the poles along the axis,
//      so outer lines bow wider AND longer.
//   3. `FAN` slides each anchor along the axis. Ten strokes landing on one
//      coordinate stack into a hard bright knot; a pole is a small region.
//
// ── Why there is no longer a fade mask ─────────────────────────────────────
// The previous vertical layout needed one: its convergence sat inside the
// frame, and lines that visibly terminate look like a bug. The diagonal layout
// solves that with placement instead. Both poles are outside the viewBox — one
// past the right edge, one below the bottom — and the box is pinned to
// `bottom-0 right-0`, so the only edges the lines cross are the screen's own
// right and bottom. They bleed off the display rather than stopping in it.
//
// That is also why `slice` matters and `meet` would be a bug: `slice` scales
// the viewBox to cover the box, so anything outside the viewBox is further
// outside the viewport and stays hidden. Under `meet` the viewBox is
// letterboxed INSIDE the viewport, and the poles — which live outside the
// viewBox on purpose — would be rendered in the leftover margin, putting the
// convergence back on screen.
//
// ── Deterministic on purpose ───────────────────────────────────────────────
// Every duration, delay, width and opacity is derived from the loop index.
// `Math.random()` here would produce different values on the server and the
// client and trip a hydration mismatch — and worse, do it intermittently.
//
// No hooks and no "use client": this is a server component and ships no JS.

const VB_W = 1000;
const VB_H = 800;

/** North pole, past the right edge of the viewBox. */
const NORTH: readonly [number, number] = [1055, 285];
/** South pole, below the bottom edge. */
const SOUTH: readonly [number, number] = [815, 890];

const LINE_COUNT = 10;

/** Crowding exponent — >1 packs the inner loops toward the pole. */
const CROWD = 1.7;
/** How far the control points overshoot the poles along the axis. */
const SPREAD = 0.42;
/** Anchor scatter along the axis, so the poles are a region not a point. */
const FAN = 9;

const BULGE_MIN = 45;
const BULGE_MAX = 520;

/** Two decimals. Full float output put `3.0874999999999773` in the markup. */
const r2 = (n: number) => Math.round(n * 100) / 100;

// Axis basis, computed once. `u` points north → south; `p` is perpendicular,
// turned so the loops bow up and to the left, into the middle of the screen.
const AXIS_LEN = Math.hypot(SOUTH[0] - NORTH[0], SOUTH[1] - NORTH[1]);
const UX = (SOUTH[0] - NORTH[0]) / AXIS_LEN;
const UY = (SOUTH[1] - NORTH[1]) / AXIS_LEN;
const PX = -UY;
const PY = UX;

/** Midpoint of the axis — the shared point the ripple scales about. */
const ORIGIN_X = r2((NORTH[0] + SOUTH[0]) / 2);
const ORIGIN_Y = r2((NORTH[1] + SOUTH[1]) / 2);

const LINES = Array.from({ length: LINE_COUNT }, (_, i) => {
  const t = i / (LINE_COUNT - 1); // 0 = innermost loop, 1 = outermost

  const bulge = BULGE_MIN + (BULGE_MAX - BULGE_MIN) * t ** CROWD;
  const over = bulge * SPREAD;
  const slide = i * FAN * 0.35;

  const nx = NORTH[0] + UX * slide;
  const ny = NORTH[1] + UY * slide;
  const sx = SOUTH[0] - UX * slide;
  const sy = SOUTH[1] - UY * slide;

  // 1.33 overshoot: a cubic reaches roughly 3/4 of its control offset, so this
  // lands the visual apex near `bulge`.
  const reach = bulge * 1.33;
  const c1x = nx + PX * reach - UX * over;
  const c1y = ny + PY * reach - UY * over;
  const c2x = sx + PX * reach + UX * over;
  const c2y = sy + PY * reach + UY * over;

  // Peak opacity and weight fall outward, so the eye settles on the core.
  const bright = r2(0.4 + (0.17 - 0.4) * t);
  const width = r2(3 + (1.4 - 3) * t);

  return {
    d:
      `M ${r2(nx)},${r2(ny)} C ${r2(c1x)},${r2(c1y)} ` +
      `${r2(c2x)},${r2(c2y)} ${r2(sx)},${r2(sy)}`,
    bright,
    dim: r2(bright * 0.52),
    width,
    // Durations share no common factor, so the set never visibly re-syncs.
    pulseDuration: r2(14 + i * 1.55),
    // NEGATIVE delay starts each loop already mid-cycle. Without it all ten
    // would begin dim and brighten together on first paint, which is the one
    // thing that would make this look like an animation rather than ambience.
    // The leading 3.1 matters: at i = 0 the formula gave exactly 0, so the
    // innermost and brightest loop was the one line that visibly faded up.
    pulseDelay: -r2(3.1 + i * 2.7 + (i % 3) * 1.3),
    // The ripple uses ONE shared period with delays stepping evenly outward.
    // That is what makes it read as a single wave travelling through the field
    // rather than ten loops each doing their own thing.
    rippleDelay: -r2(i * 0.62),
    swell: r2(1.03 + 0.03 * t),
    // The travelling glint. Longer lines carry it slower, so the family reads
    // as one disturbance moving outward rather than a row of blinkers.
    flowDuration: r2(7 + i * 0.9),
    flowDelay: -r2(i * 1.7),
    glintOpacity: r2(0.55 + (0.28 - 0.55) * t),
    glintWidth: r2(width * 1.3),
  };
});

export function AmbientField() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed bottom-0 right-0 -z-10 h-[min(100vh,48rem)] w-[min(100vw,60rem)]"
    >
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="xMaxYMax slice"
        className="h-full w-full"
        fill="none"
      >
        <defs>
          {/* Anchors the loops to something, so they read as a field around a
              source rather than as free-floating arcs. */}
          <radialGradient id="ambient-field-pole">
            <stop offset="0%" stopColor="#c084fc" stopOpacity="0.15" />
            <stop offset="55%" stopColor="#a855f7" stopOpacity="0.05" />
            <stop offset="100%" stopColor="#a855f7" stopOpacity="0" />
          </radialGradient>
        </defs>

        <ellipse
          cx={940}
          cy={640}
          rx={260}
          ry={300}
          fill="url(#ambient-field-pole)"
          className="animate-field-glow"
        />

        {/* The ripple scales about the axis midpoint, and every loop must use
            the SAME point or they would breathe about ten different centres
            and the wave would not read. Set here once and inherited: CSS
            custom properties cascade, `transform-origin` does not. */}
        <g
          style={{
            ["--field-origin-x" as string]: `${ORIGIN_X}px`,
            ["--field-origin-y" as string]: `${ORIGIN_Y}px`,
          }}
        >
          {LINES.map((l, i) => (
            <path
              key={i}
              d={l.d}
              stroke="#c084fc"
              strokeWidth={l.width}
              strokeLinecap="round"
              className="animate-field-line"
              style={{
                // Custom properties rather than literals in the keyframes: one
                // shared pair of animations drives every loop, and each loop
                // supplies its own range and phase.
                ["--field-dim" as string]: l.dim,
                ["--field-bright" as string]: l.bright,
                ["--field-swell" as string]: l.swell,
                ["--field-pulse-dur" as string]: `${l.pulseDuration}s`,
                ["--field-pulse-delay" as string]: `${l.pulseDelay}s`,
                ["--field-ripple-delay" as string]: `${l.rippleDelay}s`,
              }}
            />
          ))}

          {/* Second pass: a bright segment travelling along each line.
              The scaleX breathing alone could not carry this. Its amplitude is
              proportional to bulge, so the innermost loops — the brightest and
              most visible ones — moved about a pixel while the only real travel
              (~37px) landed on the faintest outer lines. Measured, looked at,
              and judged too subtle to read as motion.

              `pathLength="1000"` normalises every line to the same scale, so
              one dash pattern gives every loop an identically proportioned
              glint regardless of its true length — without it the inner and
              outer loops would show glints of visibly different lengths.

              These carry `field-ripple` too, with the same swell and phase as
              the line underneath. A glint that did not breathe with its own
              line would visibly drift off it. */}
          {LINES.map((l, i) => (
            <path
              key={`glint-${i}`}
              d={l.d}
              pathLength={1000}
              stroke="#e9d5ff"
              strokeWidth={l.glintWidth}
              strokeLinecap="round"
              strokeDasharray="300 700"
              opacity={l.glintOpacity}
              className="animate-field-flow"
              style={{
                ["--field-swell" as string]: l.swell,
                ["--field-ripple-delay" as string]: `${l.rippleDelay}s`,
                ["--field-flow-dur" as string]: `${l.flowDuration}s`,
                ["--field-flow-delay" as string]: `${l.flowDelay}s`,
              }}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}
