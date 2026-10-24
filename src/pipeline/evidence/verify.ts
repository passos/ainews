import type { ConsensusStatus, EvidenceStance } from "../../lib/evidence/types";

export interface VerifiedQuoteResult {
  verified: boolean;
  startOffset: number;
  endOffset: number;
  quoteClean: string;
}

/**
 * Normalizes text by collapsing all whitespace to single spaces and trimming.
 */
export function normalizeWhitespace(str: string): string {
  return str.replace(/\s+/g, " ").trim();
}

/**
 * Normalizes Markdown text for text comparison by stripping basic Markdown formatting
 * and collapsing whitespace.
 */
export function cleanMarkdown(str: string): string {
  return str
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // Images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // Links
    .replace(/[*_~`#]/g, " ") // Markdown styling symbols
    .replace(/\s+/g, " ")
    .trim();
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

  // 2. Normalized whitespace search with word-boundary awareness
  const bodyClean = cleanMarkdown(bodyMd);
  let cleanIndex = bodyClean.indexOf(quoteClean);

  while (cleanIndex !== -1) {
    const charBefore = cleanIndex > 0 ? bodyClean[cleanIndex - 1] : " ";
    const charAfter =
      cleanIndex + quoteClean.length < bodyClean.length
        ? bodyClean[cleanIndex + quoteClean.length]
        : " ";

    if (!isWordChar(charBefore) && !isWordChar(charAfter)) {
      // Map clean match back to approximate offsets in bodyMd
      // Find key anchor phrases (first 25 chars of clean quote) in bodyMd
      const anchor = quoteClean.slice(0, Math.min(25, quoteClean.length));
      let anchorIndex = bodyMd.indexOf(anchor);
      if (anchorIndex === -1) {
        // If exact anchor not found, fallback to ratio estimation
        const ratio = cleanIndex / Math.max(1, bodyClean.length);
        anchorIndex = Math.floor(ratio * bodyMd.length);
      }

      const startOffset = Math.max(0, anchorIndex);
      const endOffset = Math.min(
        bodyMd.length,
        startOffset + quoteTrimmed.length,
      );

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
