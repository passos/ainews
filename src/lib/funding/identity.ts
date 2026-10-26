import { safeHttpUrl } from "../url";
import {
  mergeNames,
  normalizeCompanyKey,
  normalizeRoundKey,
  stageForRoundKey,
} from "./normalize";
import {
  fundingPatchSchema,
  type ConfirmedFundingIdentity,
  type ExtractedRound,
  type FundingFacts,
  type FundingPatch,
} from "./types";

/** An evidence location is accepted only in the approved, versioned body. */
export function validateFundingEvidence(value: unknown, body: string): void {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (
      key === "quote" &&
      (typeof item !== "string" || !item || !body.includes(item))
    )
      throw new Error("Funding evidence quote is absent from approved body");
    validateFundingEvidence(item, body);
  }
}

export function parseAnnouncementDate(raw: string | null): string | null {
  if (!raw) return null;
  let year: number, month: number, day: number;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) [year, month, day] = iso.slice(1).map(Number);
  else {
    const months = [
      "january",
      "february",
      "march",
      "april",
      "may",
      "june",
      "july",
      "august",
      "september",
      "october",
      "november",
      "december",
    ];
    const match = raw
      .trim()
      .match(/^([A-Za-z]+) (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/i);
    const reverse = raw
      .trim()
      .match(/^(\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]+),? (\d{4})$/i);
    if (!match && !reverse) return null;
    const text = (match?.[1] ?? reverse![2]).toLowerCase();
    month =
      months.findIndex((name) => name === text || name.slice(0, 3) === text) +
      1;
    day = Number(match?.[2] ?? reverse![1]);
    year = Number(match?.[3] ?? reverse![3]);
  }
  if (year < 1000 || month < 1 || month > 12 || day < 1) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date.toISOString().slice(0, 10)
    : null;
}

export function concreteFundingRound(raw: string): string | null {
  const text = raw
    .toLowerCase()
    .replace(/[_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const extension = /\bextension\b/.test(text) ? ":extension" : "";
  const label = text
    .replace(/\b(?:extension|round|financing|funding)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const pre = label.match(/^pre\s*(?:series\s*)?([a-z])$/);
  if (pre) return `pre_series_${pre[1]}${extension}`;
  const series = label.match(/^series\s+([a-z])$/) ?? label.match(/^([a-z])$/);
  if (series) return `series_${series[1]}${extension}`;
  for (const known of [
    "pre seed",
    "seed",
    "growth",
    "strategic",
    "debt",
    "grant",
  ]) {
    if (label === known) return `${known.replace(/ /g, "_")}${extension}`;
  }
  return null;
}

export function fundingCompanyHost(raw: string | null): string | null {
  const url = raw && safeHttpUrl(raw);
  return url ? new URL(url).hostname.toLowerCase().replace(/^www\./, "") : null;
}

/** One company key per normalised name. The host is never part of it. */
export function fundingCompanyKey(companyName: string): string | null {
  const name = normalizeCompanyKey(companyName);
  return name ? `entity:${name}` : null;
}

/** An administrator confirmed these facts; the date may be explicitly unknown. */
export function manualFundingIdentity(input: {
  companyName: string;
  roundName: string;
  announcedDate: string | null;
  companyHost: string | null;
}): ConfirmedFundingIdentity | null {
  const companyKey = fundingCompanyKey(input.companyName);
  const concreteRound =
    concreteFundingRound(input.roundName) ??
    input.roundName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  if (!companyKey || !concreteRound) return null;
  return {
    companyKey,
    roundKey: `event:${concreteRound}:${input.announcedDate ?? "unknown"}`,
    companyName: input.companyName.trim(),
    roundName: input.roundName.trim(),
    companyHost: input.companyHost,
    announcedDate: input.announcedDate,
    concreteRound,
    source: "manual",
  };
}

export function automaticFundingIdentity(
  round: ExtractedRound,
): ConfirmedFundingIdentity | null {
  const identity = round.identity;
  const host = fundingCompanyHost(identity.companyHost?.value ?? null);
  const date = parseAnnouncementDate(identity.announcedDate?.value ?? null);
  const concreteRound = concreteFundingRound(identity.roundName.value);
  const companyKey = fundingCompanyKey(identity.companyName.value);
  if (
    !companyKey ||
    !date ||
    !concreteRound ||
    !identity.announcedDate?.evidence.quote.includes(
      identity.announcedDate.value,
    )
  )
    return null;
  // The host is evidence only. A key that includes it only sometimes gives
  // one company two keys.
  return {
    companyKey,
    roundKey: `event:${concreteRound}:${date}`,
    companyName: identity.companyName.value,
    roundName: identity.roundName.value,
    companyHost: host,
    announcedDate: date,
    concreteRound,
    source: "automatic",
  };
}

export function applyFundingPatch(
  base: FundingFacts,
  input: FundingPatch,
  body?: string,
): FundingFacts {
  const patch = fundingPatchSchema.parse(input);
  if (body !== undefined) validateFundingEvidence(patch, body);
  const result = {
    ...base,
    investors: [...base.investors],
    leadInvestors: [...base.leadInvestors],
  };
  for (const key of [
    "companyName",
    "roundName",
    "currency",
    "sector",
    "stage",
  ] as const) {
    const operation = patch[key];
    if (operation) Object.assign(result, { [key]: operation.value });
  }
  for (const key of ["amount", "valuation", "announcedDate"] as const) {
    const operation = patch[key];
    if (operation)
      Object.assign(result, {
        [key]: operation.op === "clear" ? null : operation.value,
      });
  }
  for (const key of ["investors", "leadInvestors"] as const) {
    const operation = patch[key];
    if (!operation) continue;
    result[key] =
      operation.op === "replace"
        ? mergeNames([], operation.values)
        : mergeNames(
            result[key].filter(
              (name) =>
                !operation.remove.some(
                  (removed) => removed.toLowerCase() === name.toLowerCase(),
                ),
            ),
            operation.add,
          );
  }
  return result;
}

export function reportedFundingFacts(
  round: ExtractedRound,
  identity: ConfirmedFundingIdentity,
): FundingFacts {
  const facts = round.reportedFacts;
  const concrete = identity.concreteRound;
  return {
    companyName: identity.companyName,
    roundName: identity.roundName,
    amount: facts.amount?.value ?? null,
    currency: facts.currency?.value ?? "USD",
    valuation: facts.valuation?.value ?? null,
    sector: facts.sector?.value ?? "other",
    stage:
      facts.stage?.value ??
      (concrete.startsWith("pre_series") || concrete.startsWith("strategic")
        ? "undisclosed"
        : stageForRoundKey(normalizeRoundKey(identity.roundName))),
    announcedDate: identity.announcedDate,
    investors: facts.investors?.value ?? [],
    leadInvestors: facts.leadInvestors?.value ?? [],
  };
}
