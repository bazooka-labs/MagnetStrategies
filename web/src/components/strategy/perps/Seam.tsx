// The rule between sections of the single Perps card.
//
// Shared rather than copied because the whole point of one card is that the
// joins look identical; three hand-written hairlines drift apart the first time
// one of them gets adjusted.
//
// Full-bleed by design: the wrapping Panel carries no padding of its own — each
// section supplies its own — so the rule can run edge to edge. It is tinted
// like the Panel's own top hairline so a seam reads as an internal division
// rather than the boundary between two stacked panels.
//
// Each section draws the seam ABOVE itself, so a section that renders nothing
// takes its seam with it. Positions do exactly that with no wallet connected,
// and a rule under nothing is a card that looks broken.
export function Seam() {
  return <div className="h-px bg-gradient-to-r from-transparent via-magnet-500/30 to-transparent" />;
}
