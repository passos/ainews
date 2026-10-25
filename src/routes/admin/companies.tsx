import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import {
  createCompany,
  listCompanies,
  toggleCompanyTracking,
  triggerPollCompany,
} from "../../server/admin/companies";

export const Route = createFileRoute("/admin/companies")({
  ssr: "data-only",
  loader: async () => {
    const companies = await listCompanies();
    return { companies };
  },
  component: AdminCompaniesPage,
});

function AdminCompaniesPage() {
  const { companies: initialCompanies } = Route.useLoaderData();
  const [companies, setCompanies] = useState(initialCompanies);
  const [isCreating, setIsCreating] = useState(false);

  // Form states
  const [cik, setCik] = useState("");
  const [ticker, setTicker] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pollingId, setPollingId] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleRefresh() {
    const list = await listCompanies();
    setCompanies(list);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setMsg(null);
    try {
      await createCompany({ data: { cik, ticker, name } });
      setCik("");
      setTicker("");
      setName("");
      setIsCreating(false);
      setMsg("Company added successfully.");
      await handleRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create company");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggle(id: number, currentTracked: number) {
    setError(null);
    try {
      await toggleCompanyTracking({
        data: { companyId: id, tracked: currentTracked === 1 ? 0 : 1 },
      });
      await handleRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update company");
    }
  }

  async function handlePoll(id: number, tickerStr: string) {
    setPollingId(id);
    setError(null);
    setMsg(null);
    try {
      const res = await triggerPollCompany({ data: { companyId: id } });
      setMsg(
        `Polled ${tickerStr}: ${res.ingestedCount} new filing(s) ingested.`,
      );
      await handleRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Poll failed");
    } finally {
      setPollingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Tracked Companies (SEC EDGAR)</h1>
          <p className="text-sm text-muted-foreground">
            Manage SEC tracked tickers, CIK numbers, and automated financial
            report ingestion.
          </p>
        </div>
        <Button onClick={() => setIsCreating(!isCreating)}>
          {isCreating ? "Cancel" : "Add Company"}
        </Button>
      </div>

      {msg && (
        <div className="p-3 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300 rounded border border-emerald-200 dark:border-emerald-800 text-sm">
          {msg}
        </div>
      )}

      {error && (
        <div className="p-3 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300 rounded border border-red-200 dark:border-red-800 text-sm">
          {error}
        </div>
      )}

      {isCreating && (
        <form
          onSubmit={handleCreate}
          className="p-4 border rounded-lg bg-card space-y-4"
        >
          <h2 className="text-lg font-semibold">Track New Company</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="text-sm font-medium">Ticker</label>
              <input
                type="text"
                value={ticker}
                onChange={(e) => setTicker(e.target.value.toUpperCase())}
                placeholder="NVDA"
                required
                className="w-full mt-1 p-2 border rounded bg-background"
              />
            </div>
            <div>
              <label className="text-sm font-medium">
                CIK (10 digits or unpadded)
              </label>
              <input
                type="text"
                value={cik}
                onChange={(e) => setCik(e.target.value)}
                placeholder="0001045810"
                required
                className="w-full mt-1 p-2 border rounded bg-background"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Company Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="NVIDIA CORP"
                required
                className="w-full mt-1 p-2 border rounded bg-background"
              />
            </div>
          </div>
          <Button type="submit" disabled={submitting}>
            {submitting ? "Saving..." : "Save Company"}
          </Button>
        </form>
      )}

      <div className="border rounded-lg overflow-hidden bg-card">
        <table className="w-full text-sm text-left">
          <thead className="bg-muted text-muted-foreground uppercase text-xs font-semibold">
            <tr>
              <th className="px-4 py-3">Ticker</th>
              <th className="px-4 py-3">Company Name</th>
              <th className="px-4 py-3">CIK</th>
              <th className="px-4 py-3">Last Polled</th>
              <th className="px-4 py-3">Tracking</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {companies.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-6 text-center text-muted-foreground"
                >
                  No companies tracked yet. Click "Add Company" above.
                </td>
              </tr>
            ) : (
              companies.map((c) => (
                <tr key={c.id} className="hover:bg-muted/50">
                  <td className="px-4 py-3 font-semibold">{c.ticker}</td>
                  <td className="px-4 py-3">{c.name}</td>
                  <td className="px-4 py-3 font-mono text-xs">{c.cik}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {c.lastPolledAt
                      ? new Date(c.lastPolledAt).toLocaleString()
                      : "Never"}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block px-2 py-0.5 text-xs rounded font-medium ${
                        c.tracked === 1
                          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                          : "bg-neutral-100 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-300"
                      }`}
                    >
                      {c.tracked === 1 ? "Active" : "Paused"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right space-x-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleToggle(c.id, c.tracked)}
                    >
                      {c.tracked === 1 ? "Pause" : "Resume"}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pollingId === c.id}
                      onClick={() => handlePoll(c.id, c.ticker)}
                    >
                      {pollingId === c.id ? "Polling..." : "Poll Now"}
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
