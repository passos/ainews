import {
  FUNDING_SECTORS,
  type FundingSector,
  type FundingStage,
} from "./types";

const ORG_SUFFIX =
  /\b(inc|incorporated|corp|corporation|llc|ltd|limited|co|gmbh|ag|sa|pbc|plc)\b\.?/g;

/**
 * Same company, same key: lower case, legal-form suffix removed, every run
 * of non-alphanumerics becomes one hyphen. Deterministic; no model.
 */
export function normalizeCompanyKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(ORG_SUFFIX, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Round key. Series letters are kept (`series_d`, `series_e`) so two real
 * rounds do not collapse into one; `stageForRoundKey` buckets D and later.
 * Anything unrecognised is `undisclosed`.
 */
export function normalizeRoundKey(raw: string): string {
  const s = raw.toLowerCase().replace(/[_-]/g, " ").trim();
  if (/\bpre[\s-]?seed\b/.test(s)) return "pre_seed";
  if (/\bseed\b/.test(s)) return "seed";
  const series = s.match(/\bseries\s+([a-z])\b/);
  if (series) return `series_${series[1]}`;
  if (/\bgrant\b/.test(s)) return "grant";
  if (/\b(debt|loan|credit facility|convertible note|venture debt)\b/.test(s)) {
    return "debt";
  }
  if (/\b(growth|late[\s-]?stage|pre[\s-]?ipo|strategic)\b/.test(s)) {
    return "growth";
  }
  return "undisclosed";
}

export function stageForRoundKey(roundKey: string): FundingStage {
  switch (roundKey) {
    case "pre_seed":
    case "seed":
    case "growth":
    case "grant":
    case "debt":
    case "undisclosed":
      return roundKey;
    case "series_a":
    case "series_b":
    case "series_c":
      return roundKey;
    default:
      return /^series_[d-z]$/.test(roundKey) ? "series_d_plus" : "undisclosed";
  }
}

export function normalizeSector(raw: string | null | undefined): FundingSector {
  const slug = (raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (FUNDING_SECTORS as readonly string[]).includes(slug)
    ? (slug as FundingSector)
    : "other";
}

/** Fixed approximate FX rates, represented as integer micro-USD per native unit. */
const MICRO_USD_PER_UNIT: Record<string, bigint> = {
  USD: 1_000_000n,
  EUR: 1_080_000n,
  GBP: 1_300_000n,
  CNY: 140_000n,
  JPY: 6_700n,
  CAD: 730_000n,
};

/** Exact arithmetic for the configured FX rates; null means unsupported input. */
export function convertToMicroUsdExact(
  amount: number,
  currency: string,
): bigint | null {
  const factor = MICRO_USD_PER_UNIT[currency.toUpperCase()];
  return factor !== undefined && Number.isSafeInteger(amount) && amount >= 0
    ? BigInt(amount) * factor
    : null;
}

/** Safe-number cache only. Public totals always recompute from native facts. */
export function convertToMicroUsd(
  amount: number,
  currency: string,
): number | null {
  const exact = convertToMicroUsdExact(amount, currency);
  return exact !== null && exact <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(exact)
    : null;
}

/** Sorted, de-duplicated by case-insensitive name; first spelling wins. */
export function mergeNames(a: string[], b: string[]): string[] {
  const seen = new Map<string, string>();
  for (const name of [...a, ...b]) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const k = trimmed.toLowerCase();
    if (!seen.has(k)) seen.set(k, trimmed);
  }
  return [...seen.values()].sort((x, y) => x.localeCompare(y));
}
