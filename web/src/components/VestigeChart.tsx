export function VestigeChart({
  assetId,
  denominatingAssetId,
  title,
}: {
  assetId: number;
  denominatingAssetId: number;
  title: string;
}) {
  return (
    <iframe
      title={title}
      src={`https://vestige.fi/widget/${assetId}/chart?noCookie=true&denominatingAssetId=${denominatingAssetId}`}
      className="w-full block"
      style={{ height: 440, border: "none" }}
      loading="lazy"
    />
  )
}
