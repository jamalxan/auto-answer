import type { Metadata, Viewport } from "next";
import { Unbounded, Inter } from "next/font/google";
import { DomTranslator } from "@/components/dom-translator";
import { LanguageProvider } from "@/components/language-provider";
import { getServerUiLocale } from "@/lib/i18n/get-locale";
import "./globals.css";

// Brand book §09: Unbounded 600 for the logo, headlines and numbers;
// Inter 400–600 for text, interface and buttons.
const unbounded = Unbounded({
  subsets: ["latin", "cyrillic"],
  weight: ["500", "600", "700"],
  variable: "--font-unbounded",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin", "cyrillic"],
  variable: "--font-inter",
  display: "swap",
});

const title = "SocialAuto - Instagram comment-to-DM automation";
const description =
  "Send an Instagram DM automatically when someone comments a keyword on your post or reel, using the official Meta API.";

export const metadata: Metadata = {
  metadataBase: new URL("https://socialauto.uz"),
  title: {
    default: title,
    template: "%s - SocialAuto",
  },
  description,
  keywords: [
    "instagram automation",
    "comment to DM",
    "instagram private replies",
    "social commerce",
    "manychat alternative",
  ],
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "SocialAuto",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    title,
    description,
    url: "/",
    siteName: "SocialAuto",
    images: [{ url: "/og-image-1200x630.png", width: 1200, height: 630 }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: ["/og-image-1200x630.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#0A0B2E",
  width: "device-width",
  initialScale: 1,
  // Installed on iOS the app owns the full screen, notch included; the safe
  // area insets below keep content clear of the system UI.
  viewportFit: "cover",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getServerUiLocale();

  return (
    <html lang={locale} data-scroll-behavior="smooth" className={`h-full ${unbounded.variable} ${inter.variable}`}>
      <body
        // overflow-x-hidden: one wide/unbreakable child (a long localized
        // word, a decorative mockup) is enough to drag the entire page
        // sideways on a phone. Belt and suspenders on top of the specific
        // min-w-0/break-words fixes.
        className="min-h-full overflow-x-hidden bg-background text-foreground font-sans antialiased"
        // Clears the home indicator when installed; 0 everywhere else.
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <LanguageProvider initialLocale={locale}>
          <DomTranslator />
          {children}
        </LanguageProvider>
      </body>
    </html>
  );
}
