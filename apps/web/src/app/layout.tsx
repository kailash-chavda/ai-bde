import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI BDE",
  description: "HITL outreach dashboard for AI Business Development Executive",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <a className="brand" href="/">
            AI BDE
          </a>
          <nav>
            <a href="/">HITL Queue</a>
            <a href="/leads">Leads</a>
            <a href="/case-studies">Case Studies</a>
          </nav>
        </header>
        <main className="shell">{children}</main>
      </body>
    </html>
  );
}
