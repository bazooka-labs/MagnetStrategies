import { PerpsView } from "@/components/strategy/perps/PerpsView";
import { TradeSplash } from "@/components/strategy/TradeSplash";

export default function TradePage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      {/*
        A sibling of the content, never a parent: the splash blurs the live page
        behind it, and an ancestor with a running opacity animation would become
        a backdrop root and leave it blurring nothing.
      */}
      <TradeSplash />
      {/*
        The single-pill toggle is gone.
        ──────────────────────────────────────────────────────────────────────
        StrategyView carried a segmented control with ONE segment - a tab group that
        could not switch to anything. Honest while this page was the Strategy arm
        holding one product, and stops being honest now the page IS the product.
        When Advanced Trading lands the control comes back with two real
        segments, in the shape /magnetfi now uses.
      */}
      <PerpsView />
    </div>
  );
}
