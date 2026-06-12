import { Magnet } from "lucide-react";

export function Footer() {
  return (
    <footer className="border-t border-gray-800/60 bg-surface">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="flex flex-col items-center justify-between gap-6 sm:flex-row">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded bg-gradient-to-br from-magnet-500 to-magnet-700">
              <Magnet className="h-3.5 w-3.5 text-white" />
            </div>
            <span className="text-sm font-semibold text-gray-400">
              Magnet Strategies
            </span>
          </div>

          <div className="flex items-center gap-6 text-xs text-gray-500">
            <a
              href="https://x.com/Bazooka_Labs"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-gray-300 transition-colors"
            >
              X
            </a>
            <a
              href="https://discord.gg/naqFXmfM"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-gray-300 transition-colors"
            >
              Discord
            </a>
            <a
              href="https://algoexplorer.io/asset/3081853135"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-gray-300 transition-colors"
            >
              AlgoExplorer
            </a>
          </div>

          <p className="text-xs text-gray-600">
            Built by Bazooka Labs
          </p>
        </div>
      </div>
    </footer>
  );
}
