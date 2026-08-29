import type { Metadata } from "next";
import { Toaster } from "sonner";
import { WalletProvider } from "@/hooks/useWallet";
import "./globals.css";

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
    <html lang="en" className="dark">
      <body className="min-h-screen bg-surface text-gray-100 antialiased overflow-x-hidden">
        {/* Fixed branded backdrop — the whole UI scrolls over the splash art at full
            brightness. Solid (bg-surface-light) panels sit on top of it. */}
        <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 bg-[url('/magnet-bg.png')] bg-cover bg-center" />
        <WalletProvider>
          {children}
          <Toaster position="bottom-right" theme="dark" richColors />
        </WalletProvider>
      </body>
    </html>
  );
}
