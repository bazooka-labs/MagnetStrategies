"use client";

import { type ReactNode } from "react";
import Image from "next/image";

// Real token icons (by unit name, "$" stripped). Tokens not listed fall back to a text chip.
// This is the $U *ASA* mark — used only for the token itself, never as the brand/nav logo.
const TOKEN_ICONS: Record<string, string> = {
  U: "/tokens/u.png",
  MUSD: "/musd-icon.png",
  ALGO: "/tokens/algo.png",
  TALGO: "/tokens/talgo.png",
  USDC: "/tokens/usdc.png",
  MOOJ: "/tokens/mooj.png",
  ALPHA: "/tokens/alpha.png",
  COMPX: "/tokens/compx.png",
  HAY: "/tokens/hay.png",
  FOLKS: "/tokens/folks.png",
  // magnetALGO (ASA 3760411000, unit uALGO) — Myth Finance's ALGO+U dualSTAKE
  // token. Pera-verified 2026-11-05; the logo is their published artwork,
  // vendored here rather than hot-linked from Pera's CDN so the card does not
  // depend on a third-party host, and so the CSP has one less origin to admit.
  UALGO: "/tokens/ualgo.png",
};
/** Real icon path for a token symbol ("$"/case-insensitive), or null for a text fallback. */
export const tokenIcon = (sym: string) => TOKEN_ICONS[sym.replace("$", "").toUpperCase()] ?? null;
// Wordmark-style art that should fit inside the chip rather than fill it.
const CONTAIN_ICONS = new Set(["ALPHA"]);
export const tokenIconFit = (sym: string) =>
  CONTAIN_ICONS.has(sym.replace("$", "").toUpperCase()) ? "object-contain" : "object-cover";
// Per-token vertical nudge for art whose visual center isn't the geometric center
// (e.g. the COMPX coin's face sits high above its 3D base). Tune the % to taste.
const ICON_NUDGE: Record<string, string> = { COMPX: "translate-y-[12%]" };
const iconNudge = (sym: string) => ICON_NUDGE[sym.replace("$", "").toUpperCase()] ?? "";

/** Glassy panel with the brand's top gradient hairline (matches the landing cards). */
export function Panel({
  children,
  className = "",
  glow = false,
  glowClass = "",
}: {
  children: ReactNode;
  className?: string;
  glow?: boolean;
  /**
   * A coloured glow that REPLACES the panel's default drop shadow.
   *
   * It has to replace rather than stack, because the default includes
   * `shadow-black/40`, which sets `--tw-shadow-color` and therefore recolours
   * any shadow passed through `className` to black. Passing a glow that way
   * leaves only its ring visible — a thin border where a neon glow was
   * intended, which is exactly how this first shipped.
   */
  glowClass?: string;
}) {
  const shadow = glowClass || "shadow-xl shadow-black/40";
  return (
    <div
      className={`relative overflow-hidden rounded-2xl border border-white/10 bg-black/40 backdrop-blur-sm ${shadow} ${
        glow ? "glow-blue" : ""
      } ${className}`}
    >
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-magnet-500/60 to-transparent" />
      {children}
    </div>
  );
}

/**
 * Collateral family, as a glow.
 *
 * Not decoration. Every $U-denominated vault shares one risk — the whole book
 * rides on one thin token. ALGO/USDC is the only collateral that does not, and
 * the only one deep enough to actually unwind a seizure without moving the price
 * against the liquidator. Colouring the family makes that split readable at a
 * glance instead of requiring someone to parse four pair names.
 *
 * Purple is the Magnet brand hue (magnet-500, #a855f7); gold marks the outsider.
 * Ring plus shadow so it layers OVER a status tint rather than competing with it
 * — a stale or at-risk card still reads red first. The opacities were tuned by
 * rendering against the red a stale pool already carries, which is the state
 * they have to survive.
 */
/*
  Re-exported from `@/lib/glow`, which is NOT a client module.

  These strings have to be readable by SERVER components too, and an import
  from this file gives a server component a client-reference object rather
  than the value — interpolating one into a className yields "[object
  Object]". `lib/glow.ts` records the failure in full. The re-export keeps
  every existing client-side import working against one definition.
*/
export { ALGO_GLOW, MAGNET_GLOW, MAGNET_GLOW_300 } from "@/components/glow";
import { ALGO_GLOW, MAGNET_GLOW } from "@/components/glow";

