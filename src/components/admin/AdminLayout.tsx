import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ThemeSwitcher } from "../ThemeSwitcher";

const NAV_ITEMS = [
  { to: "/admin", label: "Overview" },
  { to: "/admin/review", label: "Review" },
  { to: "/admin/published", label: "Published" },
  { to: "/admin/digests", label: "Digests" },
  { to: "/admin/artifacts", label: "Artifacts" },
  { to: "/admin/evidence", label: "Evidence" },
  { to: "/admin/ask", label: "Ask" },
  { to: "/admin/watches", label: "Watches" },
  { to: "/admin/companies", label: "Companies" },
  { to: "/admin/industries", label: "Sections" },
  { to: "/admin/sources", label: "Sources" },
  { to: "/admin/ledger", label: "Ledger & Budget" },
  { to: "/admin/dlq", label: "DLQ" },
] as const;

/**
 * Two rows: brand + identity, then the nav on its own row. The nav scrolls
 * sideways and never wraps.
 */
export function AdminLayoutView({
  email,
  children,
}: {
  email: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6 py-4">
      <header className="flex flex-col gap-3 border-b pb-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <Link
            to="/admin"
            className="font-serif text-2xl font-bold tracking-tight"
          >
            Daily Admin
          </Link>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
            <span className="flex items-center gap-2 rounded-md border bg-muted px-2.5 py-1 font-mono">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-500"></span>
              <span>{email}</span>
            </span>
            <a href="/" className="hover:underline">
              View site ↗
            </a>
            <ThemeSwitcher />
          </div>
        </div>
        <nav className="flex items-center gap-4 overflow-x-auto whitespace-nowrap pb-1 text-sm font-medium text-muted-foreground">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: item.to === "/admin" }}
              activeProps={{ className: "text-foreground font-semibold" }}
              className="hover:text-foreground"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="min-h-[60vh]">{children}</main>
    </div>
  );
}
