// #102: artifacts/build.ts reads only approved articles of the event.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { generateEventArtifacts } from "../../src/pipeline/artifacts/build";
import type { PipelineEnv } from "../../src/pipeline/messages";
import type { ModelTransport } from "../../src/providers/transport";
import {
  seedArticleInEvent,
  seedEvent,
  seedSection,
} from "./approved-behaviour-helpers";

const testEnv: PipelineEnv = { ...env, MODEL_CALLS_ENABLED: "true" };

describe("generateEventArtifacts approved condition (#102)", () => {
  it("builds the prompt from the approved article only", async () => {
    await env.DB.prepare(
      `INSERT INTO budgets (day, channel, cap_micros, reserved_micros, spent_micros)
       VALUES ('2026-10-24', 'gateway', 10000000, 0, 0)
       ON CONFLICT (day, channel) DO UPDATE SET cap_micros = 10000000`,
    ).run();
    const section = await seedSection();
    const eventId = await seedEvent(section.industryId);
    await seedArticleInEvent(eventId, section, {
      kind: "approved",
      title: "Zebra Approved Headline",
    });
    await seedArticleInEvent(eventId, section, {
      kind: "none",
      title: "Quokka Unreviewed Headline",
    });
    await seedArticleInEvent(eventId, section, {
      kind: "stale",
      title: "Narwhal Stale Headline",
    });

    const prompts: string[] = [];
    const transport: ModelTransport = {
      run: async (_model, input) => {
        prompts.push(JSON.stringify(input));
        return {
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    text: JSON.stringify({
                      whatHappened: "A.",
                      whatIsNew: "B.",
                      whatEvidenceExists: "C.",
                      whatToWatchNext: "D.",
                    }),
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 50,
            candidatesTokenCount: 100,
            totalTokenCount: 150,
          },
        };
      },
    };

    const res = await generateEventArtifacts(testEnv, eventId, 1000, {
      transport,
    });

    expect(res.status).toBe("generated");
    const all = prompts.join("\n");
    expect(all).toContain("Zebra Approved Headline");
    expect(all).not.toContain("Quokka Unreviewed Headline");
    expect(all).not.toContain("Narwhal Stale Headline");
  });
});
