import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://games.hendragunawan.com"),
  title: "game-ranker — best PC & PlayStation games 2015→today",
  description:
    "An interactive, algorithmically-ranked leaderboard of the best PC and PlayStation games. Filter by year and platform; scores merged with a transparent Bayesian model.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-[#010409] text-[#e6edf3]">{children}</body>
    </html>
  );
}
