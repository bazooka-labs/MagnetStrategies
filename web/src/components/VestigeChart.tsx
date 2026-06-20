export function VestigeChart() {
  return (
    <div className="relative w-full rounded-xl border border-white/10 bg-black/50 backdrop-blur-sm overflow-hidden shadow-xl shadow-black/50">
      <div className="absolute inset-x-0 top-0 h-px z-10 bg-gradient-to-r from-transparent via-magnet-500/60 to-transparent" />
      <iframe
        title="Magnet ($U) / ALGO Chart"
        src="https://vestige.fi/widget/3081853135/chart?noCookie=true&denominatingAssetId=0"
        className="w-full block"
        style={{ height: 440, border: "none" }}
        loading="lazy"
      />
    </div>
  )
}
