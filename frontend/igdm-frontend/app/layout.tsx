import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "IGDM — izohdan direktgacha",
  description:
    "Instagram izohiga yozilgan kalit so'z — avtomatik ochiq javob, so'ng direktga havola. Qoidaga asoslangan, sun'iy intellektsiz.",
};

export const viewport: Viewport = {
  themeColor: "#1a1b72",
  width: "device-width",
  initialScale: 1,
  // zoom is never disabled
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="uz">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
      </head>
      <body>
        <a
          href="#main"
          className="util fixed left-3 top-3 z-[100] px-3 py-2 -translate-y-24 focus:translate-y-0 transition-transform"
          style={{ background: "var(--c-signal)", color: "var(--c-field-deep)" }}
        >
          Asosiy qismga o'tish
        </a>
        {children}
      </body>
    </html>
  );
}
