// Example responses, shaped after the examples on each model page. They are
// assumptions until scripts/smoke-models.ts shows the real shapes.

export const anthropicResponse = {
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-5.5",
  content: [
    { type: "text", text: "Hello" },
    { type: "text", text: ", world" },
  ],
  stop_reason: "end_turn",
  usage: { input_tokens: 12, output_tokens: 6 },
};

// Real response from the gateway binding (smoke run, 2026-10-22): a
// thinking model reports thoughtsTokenCount and no candidatesTokenCount.
export const googleResponse = {
  candidates: [
    {
      content: { role: "model", parts: [{ text: "OK" }] },
      finishReason: "STOP",
    },
  ],
  usageMetadata: {
    promptTokenCount: 8,
    totalTokenCount: 102,
    trafficType: "ON_DEMAND",
    promptTokensDetails: [{ modality: "TEXT", tokenCount: 8 }],
    thoughtsTokenCount: 94,
  },
  modelVersion: "gemini-3.8-flash",
  responseId: "x",
};

export const openaiResponse = {
  id: "chatcmpl-1",
  object: "chat.completion",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Bonjour" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
};

// Real response from the Workers AI binding (smoke run, 2026-10-22).
export const jevResponse = {
  state: "Completed",
  result: {
    model: "jev-1.13.0",
    answers: {
      aboutWeather: { type: "noul", noul: 0.99 },
      topic: {
        type: "choice",
        choice: "weather",
        probabilities: { weather: 1, sports: 0 },
        confidence: 1,
      },
      clarity: {
        type: "score",
        score: 1.97,
        legend: { "0": "unclear", "1": "somewhat clear", "2": "clear" },
        probabilities: { "0": 0.01, "1": 0.01, "2": 0.98 },
        confidence: 0.95,
      },
    },
    usage: { input_tokens: 387, output_tokens: 65 },
  },
};

export const embedResponse = {
  shape: [2, 3],
  data: [
    [0.1, 0.2, 0.3],
    [0.4, 0.5, 0.6],
  ],
};

export function fixtureFor(model: string): unknown {
  if (model.startsWith("anthropic/")) return anthropicResponse;
  if (model.startsWith("google/")) return googleResponse;
  if (model.startsWith("openai/")) return openaiResponse;
  if (model === "typesafe/jev") return jevResponse;
  if (model === "@cf/baai/bge-m3") return embedResponse;
  throw new Error(`no fixture for ${model}`);
}
