// scripts/probe-slots-lib.ts (#117): the site list and the cost cap. Pure:
// no transport, nothing is sent (runBatch gets a fake probe).
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_SCHEMAS,
  B1_IDS,
  buildSites,
  decide,
  planSites,
  PROBE_CAP_MICROS,
  probeSite,
  refusal,
  rejectionIssues,
  runBatch,
  runPlanned,
  saveRejection,
  splitBatches,
  totalMaxMicros,
} from "../scripts/probe-slots-lib";
import type { PlannedSite, ProbeResult } from "../scripts/probe-slots-lib";
import { ARTIFACT_REGISTRY } from "../src/pipeline/artifacts/registry";
import { costMicros } from "../src/providers/budget";
import type { ModelTransport } from "../src/providers/transport";
import { DEFAULT_PRICES, DEFAULT_SLOTS } from "../src/providers/defaults";
import { realFixture } from "./fixtures/analysis/real-shape";

const DIR = fileURLToPath(
  new URL("./fixtures/analysis/real/", import.meta.url),
);
const fixtures = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((file) => ({
    file,
    fixture: realFixture.parse(JSON.parse(readFileSync(DIR + file, "utf8"))),
  }));

describe("probe-slots sites", () => {
  const sites = buildSites(fixtures);

  it("has one request per call site and per artifact audience", () => {
    const ids = sites.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const artifacts = Object.values(ARTIFACT_REGISTRY).flatMap((def) =>
      def.audiences.map((aud) => `artifact.${def.type}${aud ? `.${aud}` : ""}`),
    );
    expect(ids).toEqual(
      expect.arrayContaining([
        "analyze.write",
        ...artifacts,
        "evidence.claims",
        "ask.round1",
        "ask.round2",
        "digest.daily",
        "digest.weekly",
        "watch.summary",
      ]),
    );
    expect(ids).toHaveLength(artifacts.length + 7);
  });

  it("keeps the slot of the registry", () => {
    const decoder = sites.find((s) => s.id === "artifact.earnings_decoder");
    expect(decoder?.slot).toBe("reason");
    expect(sites.find((s) => s.id === "digest.weekly")?.slot).toBe("reason");
    expect(sites.find((s) => s.id === "digest.daily")?.slot).toBe("write");
  });

  it("sends a positive output limit and a thinking config everywhere", () => {
    for (const site of sites) {
      expect(site.request.maxOutputTokens, site.id).toBeGreaterThan(0);
      expect(site.request.thinkingConfig, site.id).toBeDefined();
    }
  });
});

describe("probe-slots cost", () => {
  const sites = buildSites(fixtures).slice(0, 2);

  it("reserves maxOutputTokens x price.out plus the input estimate", () => {
    const plan = planSites(sites, DEFAULT_SLOTS, {
      [DEFAULT_SLOTS.write.model]: { in: 0, out: 1_000_000 },
    });
    // 1 micro-USD per output token, input free.
    expect(plan.map((p) => p.maxMicros)).toEqual(
      sites.map((s) => s.request.maxOutputTokens),
    );
    expect(totalMaxMicros(plan)).toBe(
      sites[0].request.maxOutputTokens + sites[1].request.maxOutputTokens,
    );
    const withInput = planSites(sites, DEFAULT_SLOTS, {
      [DEFAULT_SLOTS.write.model]: { in: 1_000_000, out: 0 },
    });
    expect(withInput[0].maxMicros).toBe(withInput[0].inputTokens);
    expect(withInput[0].inputTokens).toBeGreaterThan(0);
  });

  it("throws when the model has no price", () => {
    expect(() => planSites(sites, DEFAULT_SLOTS, {})).toThrow(/no price/);
  });

  it("refuses above the cap only", () => {
    expect(PROBE_CAP_MICROS).toBe(100_000);
    expect(refusal(PROBE_CAP_MICROS)).toBeNull();
    expect(refusal(PROBE_CAP_MICROS + 1)).toMatch(/exceeds the cap/);
    expect(refusal(5, 4)).toMatch(/exceeds/);
  });

  it("uses the seeded prices", () => {
    const plan = planSites(buildSites(fixtures), DEFAULT_SLOTS, DEFAULT_PRICES);
    expect(totalMaxMicros(plan)).toBeGreaterThan(0);
  });
});

