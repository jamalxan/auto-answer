import type { Metadata } from "next";

// Nothing under /developer is ever indexed or linked from the product.
export const metadata: Metadata = {
  title: { default: "Developer", template: "%s · SocialAuto Developer" },
  robots: { index: false, follow: false },
};

export default function DeveloperRootLayout({ children }: { children: React.ReactNode }) {
  return children;
}
