"use client";

import Image from "next/image";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { useState } from "react";
import { WalletButton } from "@/components/WalletButton";
import { XIcon, DiscordIcon, SOCIALS } from "@/components/SocialIcons";

const navLinks = [
  { href: "/tokens", label: "Tokens", external: false },
  // "Finance", not "Bank": the route is a lending protocol with collateral
  // vaults and a PSM, and "Bank" promised something more custodial than what is
  // actually there. The path stays /magnetfi — the label is the product's name
  // to a visitor, the path is its name to the codebase, and they need not match.
  { href: "/magnetfi", label: "Finance", external: false },
  /**
   * "Trade" is the perps terminal, NOT the Strategy arm.
   *
   * The Strategy arm groups /strategy with the CLMM pools and vaults to come —
   * but an arm is an organising principle and the nav is a shopping surface,
   * and they do not have to match. Nobody scans a nav for "Strategy" wanting a
   * leveraged perps screen, which is why this slot is not called that even
   * though /trade belongs to the same arm as the entry below.
   */
  { href: "/trade", label: "Trade", external: false },
  /**
   * "Strategy" — BACK IN THE NAV, 2026-10-23.
   *
   * ── The history, because it came and went twice ──
   * In from 2026-10-20, out on 2026-10-21: the page could only READ, and its
   * cards linked out to Ultrade's app to deposit. A nav slot pointing at a
   * page that hands the user to someone else's site to finish the job spends
   * the scarcest surface here to advertise an incomplete product.
   *
   * It stayed out after the pools could sign, on a bar written into this
   * comment: it rejoins "when the C-Vault signs here too and the direct pools
   * have real round trips behind them".
   *
   * ── Why that bar is now met ──
   * The C-Vault has a complete signed round trip on MainNet: $7.00 in
   * 2026-10-23 (first-timer, `gu2:` box created, mark preamble ran) and a full
   * single-asset exit the same day across two groups in one prompt (rounds
   * 66273320 and 66273322).
   *
   * The second clause resolved differently than it was written, and worth
   * being exact about rather than waving through: ALGO/USD has a real both-
   * asset round trip, but its all-USDC default has never been signed and
   * BTC/USD has been signed neither way. Those paths did not get signatures —
   * they stopped being PUBLIC. Both direct pool cards now render only for
   * MAGNETFI_ADMIN_ADDRESS behind a toggle that starts closed, so the only
   * thing this nav entry exposes to a visitor is the C-Vault, and that is the
   * path with the round trip. The unsigned paths are reachable only by their
   * author, which was the condition the old comment was reaching for.
   *
   * If the direct pools are ever made public again, this entry is downstream
   * of that decision — check their signature status in
   * strategy/pools/OVERVIEW.md before shipping it.
   */
  { href: "/strategy", label: "Strategy", external: false },
  /**
   * No "Predict" entry: VPL is deprioritised, and a nav slot is the scarcest
   * surface on the site — every item there costs attention the ones beside it
   * could have had.
   *
   * HIDDEN, NOT REMOVED. `/predict` still builds and still serves, and
   * `src/lib/vpl.ts` is untouched, so anyone holding a link keeps working and
   * bringing it back is this line rather than a rebuild. Same treatment Vote
   * got below, for the same reason.
   */
  // No "Vote" entry: UVote is a section of the $U page now. One proposal had
  // ever been opened, and a standing nav slot leading to "check back when the
  // founder opens the first vote" spends attention this bar does not have.
  // /vote redirects into it — see next.config.js.
  { href: "/contact", label: "Contact", external: false },
];

const navLinkClass = "text-sm font-medium text-white/60 hover:text-white transition-colors";

