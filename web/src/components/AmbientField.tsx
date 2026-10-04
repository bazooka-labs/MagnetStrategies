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
// Three details carry the illusion:
//
//   1. `CROWD` packs the loops toward the pole. Real field lines are densest
//      where the flux is, and even spacing is the other thing that makes a
//      dipole look like an onion.
//   2. `SPREAD` pushes the control points out past the poles, so outer lines
//      bow wider AND taller. A dipole's outer loops genuinely overshoot the
//      pole axis; without this they look like stacked lens shapes.
//   3. `FAN` offsets each anchor by a few units. Ten strokes landing on one
//      coordinate stack into a hard bright knot; a pole is a small region, not
//      a point.
//
// ── Why the top fade is a mask and not a crop ──────────────────────────────
// The convergence must not be visible — lines that visibly terminate look like
// a bug. The obvious fix is to push both poles beyond the viewport, and it
// does hide them, but it costs the whole effect: an axis longer than the
// screen leaves so little curvature in frame that the lines read as vertical
// streaks rather than as a field. Measured that, looked at it, rejected it.
//
// So the dipole stays compact and strongly curved, and a gradient mask
// dissolves the lines as they rise. They are never *cut off*; they fade out
// before the convergence is reached, which is also why the mask cannot be
// swapped for `overflow: hidden` on a shorter box — that is a crop, and a crop
// is exactly the hard edge being avoided.
//
// ── Deterministic on purpose ───────────────────────────────────────────────
// Every duration, delay, width and opacity is derived from the loop index.
// `Math.random()` here would produce different values on the server and the
// client and trip a hydration mismatch — and worse, do it intermittently.
//
// No hooks and no "use client": this is a server component and ships no JS.

const VB_W = 600;
const VB_H = 1000;

const POLE_X = 556;
const NORTH_Y = 300;
/** Below the viewBox: the south pole bleeds off the bottom edge. */
const SOUTH_Y = 1150;
const LINE_COUNT = 10;

/** Crowding exponent — >1 packs the inner loops toward the pole. */
const CROWD = 1.7;
/** How far the control points overshoot the poles, as a fraction of bulge. */
const SPREAD = 0.42;
/** Anchor scatter, in viewBox units, so the poles are a region not a point. */
const FAN = 9;

/** Fully visible below this y, fully gone above `FADE_GONE`. */
const FADE_SOLID = 660;
const FADE_GONE = 330;

/** Two decimals. Full float output put `3.0874999999999773` in the markup. */
const r2 = (n: number) => Math.round(n * 100) / 100;

const LINES = Array.from({ length: LINE_COUNT }, (_, i) => {
  const t = i / (LINE_COUNT - 1); // 0 = innermost loop, 1 = outermost

  const bulge = 30 + 400 * t ** CROWD;
  // 1.33 overshoot: a cubic reaches roughly 3/4 of its control offset, so this
  // lands the visual apex near `bulge`.
  const cx = r2(POLE_X - bulge * 1.33);
  const over = bulge * SPREAD;

  const ax = r2(POLE_X + i * FAN * 0.5);
  const ny = r2(NORTH_Y - i * FAN * 0.35);
  const sy = r2(SOUTH_Y + i * FAN * 0.35);

  // Peak opacity and weight fall outward, so the eye settles on the core.
  const bright = r2(0.4 + (0.17 - 0.4) * t);

  return {
    d: `M ${ax},${ny} C ${cx},${r2(ny - over)} ${cx},${r2(sy + over)} ${ax},${sy}`,
    bright,
    dim: r2(bright * 0.52),
    width: r2(3 + (1.4 - 3) * t),
    // Durations share no common factor, so the set never visibly re-syncs.
    pulseDuration: r2(14 + i * 1.55),
    // NEGATIVE delay starts each loop already mid-cycle. Without it all ten
    // would begin dim and brighten together on first paint, which is the one
    // thing that would make this look like an animation rather than ambience.
    // The leading 3.1 matters: at i = 0 the formula gave exactly 0, so the
    // innermost and brightest loop was the one line that visibly faded up.
    pulseDelay: -r2(3.1 + i * 2.7 + (i % 3) * 1.3),
    // The ripple is the opposite: ONE duration shared by every loop, with the
    // delay stepping evenly outward. That is what makes it read as a single
    // wave travelling through the field rather than ten loops each doing their
    // own thing — a shared period is the whole mechanism.
    rippleDelay: -r2(i * 0.62),
    // Outer loops swell slightly more, so the wave visibly grows as it travels.
    swell: r2(1.03 + 0.03 * t),
    // The travelling glint. Longer lines carry it slower, so the whole family
    // reads as one disturbance moving outward rather than a row of blinkers.
    flowDuration: r2(7 + i * 0.9),
    flowDelay: -r2(i * 1.7),
    glintOpacity: r2(0.55 + (0.28 - 0.55) * t),
    glintWidth: r2((3 + (1.4 - 3) * t) * 1.3),
  };
});

export function AmbientField() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-y-0 right-0 -z-10 w-[min(100vw,54rem)]"
    >
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        preserveAspectRatio="xMaxYMid slice"
        className="h-full w-full"
        fill="none"
      >
        <defs>
          {/* Anchors the loops to something, so they read as a field around a
              source rather than as free-floating arcs. */}
          <radialGradient id="ambient-field-pole">
            <stop offset="0%" stopColor="#c084fc" stopOpacity="0.16" />
            <stop offset="55%" stopColor="#a855f7" stopOpacity="0.05" />
            <stop offset="100%" stopColor="#a855f7" stopOpacity="0" />
          </radialGradient>

          {/* userSpaceOnUse, not the default objectBoundingBox: the gradient
              has to be keyed to fixed viewBox coordinates, otherwise it would
              resolve against each masked shape's own box and every loop would
              fade over its own length instead of over the shared skyline. */}
          <linearGradient
            id="ambient-field-fade"
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1={FADE_GONE}
            x2="0"
            y2={FADE_SOLID}
          >
            <stop offset="0%" stopColor="#000" />
            <stop offset="100%" stopColor="#fff" />
          </linearGradient>

          <mask
            id="ambient-field-mask"
            maskUnits="userSpaceOnUse"
            x="0"
            y="0"
            width={VB_W}
            height={VB_H}
          >
            <rect
              x="0"
              y="0"
              width={VB_W}
              height={VB_H}
              fill="url(#ambient-field-fade)"
            />
          </mask>
        </defs>

        <ellipse
          cx={POLE_X}
          cy={780}
          rx={210}
          ry={300}
          fill="url(#ambient-field-pole)"
          className="animate-field-glow"
        />

        <g mask="url(#ambient-field-mask)">
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
