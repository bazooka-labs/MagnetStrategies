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
        url: "https://magnetstrategies.io/og-banner.png",
        width: 1902,
        height: 1056,
        alt: "Magnet Strategies",
      },
      {
        url: "https://magnetstrategies.io/og-image.jpg",
        width: 1351,
        height: 1248,
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
    images: ["https://magnetstrategies.io/og-banner.png"],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-surface text-gray-100 antialiased">
        <WalletProvider>
          {children}
          <Toaster position="bottom-right" theme="dark" richColors />
        </WalletProvider>
      </body>
    </html>
  );
}