function fake(id: string, maxMicros: number): PlannedSite {
  return { id, maxMicros, model: "m" } as PlannedSite;
}

const b1Fakes = B1_IDS.map((id) => fake(id, 1));

describe("probe-slots batches", () => {
  it("splits the real plan into three batches within the cap", () => {
    const plan = planSites(buildSites(fixtures), DEFAULT_SLOTS, DEFAULT_PRICES);
    const batches = splitBatches(plan);
    expect(batches.map((b) => b.name)).toEqual(["B1", "B2", "B3"]);
    expect(batches[0].sites.map((s) => s.id)).toEqual([...B1_IDS]);
    // Registry order, nothing lost, nothing twice.
    expect([...batches[1].sites, ...batches[2].sites].map((s) => s.id)).toEqual(
      plan.filter((s) => s.id.startsWith("artifact.")).map((s) => s.id),
    );
    for (const b of batches) {
      expect(b.sites.length, b.name).toBeGreaterThan(0);
      expect(b.totalMax, b.name).toBe(totalMaxMicros(b.sites));
      expect(refusal(b.totalMax), b.name).toBeNull();
    }
    const types = (i: number) =>
      new Set(batches[i].sites.map((s) => s.id.split(".")[1]));
    for (const t of types(1)) expect(types(2).has(t), t).toBe(false);
  });

  it("cuts the artifacts where the larger half is smallest", () => {
    const batches = splitBatches([
      ...b1Fakes,
      fake("artifact.a", 10),
      fake("artifact.b", 10),
      fake("artifact.c", 20),
    ]);
    expect(batches[1].sites.map((s) => s.id)).toEqual([
      "artifact.a",
      "artifact.b",
    ]);
    expect(batches[2].sites.map((s) => s.id)).toEqual(["artifact.c"]);
    expect(batches.map((b) => b.totalMax)).toEqual([7, 20, 20]);
  });

  it("throws when a site is in no batch or a B1 site is missing", () => {
    expect(() => splitBatches([...b1Fakes, fake("discover.draft", 1)])).toThrow(
      /in no batch/,
    );
    expect(() => splitBatches(b1Fakes.slice(1))).toThrow(/no site/);
  });
});

describe("probe-slots decide", () => {
  const batches = [
    { name: "B1" as const, sites: [], totalMax: 90_000 },
    { name: "B2" as const, sites: [], totalMax: PROBE_CAP_MICROS },
    { name: "B3" as const, sites: [], totalMax: PROBE_CAP_MICROS + 1 },
  ];

  it("rejects bad arguments", () => {
    for (const args of [
      [],
      ["--dry-run", "--yes-spend"],
      ["--yes-spend"],
      ["--yes-spend", "--batch"],
      ["--dry-run", "--batch", "B4"],
    ]) {
      expect(decide(args, batches).kind, args.join(" ")).toBe("usage");
    }
  });

  it("dry run shows all batches or the selected one", () => {
    expect(decide(["--dry-run"], batches)).toEqual({ kind: "dry", batches });
    expect(decide(["--dry-run", "--batch", "B3"], batches)).toEqual({
      kind: "dry",
      batches: [batches[2]],
    });
  });

  it("--only narrows a batch to the listed sites and recomputes its max", () => {
    const sites = [fake("a", 10), fake("b", 20), fake("c", 40)];
    const two = [{ name: "B2" as const, sites, totalMax: 70 }];
    expect(
      decide(["--yes-spend", "--batch", "B2", "--only", "a,c"], two),
    ).toMatchObject({
      kind: "run",
      batch: { name: "B2", totalMax: 50, sites: [{ id: "a" }, { id: "c" }] },
    });
    for (const args of [
      ["--dry-run", "--only", "a"],
      ["--dry-run", "--batch", "B2", "--only", "z"],
      ["--dry-run", "--batch", "B2", "--only"],
    ]) {
      expect(decide(args, two).kind, args.join(" ")).toBe("usage");
    }
  });

  it("refuses a real batch above the cap and runs one at the cap", () => {
    const over = decide(["--yes-spend", "--batch", "B3"], batches);
    expect(over.kind).toBe("refuse");
    expect(over).toMatchObject({ message: /B3: .*exceeds the cap/ });
    expect(decide(["--batch", "B2", "--yes-spend"], batches)).toEqual({
      kind: "run",
      batch: batches[1],
    });
    expect(decide(["--yes-spend", "--batch", "B1"], batches, 89_999).kind).toBe(
      "refuse",
    );
  });
});

