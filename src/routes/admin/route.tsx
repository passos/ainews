import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { getAdminIdentity } from "../../server/admin/identity";

export const Route = createFileRoute("/admin")({
  ssr: "data-only",
  loader: () => getAdminIdentity(),
  component: AdminLayout,
});

function AdminLayout() {
  const { email } = Route.useLoaderData();

  return (
    <div className="flex flex-col gap-6 py-4">
      <header className="flex flex-wrap items-center justify-between border-b pb-4 gap-4">
        <div className="flex items-center gap-6">
          <Link
            to="/admin"
            className="font-serif text-2xl font-bold tracking-tight"
          >
            Newsren Admin
          </Link>
          <nav className="flex flex-wrap items-center gap-4 text-sm font-medium text-muted-foreground">
            <Link
              to="/admin"
              activeProps={{ className: "text-foreground font-semibold" }}
              className="hover:text-foreground"
            >
              Overview
            </Link>
            <Link
              to="/admin/review"
              activeProps={{ className: "text-foreground font-semibold" }}
              className="hover:text-foreground"
            >
              Review Queue
            </Link>
            <Link
              to="/admin/digests"
              activeProps={{ className: "text-foreground font-semibold" }}
              className="hover:text-foreground"
            >
              Digests
            </Link>
            <Link
              to="/admin/industries"
              activeProps={{ className: "text-foreground font-semibold" }}
              className="hover:text-foreground"
            >
              Sections
            </Link>
            <Link
              to="/admin/sources"
              activeProps={{ className: "text-foreground font-semibold" }}
              className="hover:text-foreground"
            >
              Sources
            </Link>
            <Link
              to="/admin/ledger"
              activeProps={{ className: "text-foreground font-semibold" }}
              className="hover:text-foreground"
            >
              Ledger & Budget
            </Link>
            <Link
              to="/admin/dlq"
              activeProps={{ className: "text-foreground font-semibold" }}
              className="hover:text-foreground"
            >
              DLQ
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-2 text-xs font-mono bg-muted px-2.5 py-1 rounded-md border">
          <span className="inline-block w-2 h-2 rounded-full bg-emerald-500"></span>
          <span>{email}</span>
        </div>
      </header>
      <main className="min-h-[60vh]">
        <Outlet />
      </main>
    </div>
  );
}
