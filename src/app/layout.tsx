import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "StoreIQ Simple Virtual Shield",
  description: "Post-scan RFID zone cleaning. Scan normally. Clean virtually. Trust your inventory.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