describe("probe-slots runBatch", () => {
  const ok: ProbeResult = {
    finishReason: "STOP",
    outputTokens: 10,
    thinkingTokens: 5,
    cost: 3,
    accepted: true,
  };
  const sites = [fake("a", 10), fake("b", 10), fake("c", 10)];

  async function run(results: (ProbeResult | Error)[], cap?: number) {
    const sent: string[] = [];
    const lines: string[] = [];
    const code = await runBatch(
      sites,
      async (site) => {
        const r = results[sent.length];
        sent.push(site.id);
        if (r instanceof Error) throw r;
        return r;
      },
      (line) => lines.push(line),
      cap ?? PROBE_CAP_MICROS,
    );
    return { code, sent, lines };
  }

  it("exits 0 when every site is STOP and parsed", async () => {
    const r = await run([ok, ok, ok]);
    expect(r.code).toBe(0);
    expect(r.sent).toEqual(["a", "b", "c"]);
    expect(r.lines.at(-1)).toMatch(/3 calls, 0 rejected.*cost 9/);
  });

  it("stops at the first finishReason that is not STOP", async () => {
    const r = await run([ok, { ...ok, finishReason: "MAX_TOKENS" }, ok]);
    expect(r.code).toBe(1);
    expect(r.sent).toEqual(["a", "b"]);
    expect(r.lines.at(-1)).toMatch(/STOP at b: finishReason MAX_TOKENS/);
  });

  it("stops at an error", async () => {
    const r = await run([new Error("boom"), ok, ok]);
    expect(r.code).toBe(1);
    expect(r.sent).toEqual(["a"]);
  });

  it("continues past a parser rejection but exits 1", async () => {
    const r = await run([ok, { ...ok, accepted: false }, ok]);
    expect(r.code).toBe(1);
    expect(r.sent).toEqual(["a", "b", "c"]);
  });

  it("stops before a site that could exceed the cap", async () => {
    const r = await run([ok, ok, ok], 12);
    expect(r.code).toBe(1);
    expect(r.sent).toEqual(["a"]);
  });
});

describe("probe-slots rejection report", () => {
  const plan = planSites(buildSites(fixtures), DEFAULT_SLOTS, DEFAULT_PRICES);
  const byId = (id: string) => plan.find((s) => s.id === id)!;
  const learning = byId("artifact.learning_material.student");
  const badQuiz =
    '```json\n{"audience":"student","conceptExplainer":"x","glossary":[],' +
    '"quiz":[{"question":"q","options":["a","b"],"answerIndex":5,' +
    '"explanation":"e"}],"discussionQuestions":[],"activities":[]}\n```';
  const tmp = () => mkdtempSync(join(tmpdir(), "probe-rej-"));
  const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));

  it("saves the raw text and the zod issues", () => {
    expect(learning.accepts(badQuiz)).toBe(false);
    const saved = read(saveRejection(tmp(), learning, badQuiz));
    expect(saved.rawText).toBe(badQuiz);
    expect(saved.issues).toMatchObject([{ path: ["quiz", 0, "answerIndex"] }]);
    const bad = read(saveRejection(tmp(), learning, "not json"));
    expect(bad.issues).toMatchObject([{ code: "invalid_json" }]);
  });

  it("has a schema for every artifact type but earnings_decoder", () => {
    const types = Object.keys(ARTIFACT_REGISTRY).sort();
    expect(
      [...Object.keys(ARTIFACT_SCHEMAS), "earnings_decoder"].sort(),
    ).toEqual(types);
    for (const [type, schema] of Object.entries(ARTIFACT_SCHEMAS)) {
      expect(schema.safeParse({}).success, type).toBe(false);
      const site = plan.find((s) => s.id.startsWith(`artifact.${type}`))!;
      expect(rejectionIssues("{}", site.diagnosis), type).not.toEqual([]);
    }
    const earnings = plan.find((s) => s.id.startsWith("artifact.earnings"))!;
    expect(read(saveRejection(tmp(), earnings, "{}")).issues).toBe(
      "unavailable: production enriches before parse",
    );
  });

  it("explains a rejection of the non-artifact JSON sites too", () => {
    for (const id of ["analyze.write", "evidence.claims", "ask.round1"]) {
      const site = byId(id);
      expect(rejectionIssues("{", site.diagnosis), id).toMatchObject([
        { code: "invalid_json" },
      ]);
      expect(rejectionIssues("{}", site.diagnosis), id).not.toEqual([]);
    }
    expect(
      read(saveRejection(tmp(), byId("digest.daily"), "x")).issues,
    ).toMatch(/^unavailable: /);
  });

  it("writes only under the system temp dir", () => {
    const outside = join(process.cwd(), "scripts", "rej-test");
    expect(() => saveRejection(outside, learning, badQuiz)).toThrow(/temp dir/);
    expect(existsSync(outside)).toBe(false);
    // A symlink in the temp dir that points out of it is followed by realpath.
    const link = join(tmp(), "link");
    symlinkSync(process.cwd(), link);
    expect(() => saveRejection(join(link, "x"), learning, badQuiz)).toThrow(
      /temp dir/,
    );
    // A name that merely starts with two dots is a normal name.
    const dots = join(tmp(), "..rejections");
    expect(saveRejection(dots, learning, badQuiz)).toContain("..rejections");
    expect(() =>
      saveRejection(join(tmp(), "..", ".."), learning, badQuiz),
    ).toThrow(/temp dir/);
  });
});