/** Keyed by VaultType.id / oracle pool id — the one non-$U collateral glows gold. */
export const collateralGlow = (id: string) => (id === "algo-usdc" ? ALGO_GLOW : MAGNET_GLOW);

export function SoonBadge() {
  return (
    <span className="inline-flex items-center rounded-full border border-magnet-500/30 bg-magnet-500/10 px-2.5 py-0.5 text-xs font-medium text-magnet-300">
      Coming soon
    </span>
  );
}

export function LaunchingBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-green-500/30 bg-green-500/10 px-2.5 py-0.5 text-xs font-medium text-green-400">
      <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse-slow" />
      Launching first
    </span>
  );
}

/** A single token chip — real icon if we have one, else a text fallback. */
function TokenChip({ sym, variant, className = "", overlapped = false }: {
  sym: string; variant: "primary" | "secondary"; className?: string;
  /**
   * This chip sits UNDER the one before it, so its left edge is covered.
   *
   * Only matters for the text fallback: an icon fills the circle and reads
   * fine part-covered, but a word does not. "uALGO" in the pair glyph
   * rendered as "ALGO" — the leading `u` hidden behind the $U chip, on a page
   * that also lists a real U / ALGO pool. Caught by rasterising; the class
   * names alone looked correct.
   */
  overlapped?: boolean;
}) {
  const icon = tokenIcon(sym);
  const base = `flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/15 shadow-md ${className}`;
  if (icon) {
    return (
      <span className={`${base} overflow-hidden bg-black`}>
        <Image src={icon} alt={sym} width={36} height={36} className={`h-full w-full ${tokenIconFit(sym)} ${iconNudge(sym)}`} />
      </span>
    );
  }
  const fill = variant === "primary"
    ? "bg-gradient-to-br from-magnet-500 to-magnet-700 text-white"
    : "bg-surface-lighter text-gray-200";
  const text = sym.replace("$", "");
  /**
   * The chip is 36px and the overlap hides 12px of it, so a five- or
   * six-character ticker has to shrink AND shift to be read at all. Sized by
   * length rather than by a single smaller value, so the common short
   * tickers keep the weight they were designed with.
   */
  const size = text.length >= 6 ? "text-[7px]" : text.length >= 5 ? "text-[8px]" : "text-[10px]";
  // Centre within what is VISIBLE, not within the circle.
  const shift = overlapped ? "pl-3" : "";
  return (
    <span className={`${base} ${fill} ${size} ${shift} font-bold tracking-tight`}>{text}</span>
  );
}

/** Two overlapping token chips representing an LP pair. */
export function PairGlyph({ tokens }: { tokens: [string, string] }) {
  return (
    <div className="flex shrink-0 items-center">
      <TokenChip sym={tokens[0]} variant="primary" className="z-10" />
      <TokenChip sym={tokens[1]} variant="secondary" className="-ml-3" overlapped />
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "green" | "purple" | "red";
}) {
  const valueColor =
    accent === "green" ? "text-green-400"
    : accent === "purple" ? "text-magnet-300"
    : accent === "red" ? "text-red-400"
    : "text-white";
  return (
    <Panel className="p-5">
      <p className="text-xs font-medium uppercase tracking-wider text-gray-500">{label}</p>
      <p className={`mt-2 font-mono text-2xl font-bold ${valueColor}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-gray-500">{sub}</p>}
    </Panel>
  );
}

/** Primary gradient button, used across the v2 surfaces. */
export function PrimaryButton({
  children,
  onClick,
  disabled = false,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full rounded-xl bg-gradient-to-r from-magnet-600 to-magnet-500 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-magnet-900/40 transition-all hover:from-magnet-500 hover:to-magnet-400 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:from-magnet-600 disabled:hover:to-magnet-500 ${className}`}
    >
      {children}
    </button>
  );
}

export function NotLiveNote() {
  return (
    <p className="mt-3 text-center text-xs text-gray-500">
      On-chain actions unlock when the v2 contracts go live on mainnet.
    </p>
  );
}
