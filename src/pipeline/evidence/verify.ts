import type { ConsensusStatus, EvidenceStance } from "../../lib/evidence/types";

export interface VerifiedQuoteResult {
  verified: boolean;
  startOffset: number;
  endOffset: number;
  quoteClean: string;
}

export interface CleanMarkdownMapResult {
  cleanText: string;
  origIndices: number[];
}

interface CharEntry {
  char: string;
  origIndex: number;
}

/**
 * Normalizes text by collapsing all whitespace to single spaces and trimming.
 */
export function normalizeWhitespace(str: string): string {
  return str.replace(/\s+/g, " ").trim();
}

/**
 * Strips basic Markdown formatting while tracking exact character indices back to the original text.
 */
export function cleanMarkdownWithMap(str: string): CleanMarkdownMapResult {
  let entries: CharEntry[] = [];
  for (let i = 0; i < str.length; i++) {
    entries.push({ char: str[i], origIndex: i });
  }

  // Step 1: Images !\[([^\]]*)\]\([^)]*\)
  let currentStr = entries.map((e) => e.char).join("");
  const imgMatches = Array.from(currentStr.matchAll(/!\[([^\]]*)\]\([^)]*\)/g));
  if (imgMatches.length > 0) {
    const newEntries: CharEntry[] = [];
    let lastIndex = 0;
    for (const m of imgMatches) {
      if (m.index === undefined) continue;
      newEntries.push(...entries.slice(lastIndex, m.index));
      const altText = m[1];
      newEntries.push(
        ...entries.slice(m.index + 2, m.index + 2 + altText.length),
      );
      lastIndex = m.index + m[0].length;
    }
    newEntries.push(...entries.slice(lastIndex));
    entries = newEntries;
  }

  // Step 2: Links \[([^\]]+)\]\([^)]*\)
  currentStr = entries.map((e) => e.char).join("");
  const linkMatches = Array.from(currentStr.matchAll(/\[([^\]]+)\]\([^)]*\)/g));
  if (linkMatches.length > 0) {
    const newEntries: CharEntry[] = [];
    let lastIndex = 0;
    for (const m of linkMatches) {
      if (m.index === undefined) continue;
      newEntries.push(...entries.slice(lastIndex, m.index));
      const linkText = m[1];
      newEntries.push(
        ...entries.slice(m.index + 1, m.index + 1 + linkText.length),
      );
      lastIndex = m.index + m[0].length;
    }
    newEntries.push(...entries.slice(lastIndex));
    entries = newEntries;
  }

  // Step 3: Markdown styling symbols [*_~`#]
  for (const entry of entries) {
    if (/[*_~`#]/.test(entry.char)) {
      entry.char = " ";
    }
  }

  // Step 4: Whitespace collapse \s+
  const collapsed: CharEntry[] = [];
  let inWs = false;
  for (const entry of entries) {
    if (/\s/.test(entry.char)) {
      if (!inWs) {
        collapsed.push({ char: " ", origIndex: entry.origIndex });
        inWs = true;
      }
    } else {
      collapsed.push(entry);
      inWs = false;
    }
  }

  // Step 5: Trim leading and trailing whitespace
  let start = 0;
  while (start < collapsed.length && collapsed[start].char === " ") {
    start++;
  }
  let end = collapsed.length;
  while (end > start && collapsed[end - 1].char === " ") {
    end--;
  }

  const trimmed = collapsed.slice(start, end);
  return {
    cleanText: trimmed.map((e) => e.char).join(""),
    origIndices: trimmed.map((e) => e.origIndex),
  };
}

/**
 * Normalizes Markdown text for text comparison by stripping basic Markdown formatting
 * and collapsing whitespace.
 */
export function cleanMarkdown(str: string): string {
  return cleanMarkdownWithMap(str).cleanText;
}

/**
 * Verifies that a quoted passage actually appears in the original markdown body.
 * Enforces minimum length of 15 characters and word boundary safety.
 * Returns exact start and end offsets in the original markdown body.
 */
export function verifyQuoteInBody(
  bodyMd: string,
  rawQuote: string,
): VerifiedQuoteResult {
  const quoteTrimmed = rawQuote.trim();
  const quoteClean = normalizeWhitespace(cleanMarkdown(rawQuote));

  // Reject quotes shorter than 15 characters to prevent accidental trivial matches
  if (quoteClean.length < 15 || !bodyMd) {
    return {
      verified: false,
      startOffset: 0,
      endOffset: 0,
      quoteClean,
    };
  }

  const isWordChar = (c: string) => /[\p{L}\p{N}]/u.test(c);

  // 1. Direct exact substring match in original markdown body with word boundary safety
  let directIndex = bodyMd.indexOf(quoteTrimmed);
  while (directIndex !== -1) {
    const charBefore = directIndex > 0 ? bodyMd[directIndex - 1] : " ";
    const charAfter =
      directIndex + quoteTrimmed.length < bodyMd.length
        ? bodyMd[directIndex + quoteTrimmed.length]
        : " ";
    if (!isWordChar(charBefore) && !isWordChar(charAfter)) {
      return {
        verified: true,
        startOffset: directIndex,
        endOffset: directIndex + quoteTrimmed.length,
        quoteClean,
      };
    }
    directIndex = bodyMd.indexOf(quoteTrimmed, directIndex + 1);
  }

  // 2. Normalized whitespace search with word-boundary awareness and exact character mapping
  const { cleanText: bodyClean, origIndices } = cleanMarkdownWithMap(bodyMd);
  let cleanIndex = bodyClean.indexOf(quoteClean);

  while (cleanIndex !== -1) {
    const charBefore = cleanIndex > 0 ? bodyClean[cleanIndex - 1] : " ";
    const charAfter =
      cleanIndex + quoteClean.length < bodyClean.length
        ? bodyClean[cleanIndex + quoteClean.length]
        : " ";

    if (!isWordChar(charBefore) && !isWordChar(charAfter)) {
      const startOffset = origIndices[cleanIndex];
      const endOffset = origIndices[cleanIndex + quoteClean.length - 1] + 1;

      return {
        verified: true,
        startOffset,
        endOffset,
        quoteClean,
      };
    }

    cleanIndex = bodyClean.indexOf(quoteClean, cleanIndex + 1);
  }

  return {
    verified: false,
    startOffset: 0,
    endOffset: 0,
    quoteClean,
  };
}

/**
 * Determines claim consensus based on verified citations:
 * - "verified": has at least 1 verified support citation and 0 dispute citations.
 * - "disputed": has both verified support and dispute citations.
 * - "unverified": has 0 verified support citations.
 */
export function evaluateClaimConsensus(
  citations: Array<{ verified: boolean; stance: EvidenceStance }>,
): ConsensusStatus {
  const verifiedCitations = citations.filter((c) => c.verified);
  if (verifiedCitations.length === 0) {
    return "unverified";
  }

  const supportCount = verifiedCitations.filter(
    (c) => c.stance === "support",
  ).length;
  const disputeCount = verifiedCitations.filter(
    (c) => c.stance === "dispute",
  ).length;

  if (supportCount > 0 && disputeCount > 0) {
    return "disputed";
  }

  if (supportCount > 0 && disputeCount === 0) {
    return "verified";
  }

  return "unverified";
}

/**
 * Checks if a given domain or hostname matches an industry's primary domains.
 */
export function isPrimarySourceDomain(
  domain: string,
  primaryDomains: string[] = [],
): boolean {
  if (!domain || primaryDomains.length === 0) {
    return false;
  }

  const normalizedDomain = domain.toLowerCase().trim();
  return primaryDomains.some((pd) => {
    const target = pd.toLowerCase().trim();
    return (
      normalizedDomain === target || normalizedDomain.endsWith(`.${target}`)
    );
  });
}
