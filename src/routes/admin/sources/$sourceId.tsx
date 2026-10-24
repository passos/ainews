import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { listIndustries } from "../../../server/admin/industries";
import {
  createSource,
  getSource,
  updateSource,
} from "../../../server/admin/sources";

export const Route = createFileRoute("/admin/sources/$sourceId")({
  ssr: "data-only",
  loader: async ({ params }) => {
    const isNew = params.sourceId === "new";
    const [source, industries] = await Promise.all([
      isNew ? null : getSource({ data: Number(params.sourceId) }),
      listIndustries(),
    ]);
    if (!isNew && !source) {
      throw new Response("Source not found", { status: 404 });
    }
    return { isNew, source, industries };
  },
  component: AdminSourceEditPage,
});

function AdminSourceEditPage() {
  const { isNew, source, industries } = Route.useLoaderData();
  const navigate = useNavigate();

  const [industryId, setIndustryId] = useState<number>(
    source?.industryId ?? industries[0]?.id ?? 1,
  );
  const [name, setName] = useState(source?.name ?? "");
  const [feedUrl, setFeedUrl] = useState(source?.feedUrl ?? "");
  const [siteDomain, setSiteDomain] = useState(source?.siteDomain ?? "");
  const [kind, setKind] = useState<"rss" | "html">(source?.kind ?? "rss");
  const [intervalMinutes, setIntervalMinutes] = useState(
    source?.intervalMinutes ?? 60,
  );
  const [utcOffset, setUtcOffset] = useState(source?.utcOffset ?? "+00:00");
  const [config, setConfig] = useState(source?.config ?? "{}");
  const [jinaEnabled, setJinaEnabled] = useState(
    Boolean(source?.jinaEnabled ?? 0),
  );

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);

    try {
      JSON.parse(config);

      if (isNew) {
        await createSource({
          data: {
            industryId,
            name: name.trim(),
            feedUrl: feedUrl.trim(),
            siteDomain: siteDomain.trim() ? siteDomain.trim() : null,
            kind,
            intervalMinutes: Number(intervalMinutes),
            utcOffset: utcOffset.trim(),
            config,
            jinaEnabled: jinaEnabled ? 1 : 0,
          },
        });
      } else if (source) {
        await updateSource({
          data: {
            id: source.id,
            name: name.trim(),
            feedUrl: feedUrl.trim(),
            siteDomain: siteDomain.trim() ? siteDomain.trim() : null,
            intervalMinutes: Number(intervalMinutes),
            utcOffset: utcOffset.trim(),
            config,
            jinaEnabled: jinaEnabled ? 1 : 0,
          },
        });
      }

      await navigate({ to: "/admin/sources" });
    } catch (err) {
      if (err instanceof SyntaxError) {
        setError("Config must be valid JSON");
      } else if (err instanceof Response) {
        setError(await err.text());
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <div>
        <Link
          to="/admin/sources"
          className="text-xs text-muted-foreground hover:underline"
        >
          &larr; Back to Sources
        </Link>
        <h1 className="mt-1 text-xl font-bold tracking-tight">
          {isNew ? "Add New Source" : `Edit Source: ${source?.name}`}
        </h1>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-4 text-sm">
        {isNew && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="industry" className="font-medium">
              Section
            </label>
            <select
              id="industry"
              value={industryId}
              onChange={(e) => setIndustryId(Number(e.target.value))}
              className="rounded-md border bg-background px-3 py-2 text-sm"
            >
              {industries.map((ind) => (
                <option key={ind.id} value={ind.id}>
                  {ind.name} ({ind.slug})
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <label htmlFor="name" className="font-medium">
            Source Name
          </label>
          <input
            id="name"
            required
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded-md border bg-background px-3 py-2 text-sm"
            placeholder="MIT Technology Review"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="feedUrl" className="font-medium">
            Feed / Listing URL
          </label>
          <input
            id="feedUrl"
            required
            type="url"
            value={feedUrl}
            onChange={(e) => setFeedUrl(e.target.value)}
            className="rounded-md border bg-background px-3 py-2 text-sm font-mono text-xs"
            placeholder="https://example.com/rss.xml"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="siteDomain" className="font-medium">
            Site Domain (Optional)
          </label>
          <input
            id="siteDomain"
            type="text"
            value={siteDomain}
            onChange={(e) => setSiteDomain(e.target.value)}
            className="rounded-md border bg-background px-3 py-2 text-sm"
            placeholder="technologyreview.com"
          />
        </div>

        {isNew && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="kind" className="font-medium">
              Kind
            </label>
            <select
              id="kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as "rss" | "html")}
              className="rounded-md border bg-background px-3 py-2 text-sm"
            >
              <option value="rss">RSS / Atom Feed</option>
              <option value="html">HTML Listing Page</option>
            </select>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="intervalMinutes" className="font-medium">
              Interval (Minutes)
            </label>
            <input
              id="intervalMinutes"
              type="number"
              min="10"
              value={intervalMinutes}
              onChange={(e) => setIntervalMinutes(Number(e.target.value))}
              className="rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="utcOffset" className="font-medium">
              UTC Offset
            </label>
            <input
              id="utcOffset"
              type="text"
              pattern="^[+-](?:[01]\d|2[0-3]):[0-5]\d$"
              value={utcOffset}
              onChange={(e) => setUtcOffset(e.target.value)}
              className="rounded-md border bg-background px-3 py-2 text-sm font-mono text-xs"
              placeholder="+00:00"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="config" className="font-medium">
            Config JSON (Selectors / Extraction rules)
          </label>
          <textarea
            id="config"
            rows={5}
            value={config}
            onChange={(e) => setConfig(e.target.value)}
            className="rounded-md border bg-background px-3 py-2 font-mono text-xs"
          />
        </div>

        <div className="flex items-center gap-2 pt-1">
          <input
            id="jinaEnabled"
            type="checkbox"
            checked={jinaEnabled}
            onChange={(e) => setJinaEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300"
          />
          <label htmlFor="jinaEnabled" className="text-sm font-medium">
            Enable Jina Reader fallback (Ladder step 3)
          </label>
        </div>

        <div className="flex items-center gap-3 pt-3">
          <button
            type="submit"
            disabled={saving}
            className="rounded bg-primary px-4 py-2 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? "Saving..." : isNew ? "Create Source" : "Save Changes"}
          </button>
          <Link
            to="/admin/sources"
            className="text-muted-foreground hover:underline"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
