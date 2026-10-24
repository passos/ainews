import { useState } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
  getIndustry,
  updateIndustryConfig,
} from "../../../server/admin/industries";

export const Route = createFileRoute("/admin/industries/$industryId")({
  ssr: "data-only",
  loader: async ({ params }) => {
    const id = Number(params.industryId);
    const industry = await getIndustry({ data: id });
    if (!industry) {
      throw new Response("Industry not found", { status: 404 });
    }
    return { industry };
  },
  component: AdminIndustryEditPage,
});

function AdminIndustryEditPage() {
  const { industry } = Route.useLoaderData();
  const router = useRouter();

  const isFinance = industry.slug.trim().toLowerCase() === "finance";
  const [publishMode, setPublishMode] = useState<"auto" | "review">(
    industry.publishMode as "auto" | "review",
  );
  const [primaryDomainsText, setPrimaryDomainsText] = useState(
    (() => {
      try {
        const arr = JSON.parse(industry.primaryDomains ?? "[]");
        return Array.isArray(arr) ? arr.join("\n") : "";
      } catch {
        return "";
      }
    })(),
  );
  const [config, setConfig] = useState(industry.config ?? "{}");
  const [disclaimer, setDisclaimer] = useState(industry.disclaimer ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(false);

    try {
      // Validate config is valid JSON
      JSON.parse(config);

      const domains = primaryDomainsText
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);

      await updateIndustryConfig({
        data: {
          id: industry.id,
          publishMode,
          primaryDomains: domains,
          config,
          disclaimer: disclaimer.trim() ? disclaimer.trim() : null,
        },
      });

      setSuccess(true);
      await router.invalidate();
    } catch (err) {
      if (err instanceof SyntaxError) {
        setError("Config must be valid JSON");
      } else if (err instanceof Response) {
        const text = await err.text();
        setError(text || `Error ${err.status}`);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <Link
            to="/admin/industries"
            className="text-xs text-muted-foreground hover:underline"
          >
            &larr; Back to Sections
          </Link>
          <h1 className="mt-1 text-xl font-bold tracking-tight">
            Configure {industry.name} ({industry.slug})
          </h1>
        </div>
        <span className="font-mono text-xs text-muted-foreground">
          v{industry.configVersion}
        </span>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {success && (
        <div className="rounded-md border border-emerald-500/50 bg-emerald-500/10 p-3 text-sm text-emerald-600 dark:text-emerald-400">
          Section configuration saved successfully.
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="publishMode" className="text-sm font-medium">
            Publish Mode
          </label>
          <select
            id="publishMode"
            value={publishMode}
            onChange={(e) =>
              setPublishMode(e.target.value as "auto" | "review")
            }
            className="rounded-md border bg-background px-3 py-2 text-sm"
          >
            <option value="review">Review (Human approval required)</option>
            <option value="auto" disabled={isFinance}>
              Auto (Publish immediately upon scoring)
              {isFinance ? " — Disabled for Finance" : ""}
            </option>
          </select>
          {isFinance && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Contract requirement: Finance section must always remain in review
              mode.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="primaryDomains" className="text-sm font-medium">
            Primary Domains (one per line)
          </label>
          <textarea
            id="primaryDomains"
            rows={4}
            value={primaryDomainsText}
            onChange={(e) => setPrimaryDomainsText(e.target.value)}
            className="rounded-md border bg-background px-3 py-2 font-mono text-xs"
            placeholder="example.com&#10;arxiv.org"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="config" className="text-sm font-medium">
            Config JSON (Prompt & Scoring Rules)
          </label>
          <textarea
            id="config"
            rows={8}
            value={config}
            onChange={(e) => setConfig(e.target.value)}
            className="rounded-md border bg-background px-3 py-2 font-mono text-xs"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="disclaimer" className="text-sm font-medium">
            Disclaimer Text (Optional)
          </label>
          <textarea
            id="disclaimer"
            rows={3}
            value={disclaimer}
            onChange={(e) => setDisclaimer(e.target.value)}
            className="rounded-md border bg-background px-3 py-2 text-sm"
            placeholder="Legal / regulatory disclaimer to display on section page..."
          />
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            disabled={saving}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Configuration"}
          </button>
          <Link
            to="/admin/industries"
            className="text-sm text-muted-foreground hover:underline"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
