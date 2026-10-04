import Image from "next/image";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";

/** Shared type treatment for every text stage, so they are visually identical. */
const STAGE_TEXT =
  "glow-text font-display text-6xl sm:text-7xl lg:text-8xl font-extrabold tracking-tight text-white";

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

          {/* Hero intro sequence — logo → Yield → Liquidity → Leverage →
              banner. The full timeline lives in globals.css next to the
              keyframes, because the delays are what sequence it.

              Every stage is absolutely positioned, so no stage's size can
              affect this wrapper's box and nothing shifts as they swap. The
              box is instead sized by the invisible sizer below, which carries
              the longest line — stages can then be scaled freely, exactly as
              the logo could before. */}
          <div className="relative mb-8">
            {/* Sizer: reserves the box, shows nothing, announces nothing.
                It has to be a real text node rather than a fixed height so the
                box keeps tracking the responsive type scale. */}
            <div
              aria-hidden="true"
              className={`${STAGE_TEXT} select-none opacity-0`}
            >
              Attract Liquidity
            </div>

            {/* Stage 0 — the Magnet mark. Unchanged animation. */}
            <div className={STAGE_BOX}>
              <Image
                src="/magnet-icon.png"
                alt=""
                width={320}
                height={320}
                className="magnet-glow-soft w-40 sm:w-56 lg:w-72 h-auto shrink-0 animate-logo-fade-out"
                priority
              />
            </div>

            {/* Stage 1 */}
            <div className={STAGE_BOX}>
              <span
                aria-hidden="true"
                className={`${STAGE_TEXT} whitespace-nowrap animate-stage-1`}
              >
                Attract Yield
              </span>
            </div>

            {/* Stage 2 — the real heading. One h1 on the page: the other
                stages are decorative repetitions of the same idea, so they are
                spans and hidden from assistive tech rather than competing
                headings. */}
            <div className={STAGE_BOX}>
              <h1 className={`${STAGE_TEXT} whitespace-nowrap animate-stage-2`}>
                Attract Liquidity
              </h1>
            </div>

            {/* Stage 3 */}
            <div className={STAGE_BOX}>
              <span
                aria-hidden="true"
                className={`${STAGE_TEXT} whitespace-nowrap animate-stage-3`}
              >
                Attract Leverage
              </span>
            </div>

            {/* Stage 4 — the Magnet Strategies banner, which stays. Carries
                the alt text the mark used to, since this is the one branded
                image left on screen once the sequence settles. */}
            <div className={STAGE_BOX}>
              <Image
                src="/magnet-wordmark.png"
                alt="Magnet Strategies"
                width={877}
                height={284}
                className="magnet-glow-soft w-[17rem] sm:w-[26rem] lg:w-[34rem] h-auto shrink-0 animate-stage-final"
                priority
              />
            </div>
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
