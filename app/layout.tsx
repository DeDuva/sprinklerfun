import type { Metadata } from "next";
import { Geist, Fredoka } from "next/font/google";
import "./globals.css";
import Navbar from "@/components/Navbar";
import { Toaster } from "@/components/ui/sonner";
import StoreProvider from "@/components/StoreProvider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const fredoka = Fredoka({
  variable: "--font-fredoka",
  weight: ["500", "600", "700"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SprinklerFun",
  description: "Flume water meter analyzer",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${fredoka.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-background">
        <StoreProvider>
          <Navbar />
          <main className="flex-1 max-w-6xl mx-auto w-full px-4 py-6">{children}</main>
          <Toaster />
        </StoreProvider>
      </body>
    </html>
  );
}
