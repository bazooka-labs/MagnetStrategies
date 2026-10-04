import type { Metadata } from "next";
import { Toaster } from "sonner";
import { WalletProvider } from "@/hooks/useWallet";
import { AmbientField } from "@/components/AmbientField";
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
