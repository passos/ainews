import type { ModelClient } from "../../providers/models";

export interface TextChunk {
  text: string;
  start: number;
  end: number;
  index: number;
}

export interface ChunkIndexDeps {
  vectors?: Pick<VectorizeIndex, "upsert">;
  models: Pick<ModelClient, "embed">;
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Splits Markdown body into semantic paragraph chunks with start/end character offsets.
 * Ideal target chunk size: ~800-1200 characters (~200-300 tokens) with paragraph boundaries.
 */
export function chunkMarkdownBody(
  bodyMd: string,
  targetSize = 1000,
  maxSize = 1500,
): TextChunk[] {
  if (!bodyMd || bodyMd.trim().length === 0) {
    return [];
  }

  const chunks: TextChunk[] = [];
  // Split on paragraph boundaries while tracking absolute character indices
  const paragraphRegex = /\n\s*\n+/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  interface ParagraphSpan {
    text: string;
    start: number;
    end: number;
  }
  const paragraphs: ParagraphSpan[] = [];

  while ((match = paragraphRegex.exec(bodyMd)) !== null) {
    const pText = bodyMd.slice(lastIndex, match.index);
    if (pText.trim().length > 0) {
      paragraphs.push({
        text: pText,
        start: lastIndex,
        end: match.index,
      });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < bodyMd.length) {
    const trailing = bodyMd.slice(lastIndex);
    if (trailing.trim().length > 0) {
      paragraphs.push({
        text: trailing,
        start: lastIndex,
        end: bodyMd.length,
      });
    }
  }

  // If text has no multiple paragraphs, consider the whole text
  if (paragraphs.length === 0) {
    paragraphs.push({
      text: bodyMd,
      start: 0,
      end: bodyMd.length,
    });
  }

  // Group paragraphs into target chunks
  let currentGroup: ParagraphSpan[] = [];
  let currentLen = 0;

  const flushGroup = () => {
    if (currentGroup.length === 0) return;
    const start = currentGroup[0].start;
    const end = currentGroup[currentGroup.length - 1].end;
    const text = bodyMd.slice(start, end).trim();
    if (text.length > 0) {
      chunks.push({
        text,
        start,
        end,
        index: chunks.length,
      });
    }
    currentGroup = [];
    currentLen = 0;
  };

  for (const p of paragraphs) {
    // If a single paragraph is larger than maxSize, break it into fixed slices
    if (p.text.length > maxSize) {
      flushGroup();
      let pOffset = 0;
      while (pOffset < p.text.length) {
        const sliceEnd = Math.min(pOffset + targetSize, p.text.length);
        const sliceText = p.text.slice(pOffset, sliceEnd);
        chunks.push({
          text: sliceText,
          start: p.start + pOffset,
          end: p.start + sliceEnd,
          index: chunks.length,
        });
        pOffset += targetSize - 100; // 100 char overlap
        if (pOffset >= p.text.length) break;
      }
      continue;
    }

    if (currentLen + p.text.length > targetSize && currentGroup.length > 0) {
      flushGroup();
    }

    currentGroup.push(p);
    currentLen += p.text.length;
  }

  flushGroup();
  return chunks;
}

/**
 * Embeds and indexes article chunks into Vectorize `V_CHUNKS`.
 * Enforces Vectorize 1000 items per upsert batch limit.
 */
export async function indexArticleChunks(
  deps: ChunkIndexDeps,
  articleId: number,
  bodySha: string,
  bodyMd: string,
): Promise<number> {
  if (!deps.vectors) {
    return 0;
  }

  const chunks = chunkMarkdownBody(bodyMd);
  if (chunks.length === 0) {
    return 0;
  }

  // Chunk batches of up to 50 for embedding calculation
  const EMBED_BATCH_SIZE = 50;
  const vectorsToUpsert: Array<{
    id: string;
    values: number[];
    metadata: {
      article_id: number;
      body_sha: string;
      chunk_index: number;
      start: number;
      end: number;
    };
  }> = [];

  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const slice = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const texts = slice.map((c) => c.text);
    const sliceSha = (await sha256Hex(texts.join("\n"))).slice(0, 8);
    const embedKey = `embed:chunk:${articleId}:${i}:${sliceSha}`;
    const embeddings = await deps.models.embed(embedKey, texts);

    for (let j = 0; j < slice.length; j++) {
      const chunk = slice[j];
      const vector = embeddings[j];
      if (!vector || vector.length === 0) continue;

      const chunkSha = (await sha256Hex(chunk.text)).slice(0, 8);
      // Vector ID is deterministic and strictly < 64 bytes (e.g. c_123_0_a1b2c3d4)
      const vectorId = `c_${articleId}_${chunk.index}_${chunkSha}`;

      vectorsToUpsert.push({
        id: vectorId,
        values: vector,
        metadata: {
          article_id: articleId,
          body_sha: bodySha,
          chunk_index: chunk.index,
          start: chunk.start,
          end: chunk.end,
        },
      });
    }
  }

  // Upsert to Vectorize in batches of max 1000
  const VECTORIZE_MAX_BATCH = 1000;
  for (let i = 0; i < vectorsToUpsert.length; i += VECTORIZE_MAX_BATCH) {
    const batch = vectorsToUpsert.slice(i, i + VECTORIZE_MAX_BATCH);
    await deps.vectors.upsert(batch);
  }

  return vectorsToUpsert.length;
}