export function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="fixed top-0 left-0 right-0 z-50 overflow-x-hidden">
      {/* Layered background: dark gradient + blur */}
      <div className="absolute inset-0 bg-gradient-to-b from-[#0a0010]/80 via-[#0d0018]/70 to-black/50 backdrop-blur-md" />

      {/* Bottom glow line */}
      <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-magnet-500/60 to-transparent" />

      <div className="relative mx-auto max-w-7xl px-3 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 shrink-0 min-w-0">
          <Link
            href="/"
            aria-label="Magnet Strategies home"
            className="flex h-12 w-12 items-center justify-center rounded-lg bg-gradient-to-br from-magnet-500 to-magnet-700 shrink-0 hover:opacity-85 transition-opacity"
          >
            <Image
              src="/magnet-icon.png"
              alt=""
              width={64}
              height={64}
              className="w-16 h-16 shrink-0 object-contain"
            />
          </Link>
          <Image
            src="/magnet-wordmark.png"
            alt="Magnet Strategies"
            width={140}
            height={46}
            className="w-[96px] sm:w-[132px] h-auto shrink-0"
            priority
          />
        </div>

        {/* Desktop nav */}
        {/*
          ── Collapses at `lg`, not `md` ──
          Raised 2026-10-23, when Strategy made five links. At 768px (the md
          breakpoint, where this row first appeared) five links plus the social
          icons pushed the Connect Wallet button off the right edge — the
          header is `overflow-x-hidden`, so it clipped silently rather than
          scrolling, and the primary CTA was the thing lost. Four links fitted;
          five did not. Verified by rendering at 768 both ways, which is the
          only way this was ever going to be noticed.

          Tablets now get the hamburger, which holds every link at any count.
          A future sixth item needs no change here.
        */}
        <div className="hidden lg:flex items-center gap-6">
          {navLinks.map((link) =>
            link.external ? (
              <a
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className={navLinkClass}
              >
                {link.label}
              </a>
            ) : (
              <Link key={link.href} href={link.href} className={navLinkClass}>
                {link.label}
              </Link>
            )
          )}
        </div>

        {/* Right: socials + wallet */}
        <div className="flex items-center gap-2 sm:gap-4 shrink-0">
          <div className="hidden sm:flex items-center gap-4">
            <a
              href={SOCIALS.x}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="X / Twitter"
              className="text-white/50 hover:text-white transition-colors"
            >
              <XIcon />
            </a>
            <a
              href={SOCIALS.discord}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Discord"
              className="text-white/50 hover:text-white transition-colors"
            >
              <DiscordIcon />
            </a>
            <div className="w-px h-4 bg-white/20" />
          </div>

          <WalletButton />

          {/* Mobile toggle.
              `aria-label` and `aria-expanded` added 2026-10-23: its only
              content is an icon, so without a label a screen reader announced
              an unnamed button, and nothing conveyed whether the sheet was
              open. Found while testing the nav — the test could not locate the
              control by name, which is exactly the problem a user of assistive
              technology would have had. */}
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileOpen}
            aria-controls="mobile-nav"
            className="lg:hidden rounded-lg p-2 text-white/60 hover:text-white hover:bg-white/5"
          >
            {mobileOpen ? <X className="h-5 w-5" aria-hidden="true" /> : <Menu className="h-5 w-5" aria-hidden="true" />}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {mobileOpen && (
        <div id="mobile-nav" className="relative lg:hidden border-t border-white/10 bg-[#0a0010]/95 backdrop-blur-md px-4 py-4 space-y-1">
          {navLinks.map((link) =>
            link.external ? (
              <a
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setMobileOpen(false)}
                className="block py-2 text-sm font-medium text-white/60 hover:text-white"
              >
                {link.label}
              </a>
            ) : (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMobileOpen(false)}
                className="block py-2 text-sm font-medium text-white/60 hover:text-white"
              >
                {link.label}
              </Link>
            )
          )}
          <div className="flex items-center gap-4 pt-3">
            <a
              href={SOCIALS.x}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="X / Twitter"
              className="text-white/50 hover:text-white transition-colors"
            >
              <XIcon />
            </a>
            <a
              href={SOCIALS.discord}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Discord"
              className="text-white/50 hover:text-white transition-colors"
            >
              <DiscordIcon />
            </a>
          </div>
        </div>
      )}
    </header>
  );
}
