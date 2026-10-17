import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Toaster } from "sonner";
import { WalletProvider } from "@/hooks/useWallet";
import { AmbientField } from "@/components/AmbientField";
import "./globals.css";

/**
 * Self-hosted at build time, not fetched from Google at runtime.
 *
 * globals.css used to pull these with `@import url("fonts.googleapis.com/...")`
 * placed AFTER the @tailwind directives. CSS requires @import to precede every
 * other rule, so the browser discarded it — in the shipped stylesheet it landed
 * 661 rules deep. The result: Inter, Sora and JetBrains Mono never loaded on any
 * platform, and every element fell through to `system-ui`, which is SF Pro on
 * macOS and Segoe UI on Windows. That was the whole Mac/Windows difference —
 * two different typefaces, not one typeface rendered two ways.
 *
 * next/font downloads these at build time and serves them from our own origin,
 * so there is no third-party request, no FOUT, and no silent failure mode if
 * Google is slow or blocked.
 *
 * ── Why Inter carries the display face too ────────────────────────────────
 * The config asked for Sora on headings, but Sora never rendered, so nobody has
 * ever seen this site in it. The look being preserved here is macOS's SF Pro
 * fallback, and Inter is the closest widely available match — it was drawn as a
 * neutral UI grotesque in the same register. Sora is geometric and wide, which
 * is the direction that reads "bubbly" rather than "financial". Switching the
 * display stack back to Sora is a one-line change if that is ever wanted.
 */
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Magnet Strategies",
  description:
    "Exploring the Possibilities & Opportunities within Decentralized Finance",
  openGraph: {
    title: "Magnet Strategies",
    description:
      "Exploring the Possibilities & Opportunities within Decentralized Finance",
    url: "https://magnetstrategies.io",
    siteName: "Magnet Strategies",
    images: [
      {
        url: "https://magnetstrategies.io/og-banner-v2.jpg",
        width: 1200,
        height: 387,
        alt: "Magnet Strategies",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Magnet Strategies",
    description:
      "Exploring the Possibilities & Opportunities within Decentralized Finance",
    images: ["https://magnetstrategies.io/og-banner-v2.jpg"],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`dark ${inter.variable} ${jetbrains.variable}`}>
      <body className="min-h-screen bg-surface text-gray-100 antialiased overflow-x-hidden">
        {/* Behind every route. The landing page keeps its own photographic
            background, which covers this in the hero — deliberately, so the
            two treatments never compete. The other six routes had no ambient
            layer at all before this. */}
        <AmbientField />
        <WalletProvider>
          {children}
          <Toaster position="bottom-right" theme="dark" richColors />
        </WalletProvider>
      </body>
    </html>
  );
}
