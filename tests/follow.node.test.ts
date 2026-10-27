import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  FollowFormView,
  FollowOwnLink,
  FollowSuccess,
  RevokeFormView,
} from "../src/components/FollowForm";
import {
  createErrorMessage,
  extractFeedToken,
  followSectionOptions,
  parseKeywords,
  resolveFollowShell,
  revokeErrorMessage,
  showWatchesNav,
  submitCreate,
  submitRevoke,
  validateFollow,
} from "../src/lib/follow";

const SECTIONS = [
  { slug: "technology", name: "Technology" },
  { slug: "finance", name: "Finance" },
  { slug: "education", name: "Education" },
];
const TOKEN = "A".repeat(43);
const FEED = `https://news.example/rss/p/${TOKEN}.xml`;
const GOOD = {
  question: "Will agent protocols converge this year?",
  criteria: "A shipped standard adopted by two large vendors.",
  keywords: "agent, protocol",
  industrySlug: "",
};

const render = <P extends object>(c: ComponentType<P>, p: P) =>
  renderToStaticMarkup(createElement(c, p));

const viewProps = {
  sections: SECTIONS,
  fieldErrors: {},
  formError: null,
  pending: false,
  onSubmit: () => {},
};

describe("FollowFormView", () => {
  const html = render(FollowFormView, viewProps);

  it("labels every control and binds it to its input", () => {
    for (const label of [
      "Question",
      "What counts as real progress",
      "Keywords",
      "Section",
    ]) {
      const m = new RegExp(
        `<label[^>]*for="([^"]+)"[^>]*>${label}</label>`,
      ).exec(html);
      expect(m, label).not.toBeNull();
      expect(html).toContain(`id="${m![1]}"`);
    }
  });

  it("limits the two text areas to 200 and 300 characters", () => {
    expect(html).toMatch(/<textarea[^>]*maxLength="200"/);
    expect(html).toMatch(/<textarea[^>]*maxLength="300"/);
  });

  it("offers All sections and every section except Finance", () => {
    expect(html).toContain("All sections");
    expect(html).toContain('value="technology"');
    expect(html).toContain('value="education"');
    expect(html).not.toContain('value="finance"');
    expect(html).not.toContain("Finance");
  });

  it("states what is stored and where it goes", () => {
    expect(html).toContain(
      "Your question, criteria and keywords are stored in plain text. The question and criteria are sent to our model provider to check new reporting. They are kept after the watch is stopped; deleting them is not available yet.",
    );
  });

  it("posts, so a submit before hydration never writes the URL", () => {
    expect(html).toMatch(/<form[^>]*method="post"/);
  });

  it("shows field errors and the form error in live regions", () => {
    const withErrors = render(FollowFormView, {
      ...viewProps,
      fieldErrors: { question: "Use 10 to 200 characters." },
      formError: createErrorMessage("per_network_limit"),
    });
    expect(withErrors).toContain("Use 10 to 200 characters.");
    expect(withErrors).toMatch(/aria-invalid="true"/);
    expect(withErrors).toContain(
      "You have created 3 watches from this network today. Try again tomorrow.",
    );
    expect(withErrors).toMatch(/role="alert"/);
  });
});

describe("FollowSuccess", () => {
  const html = render(FollowSuccess, { feedUrl: FEED });

  it("shows the address in a read-only input with a Copy button", () => {
    expect(html).toMatch(/<input[^>]*readOnly=""[^>]*/);
    expect(html).toContain(`value="${FEED}"`);
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Copy<\/button>/);
  });

  it("uses the exact copy", () => {
    expect(html).toContain(
      "Save this address now. It is shown only once. Anyone with it can read this feed.",
    );
    expect(html).toContain(
      "Add it to your RSS reader. The feed lists a story only when newly approved reporting meets your criteria.",
    );
  });

  it("announces itself politely", () => {
    expect(html).toMatch(/aria-live="polite"|role="status"/);
  });
});

describe("RevokeFormView", () => {
  it("has a labelled address input and a post form", () => {
    const html = render(RevokeFormView, {
      error: null,
      done: false,
      pending: false,
      onSubmit: () => {},
    });
    expect(html).toMatch(
      /<label[^>]*for="([^"]+)"[^>]*>Paste your feed address/,
    );
    expect(html).toMatch(/<form[^>]*method="post"/);
    expect(html).not.toContain("This feed is stopped.");
  });

  it("shows the stopped message", () => {
    const html = render(RevokeFormView, {
      error: null,
      done: true,
      pending: false,
      onSubmit: () => {},
    });
    expect(html).toContain("This feed is stopped.");
  });
});

