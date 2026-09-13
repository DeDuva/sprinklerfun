import type { Metadata } from "next";
import { Geist, Fredoka } from "next/font/google";
import "./globals.css";
import Navbar from "@/components/Navbar";
import { Toaster } from "@/components/ui/sonner";
import StoreProvider from "@/components/StoreProvider";
import { cookies } from "next/headers";
import { COOKIE, sessionEmail } from "@/lib/server/session";

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

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Reading the cookie is what makes this layout render per request, and that is
  // the point rather than a side effect. Asking the session module alone left
  // the answer baked in at BUILD time — when no credentials are set — so the
  // deployed app showed a signed-in user no way to sign out. The E2E suite
  // caught it; nothing about the source would have.
  const jar = await cookies();
  const signedIn = Boolean(sessionEmail(jar.get(COOKIE)?.value));

  return (
    <html lang="en" className={`${geistSans.variable} ${fredoka.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-background">
        <StoreProvider>
          <Navbar showLogout={signedIn} />
          <main className="flex-1 max-w-6xl mx-auto w-full px-4 py-6">{children}</main>
          <Toaster />
        </StoreProvider>
      </body>
    </html>
  );
}