describe("probe-slots probeSite and runPlanned", () => {
  const plan = planSites(buildSites(fixtures), DEFAULT_SLOTS, DEFAULT_PRICES);
  const write = plan.find((s) => s.id === "analyze.write")!;
  const transport = (reply: unknown, sent: string[] = []): ModelTransport => ({
    async run(model) {
      sent.push(model);
      return reply;
    },
  });
  const price = DEFAULT_PRICES[write.model];
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  const dir = () => mkdtempSync(join(tmpdir(), "probe-run-"));

  it("keeps finishReason, thinking tokens and cost when the reply has no content", async () => {
    const reply = {
      candidates: [{ finishReason: "MAX_TOKENS" }],
      usageMetadata: { promptTokenCount: 100, thoughtsTokenCount: 2000 },
    };
    const r = await probeSite(write, transport(reply), dir(), log);
    expect(r).toEqual({
      finishReason: "MAX_TOKENS",
      outputTokens: 0,
      thinkingTokens: 2000,
      cost: costMicros(price, 100, 2000),
      accepted: false,
    });
    const batch = { name: "B1" as const, sites: [write], totalMax: 1_000_000 };
    lines.length = 0;
    const code = await runPlanned(batch, transport(reply), dir(), log);
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(
      /MAX_TOKENS \| 0 \| 2000 \| \d+ \| REJECTED[\s\S]*finishReason MAX_TOKENS, cost so far [1-9]/,
    );
  });

  it("caps a run at the batch's own estimated max, not the default cap", async () => {
    const small = (id: string): PlannedSite => ({
      ...write,
      id,
      maxMicros: 1000,
    });
    const batch = {
      name: "B1" as const,
      sites: [small("first"), small("second")],
      totalMax: 2000,
    };
    const reply = {
      candidates: [
        { finishReason: "STOP", content: { parts: [{ text: "{}" }] } },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1000 },
    };
    const sent: string[] = [];
    lines.length = 0;
    const code = await runPlanned(batch, transport(reply, sent), dir(), log);
    expect(code).toBe(1);
    expect(sent).toHaveLength(1);
    expect(lines.join("\n")).toMatch(/STOP before second/);
  });

  it("refuses a reject dir outside the temp dir before sending anything", async () => {
    const sent: string[] = [];
    const batch = { name: "B1" as const, sites: [write], totalMax: 1_000_000 };
    await expect(
      runPlanned(batch, transport({}, sent), process.cwd(), log),
    ).rejects.toThrow(/temp dir/);
    expect(sent).toEqual([]);
  });
});
