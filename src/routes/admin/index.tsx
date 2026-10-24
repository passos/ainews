import { createFileRoute, Link } from "@tanstack/react-router";
import { listDlqMessages } from "../../server/admin/dlq";
import { getBudgetSummary } from "../../server/admin/ledger";
import {
  listPendingArticles,
  listStuckArticles,
} from "../../server/admin/review";

export const Route = createFileRoute("/admin/")({
  ssr: "data-only",
  loader: async () => {
    const [pending, stuck, budget, dlq] = await Promise.all([
      listPendingArticles(),
      listStuckArticles(),
      getBudgetSummary(),
      listDlqMessages(),
    ]);
    return { pending, stuck, budget, dlq };
  },
  component: AdminDashboard,
});

function AdminDashboard() {
  const { pending, stuck, budget, dlq } = Route.useLoaderData();

  const totalSpent = budget.budgets.reduce(
    (sum: number, b) => sum + (b.spentMicros ?? 0),
    0,
  );
  const totalCap = Object.values(budget.caps as Record<string, number>).reduce(
    (sum: number, c: number) => sum + (c || 0),
    0,
  );

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-xl font-bold tracking-tight">System Status</h1>
        <p className="text-sm text-muted-foreground">
          Overview of pending editorial reviews, processing status, and budget.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Link
          to="/admin/review"
          className="flex flex-col justify-between rounded-lg border bg-card p-4 transition-colors hover:border-foreground/50"
        >
          <span className="text-xs font-mono uppercase text-muted-foreground">
            Pending Review
          </span>
          <span className="mt-2 text-3xl font-extrabold">{pending.length}</span>
          <span className="mt-1 text-xs text-muted-foreground">
            Articles awaiting approval
          </span>
        </Link>

        <Link
          to="/admin/review"
          className="flex flex-col justify-between rounded-lg border bg-card p-4 transition-colors hover:border-foreground/50"
        >
          <span className="text-xs font-mono uppercase text-muted-foreground">
            Stuck Articles
          </span>
          <span className="mt-2 text-3xl font-extrabold text-amber-500">
            {stuck.length}
          </span>
          <span className="mt-1 text-xs text-muted-foreground">
            Requeue count &ge; 3
          </span>
        </Link>

        <Link
          to="/admin/dlq"
          className="flex flex-col justify-between rounded-lg border bg-card p-4 transition-colors hover:border-foreground/50"
        >
          <span className="text-xs font-mono uppercase text-muted-foreground">
            DLQ Messages
          </span>
          <span className="mt-2 text-3xl font-extrabold text-destructive">
            {dlq.length}
          </span>
          <span className="mt-1 text-xs text-muted-foreground">
            Dead-letter failures
          </span>
        </Link>

        <Link
          to="/admin/ledger"
          className="flex flex-col justify-between rounded-lg border bg-card p-4 transition-colors hover:border-foreground/50"
        >
          <span className="text-xs font-mono uppercase text-muted-foreground">
            Today's LLM Spend
          </span>
          <span className="mt-2 text-3xl font-extrabold">
            ${(totalSpent / 1_000_000).toFixed(4)}
          </span>
          <span className="mt-1 text-xs text-muted-foreground">
            Cap: ${(totalCap / 1_000_000).toFixed(2)}
          </span>
        </Link>
      </div>

      <div className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Quick Actions</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Link
            to="/admin/review"
            className="rounded-md border p-3 text-sm hover:bg-muted"
          >
            &rarr; Review pending articles
          </Link>
          <Link
            to="/admin/industries"
            className="rounded-md border p-3 text-sm hover:bg-muted"
          >
            &rarr; Manage section configs
          </Link>
          <Link
            to="/admin/sources"
            className="rounded-md border p-3 text-sm hover:bg-muted"
          >
            &rarr; Manage sources and crawl health
          </Link>
        </div>
      </div>
    </div>
  );
}
