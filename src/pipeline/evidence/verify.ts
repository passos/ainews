import MarkdownIt from "markdown-it";
import type { ConsensusStatus, EvidenceStance } from "../../lib/evidence/types";
import { normalizeUrl, safeHttpUrl } from "../../lib/url";

const md = new MarkdownIt({ html: false, linkify: false });

function computeLineOffsets(str: string): number[] {
  const offsets = [0];
  for (let i = 0; i < str.length; i++) {
    if (str[i] === "\n") {
      offsets.push(i + 1);
    }
  }
  return offsets;
}

function findLinkClose(
  rawStr: string,
  startPos: number,
  blockEnd: number,
): number {
  let p = rawStr.indexOf("]", startPos);
  if (p === -1 || p >= blockEnd) return startPos;
  p++; // skip ]
  while (p < blockEnd && /\s/.test(rawStr[p])) p++;
  if (p >= blockEnd) return startPos;
  if (rawStr[p] === "(") {
    p++;
    let depth = 1;
    let inAngle = false;
    let inTitleQuote: string | null = null;
    let hasSeenSpace = false;
    while (p < blockEnd && depth > 0) {
      const ch = rawStr[p];
      if (ch === "\\") {
        p += 2;
        continue;
      }
      if (inTitleQuote) {
        if (ch === inTitleQuote || ch === "\n") inTitleQuote = null;
      } else if (inAngle) {
        if (ch === ">") inAngle = false;
      } else {
        if (/\s/.test(ch)) {
          hasSeenSpace = true;
        } else if (hasSeenSpace && (ch === '"' || ch === "'")) {
          inTitleQuote = ch;
        } else if (ch === "<") {
          inAngle = true;
        } else if (ch === "(") {
          depth++;
        } else if (ch === ")") {
          depth--;
        }
      }
      p++;
    }
    return p;
  } else if (rawStr[p] === "[") {
    const end = rawStr.indexOf("]", p + 1);
    return end !== -1 && end < blockEnd ? end + 1 : startPos;
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
  origStarts: number[];
  origEnds: number[];
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
    return { cleanText: "", origIndices: [], origStarts: [], origEnds: [] };
  }

  const tokens = md.parse(rawStr, {});
  const lineOffsets = computeLineOffsets(rawStr);
  const outChars: string[] = [];
  const outStarts: number[] = [];
  const outEnds: number[] = [];
  let inWs = false;

  for (const block of tokens) {
    if (!block.map) continue;
    const startLine = block.map[0];
    const endLine = block.map[1];
    const blockStart = lineOffsets[startLine] ?? 0;
    const blockEnd =
      endLine < lineOffsets.length ? lineOffsets[endLine] : rawStr.length;

    if (block.type === "inline" && block.children) {
      let srcIdx = blockStart;
      for (const token of block.children) {
        if (token.type === "text" || token.type === "code_inline") {
          const content = token.content;
          let s = srcIdx;
          for (let c = 0; c < content.length; c++) {
            const ch = content[c];
            const codePoint = content.codePointAt(c);
            const isSurrogatePair =
              codePoint !== undefined && codePoint > 0xffff;

            while (s < blockEnd && rawStr[s] !== ch) {
              if (rawStr[s] === "&") {
                const semi = rawStr.indexOf(";", s);
                if (semi !== -1 && semi < blockEnd && semi - s <= 10) break;
              }
              s++;
            }

            if (
              isSurrogatePair &&
              s < blockEnd &&
              rawStr[s] === "&" &&
              rawStr[s] !== ch
            ) {
              const semi = rawStr.indexOf(";", s);
              const origStart = s;
              const origEnd = semi !== -1 && semi < blockEnd ? semi + 1 : s + 1;
              s = origEnd;

              outChars.push(content[c]);
              outStarts.push(origStart);
              outEnds.push(origEnd);

              outChars.push(content[c + 1]);
              outStarts.push(origStart);
              outEnds.push(origEnd);

              inWs = false;
              c++; // skip low surrogate
              continue;
            }

            const origStart = s < blockEnd ? s : -1;
            let origEnd = -1;
            if (s < blockEnd) {
              if (rawStr[s] === "&" && rawStr[s] !== ch) {
                const semi = rawStr.indexOf(";", s);
                origEnd = semi !== -1 && semi < blockEnd ? semi + 1 : s + 1;
                s = origEnd;
              } else {
                origEnd = s + 1;
                s++;
              }
            }

            if (/\s/.test(ch)) {
              if (!inWs) {
                outChars.push(" ");
                outStarts.push(origStart);
                outEnds.push(origEnd);
                inWs = true;
              }
            } else {
              outChars.push(ch);
              outStarts.push(origStart);
              outEnds.push(origEnd);
              inWs = false;
            }
          }
          srcIdx = s;
        } else if (token.type === "image") {
          const alt = token.content;
          const imgStart = rawStr.indexOf("![", srcIdx);
          if (imgStart !== -1 && imgStart < blockEnd) {
            let s = imgStart + 2;
            for (let c = 0; c < alt.length; c++) {
              const ch = alt[c];
              const codePoint = alt.codePointAt(c);
              const isSurrogatePair =
                codePoint !== undefined && codePoint > 0xffff;

              while (s < blockEnd && rawStr[s] !== ch) {
                if (rawStr[s] === "&") {
                  const semi = rawStr.indexOf(";", s);
                  if (semi !== -1 && semi < blockEnd && semi - s <= 10) break;
                }
                s++;
              }

              if (
                isSurrogatePair &&
                s < blockEnd &&
                rawStr[s] === "&" &&
                rawStr[s] !== ch
              ) {
                const semi = rawStr.indexOf(";", s);
                const origStart = s;
                const origEnd =
                  semi !== -1 && semi < blockEnd ? semi + 1 : s + 1;
                s = origEnd;

                outChars.push(alt[c]);
                outStarts.push(origStart);
                outEnds.push(origEnd);

                outChars.push(alt[c + 1]);
                outStarts.push(origStart);
                outEnds.push(origEnd);

                inWs = false;
                c++;
                continue;
              }

              const origStart = s < blockEnd ? s : -1;
              let origEnd = -1;
              if (s < blockEnd) {
                if (rawStr[s] === "&" && rawStr[s] !== ch) {
                  const semi = rawStr.indexOf(";", s);
                  origEnd = semi !== -1 && semi < blockEnd ? semi + 1 : s + 1;
                  s = origEnd;
                } else {
                  origEnd = s + 1;
                  s++;
                }
              }

              if (/\s/.test(ch)) {
                if (!inWs) {
                  outChars.push(" ");
                  outStarts.push(origStart);
                  outEnds.push(origEnd);
                  inWs = true;
                }
              } else {
                outChars.push(ch);
                outStarts.push(origStart);
                outEnds.push(origEnd);
                inWs = false;
              }
            }
            srcIdx = findLinkClose(rawStr, s, blockEnd);
          }
        } else if (token.type === "link_close") {
          if (token.markup === "autolink") {
            const closeAngle = rawStr.indexOf(">", srcIdx);
            srcIdx =
              closeAngle !== -1 && closeAngle < blockEnd
                ? closeAngle + 1
                : srcIdx;
          } else {
            srcIdx = findLinkClose(rawStr, srcIdx, blockEnd);
          }
        } else if (token.type === "softbreak" || token.type === "hardbreak") {
          if (!inWs) {
            outChars.push(" ");
            const pos = Math.min(blockEnd - 1, srcIdx);
            outStarts.push(pos);
            outEnds.push(pos + 1);
            inWs = true;
          }
        }
      }
      if (!inWs) {
        outChars.push(" ");
        const pos = Math.min(blockEnd - 1, srcIdx);
        outStarts.push(pos);
        outEnds.push(pos + 1);
        inWs = true;
      }
    } else if (block.type === "fence") {
      const contentStartLine = startLine + 1;
      let s = lineOffsets[contentStartLine] ?? blockStart;
      const content = block.content;
      for (let c = 0; c < content.length; c++) {
        const ch = content[c];
        while (s < blockEnd && rawStr[s] !== ch) {
          s++;
        }
        const origStart = s < blockEnd ? s : -1;
        const origEnd = s < blockEnd ? s + 1 : -1;
        if (s < blockEnd) s++;

        if (/\s/.test(ch)) {
          if (!inWs) {
            outChars.push(" ");
            outStarts.push(origStart);
            outEnds.push(origEnd);
            inWs = true;
          }
        } else {
          outChars.push(ch);
          outStarts.push(origStart);
          outEnds.push(origEnd);
          inWs = false;
        }
      }
      if (!inWs) {
        outChars.push(" ");
        const pos = Math.min(blockEnd - 1, s);
        outStarts.push(pos);
        outEnds.push(pos + 1);
        inWs = true;
      }
    } else if (block.type === "code_block") {
      let s = blockStart;
      const content = block.content;
      for (let c = 0; c < content.length; c++) {
        const ch = content[c];
        while (s < blockEnd && rawStr[s] !== ch) {
          s++;
        }
        const origStart = s < blockEnd ? s : -1;
        const origEnd = s < blockEnd ? s + 1 : -1;
        if (s < blockEnd) s++;

        if (/\s/.test(ch)) {
          if (!inWs) {
            outChars.push(" ");
            outStarts.push(origStart);
            outEnds.push(origEnd);
            inWs = true;
          }
        } else {
          outChars.push(ch);
          outStarts.push(origStart);
          outEnds.push(origEnd);
          inWs = false;
        }
      }
      if (!inWs) {
        outChars.push(" ");
        const pos = Math.min(blockEnd - 1, s);
        outStarts.push(pos);
        outEnds.push(pos + 1);
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

  const origStarts = outStarts.slice(start, end);
  const origEnds = outEnds.slice(start, end);

  return {
    cleanText: outChars.slice(start, end).join(""),
    origIndices: origStarts,
    origStarts,
    origEnds,
  };
}

/**
 * Normalizes Markdown text for text comparison by stripping basic Markdown formatting
 * and collapsing whitespace.
 */
export function cleanMarkdown(str: string): string {
  return cleanMarkdownWithMap(str).cleanText;
}

const ABBREVIATIONS = new Set([
  "dr",
  "mr",
  "mrs",
  "ms",
  "prof",
  "sr",
  "jr",
  "gen",
  "rep",
  "sen",
  "st",
  "rev",
  "inc",
  "ltd",
  "corp",
  "co",
  "vs",
  "etc",
  "al",
  "fig",
  "dept",
  "approx",
  "est",
  "ie",
  "eg",
]);

function isSentenceBoundary(text: string, pos: number): boolean {
  const ch = text[pos];
  if (ch === "\n" || ch === "\r") {
    return true;
  }
  if (ch === "!" || ch === "?") {
    return true;
  }
  if (ch === ".") {
    // Check if part of a number: e.g. '3.5' or '.5'
    const prevChar = pos > 0 ? text[pos - 1] : "";
    const nextChar = pos + 1 < text.length ? text[pos + 1] : "";
    if (/^[\p{N}]$/u.test(prevChar) || /^[\p{N}]$/u.test(nextChar)) {
      return false;
    }

    // Check if ellipsis: '..'
    if (prevChar === "." || nextChar === ".") {
      return false;
    }

    // Check preceding word for abbreviations
    let wordStart = pos - 1;
    while (wordStart >= 0 && /[\p{L}]/u.test(text[wordStart])) {
      wordStart--;
    }
    const word = text.slice(wordStart + 1, pos).toLowerCase();

    // Single letter initial: e.g. 'Dr. Smith', 'John F. Kennedy'
    if (word.length === 1) {
      return false;
    }

    // Known abbreviation: e.g. 'Dr.', 'Prof.', 'Inc.'
    if (ABBREVIATIONS.has(word)) {
      return false;
    }

    // Special check for 'e.g.' and 'i.e.'
    if (pos >= 3 && /^[ei]\.g$/i.test(text.slice(pos - 3, pos))) {
      return false;
    }

    return true;
  }

  return false;
}

function findSentenceStart(text: string, cleanIdx: number): number {
  for (let i = cleanIdx - 1; i >= 0; i--) {
    if (isSentenceBoundary(text, i)) {
      return i + 1;
    }
  }
  return 0;
}

function findSentenceEnd(text: string, fromIndex: number): number {
  for (let i = fromIndex; i < text.length; i++) {
    if (isSentenceBoundary(text, i)) {
      return i;
    }
  }
  return text.length;
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

  function isValidNumericBoundary(
    cleanIdx: number,
    charB: string,
    charA: string,
  ): boolean {
    const quoteStartsDigit = /^[\p{N}]/u.test(quoteClean);
    const quoteStartsCurrency = /^[\p{Sc}]/u.test(quoteClean);
    const quoteEndsDigit = /[\p{N}]$/u.test(quoteClean);

    const beforeText = bodyClean.slice(0, cleanIdx);
    const beforeTrimmed = beforeText.trimEnd();

    if (quoteStartsDigit) {
      // Cannot be preceded by decimal point or thousands separator (.15, 0.15, 1,015)
      if (charB === "." || charB === ",") {
        return false;
      }
      // Cannot strip currency symbol ($15 or $ 15 quoted as 15)
      if (/[\p{Sc}]$/u.test(beforeTrimmed)) {
        return false;
      }
      // Cannot strip minus/plus signs (-15, − 15, - 15, ± 15 quoted as 15)
      if (/[-+−±]$/u.test(beforeTrimmed)) {
        const beforeSign = beforeTrimmed.slice(0, -1).trimEnd();
        if (!/[\p{N}\p{Sc}]$/u.test(beforeSign)) {
          return false;
        }
      }
    }

    if (quoteStartsCurrency) {
      // Cannot be preceded by minus/plus signs (-$15 quoted as $15, −€15 quoted as €15)
      if (/^[-+−±]$/u.test(charB)) {
        return false;
      }
      // Also catch '- $15' where whitespace separates the minus sign from the currency symbol
      if (/[-+−±]$/u.test(beforeTrimmed)) {
        const beforeSign = beforeTrimmed.slice(0, -1).trimEnd();
        if (!/[\p{N}\p{Sc}]$/u.test(beforeSign)) {
          return false;
        }
      }
    }

    // If quote starts with an explicit sign (e.g. -15 or -$15), cannot be preceded by another sign
    const quoteStartsSign = /^[-+−±]/u.test(quoteClean);
    if (quoteStartsSign && /^[-+−±]$/u.test(charB)) {
      return false;
    }

    if (quoteEndsDigit) {
      // Cannot be followed by decimal/thousands separator leading to more digits (15.5, 15,000)
      if (charA === "." || charA === ",") {
        const nextIdx = cleanIdx + quoteClean.length;
        const nextChar = bodyClean.slice(nextIdx + 1, nextIdx + 2);
        if (/^[\p{N}]$/u.test(nextChar)) {
          return false;
        }
      }
      // Cannot cut off percent/permille signs (15% -> 15)
      if (charA === "%" || charA === "‰") {
        return false;
      }
    }

    return true;
  }

  function hasDroppedNegation(cleanIdx: number): boolean {
    const sentenceStart = findSentenceStart(bodyClean, cleanIdx);
    const sentencePrefix = bodyClean.slice(sentenceStart, cleanIdx);
    const negationRegex =
      /(?:\b\w+n['’]t|\bnot|\bcannot|\bnever|\bno|\bneither|\bnor|\bhardly|\bbarely|\bscarcely|\bfailed\s+to|\bfails\s+to|\bdenied|\bdenies|\bwithout)\b/i;

    // If there is no negation in the sentence prefix, no negation was dropped
    if (!negationRegex.test(sentencePrefix)) {
      return false;
    }

    // Identify contrasting clause boundaries that can start a new affirmative clause:
    // 1. Semicolons: ';' (e.g., '; however,', '; nevertheless,')
    // 2. Conjunctions introducing a contrasting coordinate clause: ', but', '; but', '— but', ', yet'
    // Note: Parenthetical ', however,' or ', nevertheless,' without a semicolon does NOT start a new clause.
    const clauseBoundaryRegex =
      /(?:;|[,;—]\s*(?:but|yet|whereas)\b|\bbut\s+(?:it|they|he|she|we|the|this|that)\b)/gi;

    let lastBoundaryEnd = -1;
    let match: RegExpExecArray | null;
    while ((match = clauseBoundaryRegex.exec(sentencePrefix)) !== null) {
      lastBoundaryEnd = match.index + match[0].length;
    }

    const quoteClausePrefix =
      lastBoundaryEnd === -1
        ? sentencePrefix
        : sentencePrefix.slice(lastBoundaryEnd);

    return negationRegex.test(quoteClausePrefix);
  }

  function hasDroppedPostNegation(
    cleanIdx: number,
    quoteLength: number,
  ): boolean {
    const cleanEnd = cleanIdx + quoteLength;
    const sentenceEnd = findSentenceEnd(bodyClean, cleanEnd);
    const sentenceSuffix = bodyClean.slice(cleanEnd, sentenceEnd);

    // If there is a contrasting clause boundary in the suffix (e.g. ", but"),
    // the post-negation only applies if it occurs before that boundary.
    const clauseBoundaryRegex =
      /(?:;|[,;—]\s*(?:but|yet|whereas)\b|\bbut\s+(?:it|they|he|she|we|the|this|that)\b)/gi;
    const boundaryMatch = clauseBoundaryRegex.exec(sentenceSuffix);
    const quoteClauseSuffix =
      boundaryMatch !== null
        ? sentenceSuffix.slice(0, boundaryMatch.index)
        : sentenceSuffix;

    const adverbOrModifier =
      /(?:(?:\b\w+ly\b|\bproven\b|\bproved\b|\bfound\s+to\s+be\b|\bshown\s+to\s+be\b|\bdeemed\b|\bdetermined\s+to\s+be\b|\bdeclared\b|\bcalled\b|\blabeled\b|\bconsidered\b|\bsimply\b|\bquite\b|\butterly\b|\bentirely\b|\bpurely\b|\blargely\b|\baltogether\b|\bso-called\b|\bto\s+be\b)\s+)*/
        .source;

    const disputeTerms =
      /(?:not|unlikely|unproven|unfounded|baseless|false|untrue|incorrect|refuted|debunked|denied|rejected|dismissed|disputed|unsupported|inaccurate|wrong|a\s+myth|a\s+hoax|fake|fabricated|unsubstantiated|unconfirmed|groundless|doubtful|dubious|misleading|flawed|invalid)\b/
        .source;

    const postNegationRegex = new RegExp(
      `(?:\\b(?:is|are|was|were|has\\s+been|have\\s+been|had\\s+been|could\\s+be|would\\s+be|can\\s+be|might\\s+be)\\s+${adverbOrModifier}${disputeTerms}|\\b(?:proved|proven|turned\\s+out|remains?|remained)\\s+${adverbOrModifier}${disputeTerms}|\\b(?:was|were|is|are|been|being)\\s+${adverbOrModifier}(?:denied|refuted|debunked|rejected|dismissed|disputed)\\b|\\b(?:fails?\\s+to|failed\\s+to|lacks?\\s+evidence|lacks?\\s+support|has\\s+no\\s+basis|have\\s+no\\s+basis|had\\s+no\\s+basis)\\b|\\b(?:isn['’]t|wasn['’]t|aren['’]t|weren['’]t|hasn['’]t|haven['’]t|hadn['’]t|couldn['’]t|wouldn['’]t)\\b)`,
      "i",
    );

    return postNegationRegex.test(quoteClauseSuffix);
  }

  // Normalized whitespace search on visible text with full Unicode word-boundary awareness
  const {
    cleanText: bodyClean,
    origStarts,
    origEnds,
  } = cleanMarkdownWithMap(bodyMd);

  const MAX_QUOTE_CANDIDATE_SEARCHES = 100;
  let candidateSearches = 0;

  let cleanIndex = bodyClean.indexOf(quoteClean);

  while (cleanIndex !== -1) {
    if (++candidateSearches > MAX_QUOTE_CANDIDATE_SEARCHES) {
      break;
    }
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

    if (
      !isWordChar(charBefore) &&
      !isWordChar(charAfter) &&
      isValidNumericBoundary(cleanIndex, charBefore, charAfter) &&
      !hasDroppedNegation(cleanIndex) &&
      !hasDroppedPostNegation(cleanIndex, quoteClean.length)
    ) {
      const startOffset = origStarts[cleanIndex];
      const endOffset = origEnds[cleanIndex + quoteClean.length - 1];

      if (
        startOffset >= 0 &&
        endOffset <= bodyMd.length &&
        startOffset < endOffset
      ) {
        return {
          verified: true,
          startOffset,
          endOffset,
          quoteClean,
        };
      }
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
 * Determines claim consensus based on verified and unresolved citations:
 * - "verified": has at least 1 verified support citation, 0 verified dispute citations,
 *   and 0 unresolved (unverified) dispute citations.
 * - "disputed": has both verified support and verified dispute citations.
 * - "unverified": has 0 verified support citations OR has an unresolved dispute citation.
 */
export function evaluateClaimConsensus(
  citations: Array<{ verified: boolean; stance: EvidenceStance }>,
): ConsensusStatus {
  const verifiedSupport = citations.filter(
    (c) => c.verified && c.stance === "support",
  ).length;
  const verifiedDispute = citations.filter(
    (c) => c.verified && c.stance === "dispute",
  ).length;

  if (verifiedSupport > 0 && verifiedDispute > 0) {
    return "disputed";
  }

  // If ANY dispute was extracted but could not be verified in text, the dispute remains
  // unresolved. The claim MUST NOT be promoted to "verified".
  const hasUnresolvedDispute = citations.some(
    (c) => !c.verified && c.stance === "dispute",
  );
  if (hasUnresolvedDispute) {
    return "unverified";
  }

  if (verifiedSupport > 0 && verifiedDispute === 0) {
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

/**
 * Extracts links pointing to whitelisted domains from markdown text.
 */
export function extractWhitelistedUrls(
  markdown: string,
  primaryDomains: string[] = [],
): string[] {
  if (!markdown || primaryDomains.length === 0) {
    return [];
  }

  const foundUrls = new Set<string>();
  const linkMd = new MarkdownIt({ html: false, linkify: true });
  const tokens = linkMd.parse(markdown, {});

  interface MarkdownToken {
    type: string;
    attrs?: Array<[string, string | number]> | null;
    children?: readonly MarkdownToken[] | null;
  }

  function walk(toks: readonly MarkdownToken[]) {
    for (const token of toks) {
      if (token.type === "link_open" && token.attrs) {
        for (const [attrName, attrVal] of token.attrs) {
          if (attrName === "href" && attrVal) {
            foundUrls.add(String(attrVal).trim());
          }
        }
      }
      if (token.children && token.children.length > 0) {
        walk(token.children);
      }
    }
  }

  walk(tokens as unknown as MarkdownToken[]);

  // Also match plain text regex for URLs that might not be hyperlinked
  const urlRegex = /https?:\/\/[^\s)\]>"'<>]+/gi;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(markdown)) !== null) {
    foundUrls.add(match[0].trim());
  }

  const validUrls: string[] = [];
  const seenNormalized = new Set<string>();

  for (const raw of foundUrls) {
    const safe = safeHttpUrl(raw);
    if (!safe) continue;
    try {
      const parsed = new URL(safe);
      if (isPrimarySourceDomain(parsed.hostname, primaryDomains)) {
        const canonical = normalizeUrl(safe) ?? safe;
        if (!seenNormalized.has(canonical)) {
          seenNormalized.add(canonical);
          validUrls.push(safe);
        }
      }
    } catch {
      // ignore invalid URL
    }
  }

  return validUrls;
}

export type RealityCheckStatus =
  | "vendor_only"
  | "independent_verified"
  | "independent_disputed"
  | "unspecified";

export interface RealityCheckCitation {
  verified: boolean;
  sourceRole: "vendor" | "independent";
  stance: "support" | "dispute";
}

/**
 * Evaluates Launch Reality Check status based on citations:
 * - vendor_only: all supporting citations are from vendor, no independent citations
 * - independent_verified: at least one independent citation supports, no independent dispute
 * - independent_disputed: at least one independent citation disputes
 * - unspecified: no verified citations
 */
export function evaluateRealityCheck(
  citations: readonly RealityCheckCitation[],
): RealityCheckStatus {
  const verified = citations.filter((c) => c.verified);
  if (verified.length === 0) {
    return "unspecified";
  }

  // 1. Independent dispute takes precedence
  const hasIndependentDispute = verified.some(
    (c) => c.sourceRole === "independent" && c.stance === "dispute",
  );
  if (hasIndependentDispute) {
    return "independent_disputed";
  }

  // 2. Independent support
  const hasIndependentSupport = verified.some(
    (c) => c.sourceRole === "independent" && c.stance === "support",
  );
  if (hasIndependentSupport) {
    return "independent_verified";
  }

  // 3. Only vendor support (and no independent citations)
  const hasVendorSupport = verified.some(
    (c) => c.sourceRole === "vendor" && c.stance === "support",
  );
  if (hasVendorSupport) {
    return "vendor_only";
  }

  return "unspecified";
}
