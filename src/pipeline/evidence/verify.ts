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

/**
 * Normalizes text by collapsing all whitespace to single spaces and trimming.
 */
export function normalizeWhitespace(str: string): string {
  return str.replace(/\s+/g, " ").trim();
}

/**
 * Strips basic Markdown formatting while tracking exact character indices back to the original text.
 * Uses bounded Int32Array mapping to avoid call stack limits or unbounded memory on large documents.
 */
export function cleanMarkdownWithMap(str: string): CleanMarkdownMapResult {
  let len = str.length;
  let map = new Int32Array(len);
  for (let i = 0; i < len; i++) {
    map[i] = i;
  }

  // Step 1: Images !\[([^\]]*)\]\([^)]*\)
  const imgMatches = Array.from(str.matchAll(/!\[([^\]]*)\]\([^)]*\)/g));
  if (imgMatches.length > 0) {
    const parts: string[] = [];
    const nextMap = new Int32Array(len);
    let dest = 0;
    let lastIndex = 0;
    for (const m of imgMatches) {
      if (m.index === undefined) continue;
      if (m.index > lastIndex) {
        parts.push(str.slice(lastIndex, m.index));
        const count = m.index - lastIndex;
        nextMap.set(map.subarray(lastIndex, m.index), dest);
        dest += count;
      }
      const alt = m[1];
      if (alt.length > 0) {
        const altStart = m.index + 2;
        parts.push(alt);
        nextMap.set(map.subarray(altStart, altStart + alt.length), dest);
        dest += alt.length;
      }
      lastIndex = m.index + m[0].length;
    }
    if (lastIndex < len) {
      parts.push(str.slice(lastIndex));
      const count = len - lastIndex;
      nextMap.set(map.subarray(lastIndex, len), dest);
      dest += count;
    }
    str = parts.join("");
    map = nextMap.subarray(0, dest);
    len = dest;
  }

  // Step 2: Links \[([^\]]+)\]\([^)]*\)
  const linkMatches = Array.from(str.matchAll(/\[([^\]]+)\]\([^)]*\)/g));
  if (linkMatches.length > 0) {
    const parts: string[] = [];
    const nextMap = new Int32Array(len);
    let dest = 0;
    let lastIndex = 0;
    for (const m of linkMatches) {
      if (m.index === undefined) continue;
      if (m.index > lastIndex) {
        parts.push(str.slice(lastIndex, m.index));
        const count = m.index - lastIndex;
        nextMap.set(map.subarray(lastIndex, m.index), dest);
        dest += count;
      }
      const linkText = m[1];
      if (linkText.length > 0) {
        const linkStart = m.index + 1;
        parts.push(linkText);
        nextMap.set(map.subarray(linkStart, linkStart + linkText.length), dest);
        dest += linkText.length;
      }
      lastIndex = m.index + m[0].length;
    }
    if (lastIndex < len) {
      parts.push(str.slice(lastIndex));
      const count = len - lastIndex;
      nextMap.set(map.subarray(lastIndex, len), dest);
      dest += count;
    }
    str = parts.join("");
    map = nextMap.subarray(0, dest);
    len = dest;
  }

  // Step 3 & 4: Markdown styling symbols [*_~`#] + whitespace collapse \s+
  const outChars: string[] = [];
  const outIndices = new Int32Array(len);
  let outLen = 0;
  let inWs = false;

  for (let i = 0; i < len; i++) {
    let ch = str[i];
    if (ch === "*" || ch === "_" || ch === "~" || ch === "`" || ch === "#") {
      ch = " ";
    }
    if (/\s/.test(ch)) {
      if (!inWs) {
        outChars.push(" ");
        outIndices[outLen++] = map[i];
        inWs = true;
      }
    } else {
      outChars.push(ch);
      outIndices[outLen++] = map[i];
      inWs = false;
    }
  }

  // Step 5: Trim leading and trailing whitespace
  let start = 0;
  while (start < outLen && outChars[start] === " ") {
    start++;
  }
  let end = outLen;
  while (end > start && outChars[end - 1] === " ") {
    end--;
  }

  const cleanText = outChars.slice(start, end).join("");
  const finalIndices = Array.from(outIndices.subarray(start, end));

  return {
    cleanText,
    origIndices: finalIndices,
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
