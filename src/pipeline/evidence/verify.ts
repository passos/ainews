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

function parseImagesLinear(
  str: string,
  map: Int32Array<ArrayBufferLike>,
): { str: string; map: Int32Array<ArrayBufferLike> } {
  const len = str.length;
  const parts: string[] = [];
  const nextMap = new Int32Array(len);
  let dest = 0;
  let lastIndex = 0;
  let i = 0;

  while (i < len) {
    if (str[i] === "!" && i + 1 < len && str[i + 1] === "[") {
      const closeBracket = str.indexOf("]", i + 2);
      if (closeBracket === -1) break;
      if (closeBracket + 1 < len && str[closeBracket + 1] === "(") {
        const closeParen = str.indexOf(")", closeBracket + 2);
        if (closeParen !== -1) {
          if (i > lastIndex) {
            parts.push(str.slice(lastIndex, i));
            const count = i - lastIndex;
            nextMap.set(map.subarray(lastIndex, i), dest);
            dest += count;
          }
          const altLen = closeBracket - (i + 2);
          if (altLen > 0) {
            parts.push(str.slice(i + 2, closeBracket));
            nextMap.set(map.subarray(i + 2, closeBracket), dest);
            dest += altLen;
          }
          i = closeParen + 1;
          lastIndex = i;
          continue;
        }
      }
    }
    i++;
  }

  if (lastIndex < len) {
    parts.push(str.slice(lastIndex));
    const count = len - lastIndex;
    nextMap.set(map.subarray(lastIndex, len), dest);
    dest += count;
  }

  return { str: parts.join(""), map: nextMap.subarray(0, dest) };
}

function parseLinksLinear(
  str: string,
  map: Int32Array<ArrayBufferLike>,
): { str: string; map: Int32Array<ArrayBufferLike> } {
  const len = str.length;
  const parts: string[] = [];
  const nextMap = new Int32Array(len);
  let dest = 0;
  let lastIndex = 0;
  let i = 0;

  while (i < len) {
    if (str[i] === "[") {
      const closeBracket = str.indexOf("]", i + 1);
      if (closeBracket === -1) break;
      if (
        closeBracket > i + 1 &&
        closeBracket + 1 < len &&
        str[closeBracket + 1] === "("
      ) {
        const closeParen = str.indexOf(")", closeBracket + 2);
        if (closeParen !== -1) {
          if (i > lastIndex) {
            parts.push(str.slice(lastIndex, i));
            const count = i - lastIndex;
            nextMap.set(map.subarray(lastIndex, i), dest);
            dest += count;
          }
          const textLen = closeBracket - (i + 1);
          parts.push(str.slice(i + 1, closeBracket));
          nextMap.set(map.subarray(i + 1, closeBracket), dest);
          dest += textLen;
          i = closeParen + 1;
          lastIndex = i;
          continue;
        }
      }
    }
    i++;
  }

  if (lastIndex < len) {
    parts.push(str.slice(lastIndex));
    const count = len - lastIndex;
    nextMap.set(map.subarray(lastIndex, len), dest);
    dest += count;
  }

  return { str: parts.join(""), map: nextMap.subarray(0, dest) };
}

/**
 * Strips basic Markdown formatting while tracking exact character indices back to the original text.
 * Uses bounded Int32Array mapping to avoid call stack limits or unbounded memory on large documents.
 */
export function cleanMarkdownWithMap(rawStr: string): CleanMarkdownMapResult {
  const initialLen = rawStr.length;
  let map: Int32Array<ArrayBufferLike> = new Int32Array(initialLen);
  for (let i = 0; i < initialLen; i++) {
    map[i] = i;
  }

  // Step 1: Images !\[([^\]]*)\]\([^)]*\) in O(N)
  const resImages = parseImagesLinear(rawStr, map);
  const strImages = resImages.str;
  map = resImages.map;

  // Step 2: Links \[([^\]]+)\]\([^)]*\) in O(N)
  const resLinks = parseLinksLinear(strImages, map);
  const str = resLinks.str;
  map = resLinks.map;
  const len = str.length;

  // Step 3 & 4: Markdown styling symbols + whitespace collapse \s+
  const outChars: string[] = [];
  const outIndices = new Int32Array(len);
  let outLen = 0;
  let inWs = false;
  let atLineStart = true;
  const isWordChar = (c: string) => /[\p{L}\p{N}]/u.test(c);

  for (let i = 0; i < len; i++) {
    const ch = str[i];

    // Markdown heading check: # at line start followed by # and whitespace
    if (atLineStart && ch === "#") {
      let j = i;
      while (j < len && str[j] === "#") j++;
      if (j < len && (str[j] === " " || str[j] === "\t")) {
        while (j < len && (str[j] === " " || str[j] === "\t")) j++;
        i = j - 1;
        inWs = true;
        continue;
      }
    }

    if (ch === "\n") {
      atLineStart = true;
      if (!inWs) {
        outChars.push(" ");
        outIndices[outLen++] = map[i];
        inWs = true;
      }
      continue;
    }

    if (/\S/.test(ch)) {
      atLineStart = false;
    }

    // Markdown emphasis symbols: *, ~, `
    // Notice: `#` is NOT an inline symbol (prevents breaking terms like C#)
    let isFormatSymbol = ch === "*" || ch === "~" || ch === "`";
    if (ch === "_") {
      const prev = i > 0 ? str[i - 1] : " ";
      const next = i + 1 < len ? str[i + 1] : " ";
      if (!isWordChar(prev) || !isWordChar(next)) {
        isFormatSymbol = true;
      }
    }

    if (isFormatSymbol) {
      if (!inWs) {
        outChars.push(" ");
        outIndices[outLen++] = map[i];
        inWs = true;
      }
      continue;
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

  // Normalized whitespace search on visible text with full Unicode word-boundary awareness
  const { cleanText: bodyClean, origIndices } = cleanMarkdownWithMap(bodyMd);
  let cleanIndex = bodyClean.indexOf(quoteClean);

  while (cleanIndex !== -1) {
    // Read full Unicode code point before
    const beforeSlice = bodyClean.slice(
      Math.max(0, cleanIndex - 2),
      cleanIndex,
    );
    const charBefore = Array.from(beforeSlice).pop() ?? " ";

    // Read full Unicode code point after
    const endClean = cleanIndex + quoteClean.length;
    const afterSlice = bodyClean.slice(endClean, endClean + 2);
    const charAfter = Array.from(afterSlice)[0] ?? " ";

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
