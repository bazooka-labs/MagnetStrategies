import type { ReactNode } from "react";

/**
 * The hero header for a Bank tab.
 *
 * Lifted from the token pages so the two products read as one site: same frame,
 * same hairline, same drifting blob, same glowing display title. Shared as a
 * component rather than copied twice, because the previous version of this —
 * two hand-built header rows with different icon sizes, title weights and
 * description colours — is exactly what made the Bank page look unfinished
 * beside /tokens.
 *
 * No icon tile: the glowing display title already carries the section, and a
 * 56px badge beside it was competing with the thing it was meant to introduce.
 */
export function SectionHero({
  title,
  description,
  children,
}: {
  title: string;
  description: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="relative mb-6 overflow-hidden rounded-2xl border border-white/10 bg-black/40 px-6 py-7 backdrop-blur-sm sm:px-8">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-magnet-500/60 to-transparent" />
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="animate-blob-drift absolute -right-16 -top-16 h-56 w-56 rounded-full bg-magnet-600/20 blur-3xl" />
      </div>

      <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display magnet-glow-soft text-2xl font-bold text-white sm:text-3xl">
            {title}
          </h1>
          <p className="mt-1 max-w-xl text-sm leading-relaxed text-gray-300">{description}</p>
        </div>
        {/* Actions sit in the header bar rather than floating above it, so the
            title and the things you can do with it are one object. */}
        {children && <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>}
      </div>
    </div>
  );
}