describe("FollowOwnLink", () => {
  it("links /follow with the exact text", () => {
    const html = render(FollowOwnLink, {});
    expect(html).toContain('href="/follow"');
    expect(html).toContain("Follow your own question →");
  });
});

describe("error copy", () => {
  it("maps every create code", () => {
    expect(createErrorMessage("per_network_limit")).toBe(
      "You have created 3 watches from this network today. Try again tomorrow.",
    );
    expect(createErrorMessage("capacity_full")).toBe(
      "Reader watches are full right now. Try again later.",
    );
    const off = "Watches are not available right now.";
    expect(createErrorMessage("reader_watch_disabled")).toBe(off);
    expect(createErrorMessage("unavailable")).toBe(off);
    expect(createErrorMessage("no_client_ip")).toBe(off);
    expect(createErrorMessage(null)).toBe(off);
    expect(createErrorMessage("payload_too_large")).toMatch(/too long/);
    expect(createErrorMessage("invalid_input")).toMatch(/Check the form/);
    expect(createErrorMessage("section_not_allowed")).toMatch(/Check the form/);
  });

  it("maps the revoke codes", () => {
    expect(revokeErrorMessage("not_found")).toMatch(/could not find/i);
    expect(revokeErrorMessage(null)).toBe(
      "Watches are not available right now.",
    );
  });
});

describe("form helpers", () => {
  it("splits keywords on commas and drops empties", () => {
    expect(parseKeywords(" agent, protocol ,, ")).toEqual([
      "agent",
      "protocol",
    ]);
    expect(parseKeywords("")).toEqual([]);
  });

  it("removes Finance from the section options, however it is written", () => {
    const out = followSectionOptions([
      ...SECTIONS,
      { slug: " Finance ", name: "Finance 2" },
    ]);
    expect(out.map((s) => s.slug)).toEqual(["technology", "education"]);
  });

  it("validates with the server schema and names the field", () => {
    const ok = validateFollow(GOOD);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.input.keywords).toEqual(["agent", "protocol"]);
      expect(ok.input.industrySlug).toBeNull();
    }
    const sec = validateFollow({ ...GOOD, industrySlug: "education" });
    expect(sec.ok && sec.input.industrySlug).toBe("education");

    const short = validateFollow({ ...GOOD, question: "short" });
    expect(short).toEqual({
      ok: false,
      errors: { question: "Use 10 to 200 characters." },
    });
    const chars = validateFollow({ ...GOOD, criteria: 'say "hello" please' });
    expect(!chars.ok && chars.errors.criteria).toBe(
      "Use letters, numbers and basic punctuation only.",
    );
    const none = validateFollow({ ...GOOD, keywords: " , " });
    expect(!none.ok && none.errors.keywords).toBe(
      "Add 1 to 5 keywords, separated by commas.",
    );
    const many = validateFollow({ ...GOOD, keywords: "aa,bb,cc,dd,ee,ff" });
    expect(!many.ok && many.errors.keywords).toBe(
      "Add 1 to 5 keywords, separated by commas.",
    );
    const one = validateFollow({ ...GOOD, keywords: "a" });
    expect(!one.ok && one.errors.keywords).toBe(
      "Each keyword needs 2 to 40 characters.",
    );
  });

  it("takes the token out of a pasted feed address", () => {
    expect(extractFeedToken(`  ${FEED}  `)).toBe(TOKEN);
    expect(extractFeedToken(`${FEED}?x=1`)).toBe(TOKEN);
    expect(extractFeedToken(`/rss/p/${TOKEN}.xml`)).toBe(TOKEN);
    expect(
      extractFeedToken("https://news.example/rss/technology.xml"),
    ).toBeNull();
    expect(extractFeedToken(`/rss/p/${TOKEN}A.xml`)).toBeNull();
    expect(extractFeedToken("")).toBeNull();
  });
});

