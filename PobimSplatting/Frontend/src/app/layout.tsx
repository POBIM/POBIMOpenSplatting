import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Navbar from "@/components/Navbar";

const inter = Inter({
  subsets: ["latin"],
  display: 'swap',
  preload: true,
});

export const metadata: Metadata = {
  title: "PobimSplatting - 3D Gaussian Splatting",
  description: "Advanced 3D reconstruction with OpenSplat",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.className} bg-white antialiased min-h-screen flex flex-col`}>
        <Navbar />
        <main className="flex-1 min-h-0 bg-white overflow-hidden">
          {children}
        </main>
      </body>
    </html>
  );
}
