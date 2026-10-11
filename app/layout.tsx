import type { Metadata, Viewport } from "next";
import { Unbounded, Manrope, JetBrains_Mono } from "next/font/google";
import { LanguageProvider } from "@/components/language-provider";
import { getServerLocale } from "@/lib/i18n/get-locale";
import "./globals.css";

const unbounded = Unbounded({
  subsets: ["latin"],
  weight: ["800", "900"],
  variable: "--font-unbounded",
});

const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-manrope",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
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
    images: [{ url: "/icon-512.png", width: 512, height: 512 }],
    type: "website",
  },
  twitter: {
    card: "summary",
    title,
    description,
    images: ["/icon-512.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0b2e",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getServerLocale();

  return (
    <html
      lang={locale}
      className={`h-full ${unbounded.variable} ${manrope.variable} ${jetbrainsMono.variable}`}
    >
      <body
        className="min-h-full overflow-x-hidden bg-background text-foreground font-sans antialiased"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <LanguageProvider initialLocale={locale}>{children}</LanguageProvider>
      </body>
    </html>
  );
}
