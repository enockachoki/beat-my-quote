import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";
import { currentUser } from "@/server/auth";
import { HOME_FOR_ROLE } from "@/server/http/pageAuth";
import { SignOutButton } from "@/components/SignOutButton";

export const metadata: Metadata = {
  title: { default: "Beat My Quote", template: "%s | Beat My Quote" },
  description: "Upload the quote you already have. Vetted local builders beat it.",
  robots: { index: false, follow: false }, // test phase
};
// Every page depends on the signed-in user, so nothing is statically prerendered.
export const dynamic = "force-dynamic";

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

async function Nav() {
  let cu: Awaited<ReturnType<typeof currentUser>> = { state: "none" };
  try {
    cu = await currentUser();
  } catch {
    // Database unavailable: render the public header rather than failing the page.
  }
  if (cu.state !== "active") {
    return (
      <nav className="nav" aria-label="Main">
        <Link href="/#how-it-works">How it works</Link>
        <Link href="/sign-in">Sign in</Link>
        <Link className="btn btn-primary" href="/sign-up">Upload my quote</Link>
      </nav>
    );
  }
  const role = cu.user.role;
  return (
    <nav className="nav" aria-label="Main">
      <Link href={HOME_FOR_ROLE[role]}>{role === "admin" ? "Review queue" : role === "builder" ? "Jobs" : "My jobs"}</Link>
      {role === "homeowner" ? <Link href="/homeowner/jobs/new">New quote</Link> : null}
      {role === "admin" ? <><Link href="/admin/builders">Builders</Link><Link href="/admin/audit">Audit log</Link></> : null}
      <SignOutButton />
    </nav>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body>
        <a className="skip-link" href="#main">Skip to content</a>
        <div className="draft-banner">Test phase. Legal wording is a draft for solicitor review.</div>
        <header className="site-header">
          <div className="inner">
            <Link href="/" className="brand"><span>BEAT MY</span> QUOTE</Link>
            <Nav />
          </div>
        </header>
        <main id="main" className="inner">{children}</main>
        <footer className="site-footer">
          <div className="inner row between">
            <span>Prices include VAT. England and Wales.</span>
            <span className="row"><Link href="/terms">Terms (draft)</Link><Link href="/privacy">Privacy (draft)</Link></span>
          </div>
        </footer>
      </body>
    </html>
  );
}
