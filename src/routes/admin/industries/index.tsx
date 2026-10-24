import { createFileRoute, Link } from "@tanstack/react-router";
import { listIndustries } from "../../../server/admin/industries";

export const Route = createFileRoute("/admin/industries/")({
  ssr: "data-only",
  loader: () => listIndustries(),
  component: AdminIndustriesPage,
});

function AdminIndustriesPage() {
  const industries = Route.useLoaderData();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Sections</h1>
        <p className="text-sm text-muted-foreground">
          Manage publication sections, thresholds, whitelists, and review modes.
        </p>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-muted/50 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3">ID</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Slug</th>
              <th className="px-4 py-3">Publish Mode</th>
              <th className="px-4 py-3">Config Version</th>
              <th className="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {industries.map((ind) => (
              <tr key={ind.id} className="hover:bg-muted/30">
                <td className="px-4 py-3 font-mono text-xs">{ind.id}</td>
                <td className="px-4 py-3 font-semibold">{ind.name}</td>
                <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                  {ind.slug}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-block rounded px-2 py-0.5 text-xs font-semibold ${
                      ind.publishMode === "auto"
                        ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                        : "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                    }`}
                  >
                    {ind.publishMode}
                  </span>
                </td>
                <td className="px-4 py-3 font-mono text-xs">
                  v{ind.configVersion}
                </td>
                <td className="px-4 py-3 text-right">
                  <Link
                    to="/admin/industries/$industryId"
                    params={{ industryId: String(ind.id) }}
                    className="font-medium text-primary hover:underline"
                  >
                    Edit &rarr;
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
