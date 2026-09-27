import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Sky Holding · Content studio",
  robots: { index: false, follow: false, noarchive: true },
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
