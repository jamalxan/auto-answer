import Link from "next/link";

interface PublicSiteHeaderProps {
  active?: "home" | "templates";
}

const navLinks = [
  { label: "Templates", href: "/templates", key: "templates" },
  { label: "Agencies", href: "/instagram-dm-automation-agencies", key: "agencies" },
];

export default function PublicSiteHeader({ active }: PublicSiteHeaderProps) {
  return (
    <header className="sticky top-0 z-40 border-b-2 border-border bg-background/95">
      <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-5 sm:px-6 lg:px-8">
        <Link href="/" className="flex items-center gap-3" aria-label="SocialAuto home">
          <span className="font-display text-lg font-extrabold text-foreground">
            SocialAuto
          </span>
        </Link>

        <nav className="hidden items-center gap-7 md:flex">
          {navLinks.map((link) => (
            <Link
              key={link.key}
              href={link.href}
              className={`label-mono text-xs transition ${
                active === link.key
                  ? "text-accent"
                  : "text-muted hover:text-foreground"
              }`}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <Link
            href="/login"
            className="label-mono hidden px-4 py-2 text-xs font-semibold text-muted transition hover:text-foreground sm:inline-flex"
          >
            Sign in
          </Link>
          <Link
            href="/login"
            className="label-mono inline-flex items-center justify-center rounded bg-accent px-4 py-2 text-xs font-bold text-background transition hover:bg-accent-hover"
          >
            Start free
          </Link>
        </div>
      </div>
    </header>
  );
}
