import MarkdownIt from "markdown-it";
import type { ConsensusStatus, EvidenceStance } from "../../lib/evidence/types";

const md = new MarkdownIt({ html: false, linkify: false });

function findLinkClose(rawStr: string, startPos: number): number {
  let p = rawStr.indexOf("]", startPos);
  if (p === -1) return startPos;
  p++; // skip ]
  while (p < rawStr.length && /\s/.test(rawStr[p])) p++;
  if (p >= rawStr.length) return startPos;
  if (rawStr[p] === "(") {
    p++;
    let depth = 1;
    let inAngle = false;
    let inQuote: string | null = null;
    while (p < rawStr.length && depth > 0) {
      const ch = rawStr[p];
      if (ch === "\\") {
        p += 2;
        continue;
      }
      if (inQuote) {
        if (ch === inQuote) inQuote = null;
      } else if (inAngle) {
        if (ch === ">") inAngle = false;
      } else {
        if (ch === '"' || ch === "'") inQuote = ch;
        else if (ch === "<") inAngle = true;
        else if (ch === "(") depth++;
        else if (ch === ")") depth--;
      }
      p++;
    }
    return p;
  } else if (rawStr[p] === "[") {
    const end = rawStr.indexOf("]", p + 1);
    return end !== -1 ? end + 1 : startPos;
  }
  return p;
}

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
 * Uses the canonical CommonMark markdown-it parser to ensure strict adherence to CommonMark
 * delimiter and formatting rules while maintaining 1:1 original character offset mapping.
 */
export function cleanMarkdownWithMap(rawStr: string): CleanMarkdownMapResult {
  if (!rawStr) {
    return { cleanText: "", origIndices: [] };
  }

  const tokens = md.parse(rawStr, {});
  const outChars: string[] = [];
  const outIndices: number[] = [];
  let inWs = false;
  let srcIdx = 0;

  for (const block of tokens) {
    if (block.type === "inline" && block.children) {
      for (const token of block.children) {
        if (token.type === "text" || token.type === "code_inline") {
          const content = token.content;
          let s = srcIdx;
          for (let c = 0; c < content.length; c++) {
            const ch = content[c];
            while (s < rawStr.length && rawStr[s] !== ch) {
              s++;
            }
            const origIdx = s < rawStr.length ? s : srcIdx + c;
            if (s < rawStr.length) s++;

            if (/\s/.test(ch)) {
              if (!inWs) {
                outChars.push(" ");
                outIndices.push(origIdx);
                inWs = true;
              }
            } else {
              outChars.push(ch);
              outIndices.push(origIdx);
              inWs = false;
            }
          }
          srcIdx = s;
        } else if (token.type === "image") {
          const alt = token.content;
          const imgStart = rawStr.indexOf("![", srcIdx);
          if (imgStart !== -1) {
            let s = imgStart + 2;
            for (let c = 0; c < alt.length; c++) {
              const ch = alt[c];
              while (s < rawStr.length && rawStr[s] !== ch) {
                s++;
              }
              const origIdx = s < rawStr.length ? s : imgStart + 2 + c;
              if (s < rawStr.length) s++;

              if (/\s/.test(ch)) {
                if (!inWs) {
                  outChars.push(" ");
                  outIndices.push(origIdx);
                  inWs = true;
                }
              } else {
                outChars.push(ch);
                outIndices.push(origIdx);
                inWs = false;
              }
            }
            srcIdx = findLinkClose(rawStr, s);
          }
        } else if (token.type === "link_close") {
          srcIdx = findLinkClose(rawStr, srcIdx);
        } else if (token.type === "softbreak" || token.type === "hardbreak") {
          if (!inWs) {
            outChars.push(" ");
            outIndices.push(srcIdx);
            inWs = true;
          }
        }
      }
      if (!inWs) {
        outChars.push(" ");
        outIndices.push(Math.min(rawStr.length - 1, srcIdx));
        inWs = true;
      }
    }
  }

  // Trim leading and trailing whitespace
  let start = 0;
  while (start < outChars.length && outChars[start] === " ") {
    start++;
  }
  let end = outChars.length;
  while (end > start && outChars[end - 1] === " ") {
    end--;
  }

  return {
    cleanText: outChars.slice(start, end).join(""),
    origIndices: outIndices.slice(start, end),
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

  const isWordChar = (c: string) => /[\p{L}\p{N}_]/u.test(c);

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
