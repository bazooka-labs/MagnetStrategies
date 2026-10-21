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
   * "Trade", not "Strategy".
   *
   * The Strategy ARM still exists and still groups this with the CLMM pools and
   * vaults to come — but an arm is an organising principle and the nav is a
   * shopping surface, and they do not have to match. Nobody scans a nav for
   * "Strategy" wanting a leveraged perps screen. Strategy rejoins the nav when
   * it has something to show.
   */
  { href: "/trade", label: "Trade", external: false },
  /**
   * No "Strategy" entry — HIDDEN, NOT REMOVED, like Predict below.
   *
   * `/strategy` still builds and still serves, so a link keeps working and
   * bringing it back is this line rather than a rebuild. It was in the nav
   * from 2026-10-20 until 2026-10-21.
   *
   * Why it came out: the page can only READ. Its three cards link out to
   * Ultrade's app to actually deposit, and the product this is meant to be
   * signs the deposit on our own UI. A nav slot pointing at a page that hands
   * the user to someone else's site to finish the job is worse than no slot —
   * it spends the scarcest surface on the site to advertise an incomplete
   * product. It returns when the deposit groups are built and asserted here.
   *
   * See web/STRATEGY_SPEC.md §7: v1 was deliberately read-only, which was the
   * wrong call for what this is for.
   */
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
        <div className="hidden md:flex items-center gap-6">
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

          {/* Mobile toggle */}
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="md:hidden rounded-lg p-2 text-white/60 hover:text-white hover:bg-white/5"
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {mobileOpen && (
        <div className="relative md:hidden border-t border-white/10 bg-[#0a0010]/95 backdrop-blur-md px-4 py-4 space-y-1">
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
