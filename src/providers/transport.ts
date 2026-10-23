// How a model request leaves the Worker. models.ts is the only runtime
// caller; scripts/smoke-models.ts uses both transports directly.
//
// No runtime imports here: scripts/smoke-models.ts loads this file in Node.

export interface ModelTransport {
  run(model: string, input: unknown): Promise<unknown>;
}

/**
 * Sends a model to the transport of the first prefix its id starts with
 * (`jina/` -> jinaTransport), else to `fallback`. With no match and no
 * fallback it throws.
 */
export function prefixTransport(
  routes: Record<string, ModelTransport>,
  fallback?: ModelTransport,
): ModelTransport {
  return {
    run(model, input) {
      for (const [prefix, transport] of Object.entries(routes)) {
        if (model.startsWith(prefix)) return transport.run(model, input);
      }
      if (fallback) return fallback.run(model, input);
      return Promise.reject(new Error(`no transport for model ${model}`));
    },
  };
}

export class TransportHttpError extends Error {
  readonly status: number;
  /** First 2,000 characters of the response body. */
  readonly body: string;

  constructor(status: number, body: string) {
    super(`model request failed with HTTP ${status}`);
    this.name = "TransportHttpError";
    this.status = status;
    this.body = body;
  }
}

type GatewayRun = (
  model: string,
  input: unknown,
  options: { gateway: { id: string } },
) => Promise<unknown>;

/** `env.AI.run(model, input, { gateway: { id } })`. */
export function bindingTransport(ai: Ai, gatewayId: string): ModelTransport {
  if (!gatewayId) throw new Error("bindingTransport: gatewayId is empty");
  // The typed overloads only cover models in the generated catalog.
  const run = ai.run.bind(ai) as unknown as GatewayRun;
  return {
    run: (model, input) => run(model, input, { gateway: { id: gatewayId } }),
  };
}

export interface RestTransportOptions {
  accountId: string;
  token: string;
  gatewayId: string;
  fetch?: typeof fetch;
}

/**
 * Workers AI REST API through AI Gateway. Assumption (checked by
 * scripts/smoke-models.ts): the `/ai/run/{model}` path and the
 * `cf-aig-gateway-id` header work for third-party models.
 */
export function restTransport(options: RestTransportOptions): ModelTransport {
  const send = options.fetch ?? fetch;
  return {
    async run(model, input) {
      const response = await send(
        `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/ai/run/${model}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.token}`,
            "cf-aig-gateway-id": options.gatewayId,
            "content-type": "application/json",
          },
          body: JSON.stringify(input),
        },
      );
      const text = await response.text();
      if (!response.ok) {
        throw new TransportHttpError(response.status, text.slice(0, 2000));
      }
      const body: unknown = JSON.parse(text);
      // Cloudflare API envelope: { success, result, errors }.
      if (isRecord(body) && "success" in body && "result" in body) {
        if (body.success !== true) {
          throw new TransportHttpError(response.status, text.slice(0, 2000));
        }
        return body.result;
      }
      return body;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
