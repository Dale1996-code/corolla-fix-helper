// Chunk window geometry, shared by the chunker and the applicability tagger.
//
// documentChunkService cuts each page into fixed word windows. The tagger (N5)
// has to know where every stored chunk starts inside its page -- to read the
// scope in effect at a chunk's first word -- and it rebuilds page text from the
// stored chunks without re-extracting PDFs. Both are only correct if they use the
// chunker's exact numbers, so the numbers live here, once.
//
// Pure leaf: imports nothing.

export const CHUNK_WORD_SIZE = 200;
export const CHUNK_WORD_OVERLAP = 40;
export const CHUNK_WORD_STEP = CHUNK_WORD_SIZE - CHUNK_WORD_OVERLAP;

/**
 * Split text into the words the chunker counts: any run of whitespace is one
 * separator. Moved unchanged from documentChunkService.
 *
 * @param {unknown} text
 * @returns {string[]}
 */
export function normalizeChunkWords(text) {
  if (typeof text !== "string") {
    return [];
  }

  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word) => word.trim())
    .filter(Boolean);
}

/** Index, in the page's word list, of the first word of chunk `chunkIndex`. */
export function chunkStartWordIndex(chunkIndex) {
  return chunkIndex * CHUNK_WORD_STEP;
}

/**
 * Rebuild a page's words from its stored chunks, in chunk order: all of chunk 0,
 * then each later chunk minus the words it shares with the one before.
 *
 * @param {string[]} chunkTexts
 * @returns {string[]}
 */
export function reconstructPageWords(chunkTexts) {
  const words = [];

  chunkTexts.forEach((chunkText, index) => {
    const chunkWords = normalizeChunkWords(chunkText);
    words.push(...(index === 0 ? chunkWords : chunkWords.slice(CHUNK_WORD_OVERLAP)));
  });

  return words;
}
