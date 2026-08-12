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
    title: "MagnetDAO | Magnet Strategies",
    description:
      "Exploring the Possibilities & Opportunities within Decentralized Finance",
    images: ["https://magnetstrategies.io/og-banner-v2.jpg"],
  },
};

export default function DaoLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Navbar />
      <main className="min-h-[calc(100vh-160px)] pt-16">{children}</main>
      <Footer />
    </>
  );
}