describe("submitCreate", () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  it("returns the feed address on success", async () => {
    const r = await submitCreate(GOOD, async () => ({ feedUrl: FEED }));
    expect(r).toEqual({ kind: "ok", feedUrl: FEED });
  });

  it("does not call the server when a field is invalid", async () => {
    let called = false;
    const r = await submitCreate({ ...GOOD, question: "x" }, async () => {
      called = true;
      return {};
    });
    expect(called).toBe(false);
    expect(r.kind).toBe("fields");
  });

  it("turns a thrown Response into its copy", async () => {
    const r = await submitCreate(GOOD, async () => {
      throw json(429, { error: "per_network_limit" });
    });
    expect(r).toEqual({
      kind: "error",
      message: createErrorMessage("per_network_limit"),
    });
  });

  it("turns a resolved error body into its copy", async () => {
    const r = await submitCreate(GOOD, async () => ({
      error: "capacity_full",
    }));
    expect(r).toEqual({
      kind: "error",
      message: createErrorMessage("capacity_full"),
    });
  });

  it("falls back for a network failure and a non-JSON Response", async () => {
    const fallback = createErrorMessage(null);
    const a = await submitCreate(GOOD, async () => {
      throw new TypeError("fetch failed");
    });
    const b = await submitCreate(GOOD, async () => {
      throw new Response("nope", { status: 502 });
    });
    expect(a).toEqual({ kind: "error", message: fallback });
    expect(b).toEqual({ kind: "error", message: fallback });
  });
});

describe("submitRevoke", () => {
  it("sends only the token", async () => {
    const seen: string[] = [];
    const r = await submitRevoke(FEED, async (t) => {
      seen.push(t);
      return { ok: true };
    });
    expect(r).toEqual({ kind: "ok" });
    expect(seen).toEqual([TOKEN]);
  });

  it("rejects an address without a token before calling the server", async () => {
    let called = false;
    const r = await submitRevoke("hello", async () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(r.kind).toBe("error");
  });

  it("maps a 404", async () => {
    const r = await submitRevoke(FEED, async () => {
      throw new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    });
    expect(r).toEqual({
      kind: "error",
      message: revokeErrorMessage("not_found"),
    });
  });
});

describe("switch guards", () => {
  it("/follow is a 404 while the switch is off", () => {
    expect(() =>
      resolveFollowShell({ readerWatchEnabled: false, sections: SECTIONS }),
    ).toThrow();
    try {
      resolveFollowShell({ readerWatchEnabled: false, sections: SECTIONS });
    } catch (e) {
      expect((e as { isNotFound?: boolean }).isNotFound).toBe(true);
    }
  });

  it("/follow gets the sections without Finance when it is on", () => {
    const r = resolveFollowShell({
      readerWatchEnabled: true,
      sections: SECTIONS,
    });
    expect(r.sections.map((s) => s.slug)).toEqual(["technology", "education"]);
  });

  it("the header shows Watches when watches exist or the switch is on", () => {
    expect(
      showWatchesNav({ hasWatches: false, readerWatchEnabled: false }),
    ).toBe(false);
    expect(
      showWatchesNav({ hasWatches: true, readerWatchEnabled: false }),
    ).toBe(true);
    expect(
      showWatchesNav({ hasWatches: false, readerWatchEnabled: true }),
    ).toBe(true);
  });
});

describe("the feed address stays in memory", () => {
  const root = join(import.meta.dirname, "..");
  const sources = [
    "src/components/FollowForm.tsx",
    "src/routes/follow.tsx",
    "src/lib/follow.ts",
  ].map((f) => [f, readFileSync(join(root, f), "utf8")] as const);

  it.each(sources)("%s never stores or navigates", (_f, text) => {
    // Strip comments so a comment cannot hide or fake a match.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const banned of [
      "localStorage",
      "sessionStorage",
      "writePrefs",
      "document.cookie",
      "navigate(",
      "window.location",
      "location.",
      "history.",
      "replaceState",
      "pushState",
      "searchParams",
    ]) {
      expect(code, banned).not.toContain(banned);
    }
  });

  it("the route calls the shell guard", () => {
    const route = sources.find(([f]) => f === "src/routes/follow.tsx")![1];
    expect(route).toContain("resolveFollowShell(");
    expect(route).toContain("createReaderWatch");
    expect(route).toContain("revokeReaderWatch");
  });
});
