import Image from "next/image";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";

/** Each stage fills the hero box and centres itself inside it.
 *
 * Centring with flex rather than `left-1/2 … -translate-x-1/2`: the stage
 * keyframes animate `transform`, and a transform in a keyframe REPLACES the
 * element's own translate utilities outright. Centring the parent instead
 * leaves `transform` free for the animation to use. The old logo got away with
 * the translate trick only because `logo-fade-out` animates opacity alone.
 */
const STAGE_BOX =
  "pointer-events-none absolute inset-0 flex items-center justify-center";

export default function LandingPage() {
  return (
    <div className="relative min-h-screen flex flex-col">
      <Navbar />

      <div className="relative flex-1 flex flex-col items-center justify-center overflow-hidden">
        {/* Full-bleed background */}
        <div className="absolute inset-0">
          <Image
            src="/magnet-bg.png"
            fill
            alt=""
            className="object-cover object-center"
            priority
          />
        </div>

        {/* Ambient drifting gradient blobs */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="animate-blob-drift absolute top-1/4 -left-24 w-[28rem] h-[28rem] rounded-full bg-magnet-600/20 blur-[100px]" />
          <div className="animate-blob-drift-slow absolute bottom-0 -right-24 w-[26rem] h-[26rem] rounded-full bg-magnet-400/15 blur-[100px]" />
        </div>

        {/* Content */}
        <div className="relative mx-auto max-w-5xl px-6 py-32 flex flex-col items-center text-center">

          {/* Hero intro sequence — the mark, then the Magnet Strategies
              banner. Nothing between them: the three "Attract …" lines were
              removed, and the full timeline lives in globals.css next to the
              keyframes, because the delays are what sequence it.

              The box is now given an explicit height rather than being
              reserved by an invisible line of text. That sizer existed to make
              the box track the TYPE scale, which mattered only while stages
              were words; with two images left, a height that matches the taller
              of them says what it means and does not keep a removed sentence
              alive in the DOM. Both stages stay absolutely positioned inside
              it, so neither can shift the other. */}
          <div className="relative mb-8 h-40 w-full sm:h-56 lg:h-72">
            {/* Stage 0 — the Magnet mark. Unchanged animation. */}
            <div className={STAGE_BOX}>
              <Image
                src="/magnet-icon.png"
                alt=""
                width={500}
                height={500}
                className="magnet-glow-soft w-40 sm:w-56 lg:w-72 h-auto shrink-0 animate-logo-fade-out"
                priority
              />
            </div>

            {/* Stage 1 — the Magnet Strategies banner, which stays.
                It is the H1. "Attract Liquidity" used to be, and removing it
                would have left the landing page with no heading at all; the
                banner is the one branded thing on screen once the sequence
                settles, and its alt text is the page's name. */}
            <h1 className={STAGE_BOX}>
              <Image
                src="/magnet-wordmark.png"
                alt="Magnet Strategies"
                width={877}
                height={284}
                className="magnet-glow-soft w-[17rem] sm:w-[26rem] lg:w-[34rem] h-auto shrink-0 animate-stage-final"
                priority
              />
            </h1>
          </div>

          <div className="w-32 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent mb-8 animate-hero-outro-1" />

          {/* Tagline */}
          <p className="font-display max-w-2xl text-xl sm:text-2xl font-semibold text-white leading-relaxed mb-5 animate-hero-outro-2">
            Exploring the Possibilities &amp; Opportunities within Decentralized Finance
          </p>


        </div>
      </div>

      <Footer />
    </div>
  );
}
