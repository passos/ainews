import { createHash } from "node:crypto";
import { BudgetExceededError, type ModelClient } from "../../providers/models";
import type { AnalysisConfig } from "../analyze/config";
import type { SampleArticle } from "./probe";

export interface EvaluationResult {
  sampleScores: number[];
  avgScore: number;
}

export interface ScoreDeps {
  models: ModelClient;
}

function sha256(str: string): string {
  return createHash("sha256").update(str).digest("hex");
}

export async function evaluateCandidateSamples(
  samples: SampleArticle[],
  industryName: string,
  industryConfig: AnalysisConfig,
  deps: ScoreDeps,
): Promise<EvaluationResult> {
  if (samples.length === 0) {
    return { sampleScores: [], avgScore: 0 };
  }

  const sampleScores: number[] = [];

  for (const sample of samples) {
    const inputPayload = JSON.stringify({
      url: sample.url,
      title: sample.title,
      bodySha: sha256(sample.body),
      industry: industryName,
      editorialCriteria: industryConfig.prefilter.relevant,
    });
    const key = `discover_score:${sha256(inputPayload)}`;
    const state = {
      title: sample.title,
      summary: sample.summary ?? "",
      body: sample.body.slice(0, 10_000),
    };

    const questions = {
      relevance: {
        type: "score" as const,
        instructions: `Evaluate how relevant, informative, and valuable this article is for readers of the '${industryName}' section. Editorial focus: ${industryConfig.prefilter.relevant}`,
        criteria: [
          "Completely irrelevant, off-topic, or promotional noise",
          "Tangentially related with very little informational value",
          "Moderately relevant industry news or discussion",
          "High relevance with solid factual developments or insights",
          "Core, high-impact industry reporting of exceptional value",
        ],
      },
    };

    try {
      const answers = (await deps.models.judge(key, state, questions)) as {
        relevance: {
          score?: number;
          confidence?: number;
          probabilities?: Record<string, number>;
        };
      };

      const rel = answers.relevance;
      let score = 50;

      if (rel.probabilities && Object.keys(rel.probabilities).length > 0) {
        let expectedTier = 0;
        let sumP = 0;
        for (let i = 0; i < 5; i++) {
          const p = Number(
            rel.probabilities[String(i)] ?? rel.probabilities[i] ?? 0,
          );
          expectedTier += i * p;
          sumP += p;
        }
        if (sumP > 0) {
          expectedTier = expectedTier / sumP;
          score = Math.round(expectedTier * 25);
        }
      } else if (typeof rel.score === "number") {
        // Fallback if probabilities absent
        score = Math.round(rel.score * 25);
      }

      const clampedScore = Math.max(0, Math.min(100, score));
      sampleScores.push(clampedScore);
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      // If scoring one sample fails for non-budget reasons, don't abort entire evaluation
      sampleScores.push(0);
    }
  }

  const avgScore =
    sampleScores.length > 0
      ? Math.round(
          sampleScores.reduce((sum, s) => sum + s, 0) / sampleScores.length,
        )
      : 0;

  return {
    sampleScores,
    avgScore,
  };
}
