import { useState } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
  createIndustry,
  draftIndustryConfig,
  listIndustries,
  type DraftIndustryResult,
} from "../../../server/admin/industries";

export const Route = createFileRoute("/admin/industries/")({
  ssr: "data-only",
  loader: () => listIndustries(),
  component: AdminIndustriesPage,
});

function AdminIndustriesPage() {
  const industries = Route.useLoaderData();
  const router = useRouter();

  const [isDrafting, setIsDrafting] = useState(false);
  const [description, setDescription] = useState("");
  const [suggestedName, setSuggestedName] = useState("");
  const [loadingDraft, setLoadingDraft] = useState(false);
  const [draftResult, setDraftResult] = useState<DraftIndustryResult | null>(
    null,
  );

  // Form edit fields
  const [formName, setFormName] = useState("");
  const [formSlug, setFormSlug] = useState("");
  const [formPublishMode, setFormPublishMode] = useState<"auto" | "review">(
    "review",
  );
  const [formDisclaimer, setFormDisclaimer] = useState("");
  const [formDomains, setFormDomains] = useState("");
  const [formConfigJson, setFormConfigJson] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function handleDraft() {
    if (!description.trim()) return;
    setLoadingDraft(true);
    setMessage(null);
    try {
      const res = await draftIndustryConfig({
        data: {
          description: description.trim(),
          name: suggestedName.trim() || undefined,
        },
      });
      setDraftResult(res);
      setFormName(res.name);
      setFormSlug(res.slug);
      setFormPublishMode(res.publishMode);
      setFormDisclaimer(res.disclaimer ?? "");
      setFormDomains(res.primaryDomains.join(", "));
      setFormConfigJson(JSON.stringify({ analysis: res.analysis }, null, 2));
    } catch (err) {
      setMessage(`Draft failed: ${String(err)}`);
    } finally {
      setLoadingDraft(false);
    }
  }

  async function handleCreate() {
    if (!formName.trim() || !formSlug.trim()) {
      setMessage("Name and Slug are required.");
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const primaryDomains = formDomains
        .split(",")
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean);

      await createIndustry({
        data: {
          name: formName.trim(),
          slug: formSlug.trim(),
          publishMode: formPublishMode,
          primaryDomains,
          config: formConfigJson,
          disclaimer: formDisclaimer.trim() ? formDisclaimer.trim() : null,
        },
      });

      setMessage("Section created successfully!");
      setIsDrafting(false);
      setDraftResult(null);
      setDescription("");
      setSuggestedName("");
      await router.invalidate();
    } catch (err) {
      setMessage(`Creation failed: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Sections</h1>
          <p className="text-sm text-muted-foreground">
            Manage publication sections, thresholds, whitelists, and review
            modes.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setIsDrafting(!isDrafting);
            setMessage(null);
          }}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          {isDrafting ? "Cancel" : "+ AI Draft New Section"}
        </button>
      </div>

      {message && (
        <div className="rounded-md border p-3 text-sm bg-muted/40">
          {message}
        </div>
      )}

      {isDrafting && (
        <div className="rounded-lg border bg-card p-5 shadow-sm space-y-4">
          <h2 className="text-lg font-semibold">
            AI Draft Section Configuration
          </h2>
          <p className="text-sm text-muted-foreground">
            Describe the industry or subject area. The AI will draft editorial
            categories, scoring weights, noise filters, and thresholds.
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Suggested Name (Optional)
              </label>
              <input
                type="text"
                placeholder="e.g. Biotechnology"
                value={suggestedName}
                onChange={(e) => setSuggestedName(e.target.value)}
                className="w-full rounded border px-3 py-1.5 text-sm"
              />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-muted-foreground mb-1">
                Section Description & Scope
              </label>
              <textarea
                rows={3}
                placeholder="Describe what belongs in this section, target audience, and key areas of interest..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full rounded border px-3 py-1.5 text-sm"
              />
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              disabled={loadingDraft || !description.trim()}
              onClick={handleDraft}
              className="rounded bg-secondary px-4 py-2 text-sm font-medium hover:bg-secondary/80 disabled:opacity-50"
            >
              {loadingDraft ? "Drafting with AI..." : "Generate AI Draft"}
            </button>
          </div>

          {draftResult && (
            <div className="border-t pt-4 space-y-4">
              <h3 className="text-sm font-semibold">
                Review & Finalize Section
              </h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    Section Name
                  </label>
                  <input
                    type="text"
                    value={formName}
                    onChange={(e) => setFormName(e.target.value)}
                    className="w-full rounded border px-3 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    Slug
                  </label>
                  <input
                    type="text"
                    value={formSlug}
                    onChange={(e) => setFormSlug(e.target.value)}
                    className="w-full rounded border px-3 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    Publish Mode
                  </label>
                  <select
                    value={formPublishMode}
                    onChange={(e) =>
                      setFormPublishMode(e.target.value as "auto" | "review")
                    }
                    className="w-full rounded border px-3 py-1.5 text-sm"
                  >
                    <option value="review">Review (Human Approval)</option>
                    <option value="auto">Auto (Automatic Publish)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    Primary Domains (comma-separated)
                  </label>
                  <input
                    type="text"
                    value={formDomains}
                    onChange={(e) => setFormDomains(e.target.value)}
                    className="w-full rounded border px-3 py-1.5 text-sm"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    Disclaimer (Optional)
                  </label>
                  <input
                    type="text"
                    value={formDisclaimer}
                    onChange={(e) => setFormDisclaimer(e.target.value)}
                    className="w-full rounded border px-3 py-1.5 text-sm"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-muted-foreground mb-1">
                    Config JSON
                  </label>
                  <textarea
                    rows={8}
                    value={formConfigJson}
                    onChange={(e) => setFormConfigJson(e.target.value)}
                    className="w-full font-mono text-xs rounded border p-2"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  disabled={saving}
                  onClick={handleCreate}
                  className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {saving ? "Creating Section..." : "Create Section"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

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
