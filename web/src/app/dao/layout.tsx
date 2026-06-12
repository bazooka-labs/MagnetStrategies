import type { Metadata } from "next";
import { Navbar } from "@/components/Navbar";
import { Footer } from "@/components/Footer";

export const metadata: Metadata = {
  title: "MagnetDAO | Magnet Strategies",
  description:
    "Exploring the Possibilities & Opportunities within Decentralized Finance",
  openGraph: {
    title: "MagnetDAO | Magnet Strategies",
    description:
      "Exploring the Possibilities & Opportunities within Decentralized Finance",
    url: "https://magnetstrategies.io/dao",
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
    title: "MagnetDAO | Magnet Strategies",
    description:
      "Exploring the Possibilities & Opportunities within Decentralized Finance",
    images: ["https://magnetstrategies.io/og-banner.png"],
  },
};

export default function DaoLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Navbar />
      <main className="min-h-[calc(100vh-160px)]">{children}</main>
      <Footer />
    </>
  );
}
