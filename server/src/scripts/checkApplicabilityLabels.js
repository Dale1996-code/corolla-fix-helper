// npm --prefix server run check:applicability-labels -- --sample [--out DIR]
// npm --prefix server run check:applicability-labels -- --labels FILE [--out DIR]
//
// The blind acceptance check for the N5 applicability tagger (P1). STRICTLY
// READ-ONLY: the database is opened readOnly, nothing calls a model, and the
// only files written go to server/data/applicability-labels/ (gitignored),
// because candidates and labels quote real manual text.
//
// --sample   picks unit-bearing figures from the real corpus and writes them,
//            WITHOUT the tagger's verdict, to candidates.jsonl for a person (or
//            an agent who has not seen the tagger) to label: which engine does
//            this figure belong to -- "2ZR-FE", "2AZ-FE", "both", "none", or
//            "unclear".
// --labels   scores a labeled file against the tagger. It fails (exit 1) if any
//            2AZ-FE figure is judged to apply to the 2ZR-FE, or more than 5% of
//            the owner's own figures are judged to belong to another engine.
//            Labels are written relative to the owner's 2ZR-FE, so the profile
//            here is fixed and does not read Settings.

import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config } from "../config.js";
import {
  KNOWN_ENGINE_CODES,
  hasAccountHeader,
  blankAccountHeader,
  classifyScope,
  computeDocumentScopes,
  scopeAt,
} from "../services/applicabilityScope.js";
import { chunkStartWordIndex, reconstructPageWords } from "../services/chunkGeometry.js";

const OWNER_ENGINE = "2ZR-FE";
const OWNER_PROFILE = {
  engineCode: OWNER_ENGINE,
  buildPlant: null,
  transmissionCode: null,
  hasVsc: null,
  hasSmartKey: null,
};
const LABELS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "applicability-labels");
const ARTICLE_LINE = /Vehicle\s*>[^]{0,200}/;
const FIGURE = /\d+(?:[.,]\d+)?\s*(?:N\*m|N·m|Nm|kgf\*cm|ft\.\*lbf|in\.\*lbf|mm|kPa|V\b|Ω|°C|L\b)/g;
const HEADER_ONLY_SAMPLE = 40;
const INHERITED_SAMPLE = 30;
const CONTEXT_BEFORE = 300;
const CONTEXT_AFTER = 120;
const VERDICTS = ["applies", "other_variant", "unresolved", "not_stated", "unlocated"];

/**
 * @param {Array<{ expected: string, verdict: string }>} rows
 */
export function scoreLabels(rows) {
  /** @type {Record<string, Record<string, number>>} */
  const matrix = {};
  let unclear = 0;
  let falseApplies = 0;
  let ownerRows = 0;
  let falseOther = 0;

  for (const { expected, verdict } of rows) {
    matrix[expected] = matrix[expected] || Object.fromEntries(VERDICTS.map((name) => [name, 0]));
    matrix[expected][verdict] = (matrix[expected][verdict] || 0) + 1;

    if (expected === "unclear") {
      unclear += 1;
      continue;
    }
    if (expected === "2AZ-FE" && verdict === "applies") {
      falseApplies += 1;
    }
    if (expected === OWNER_ENGINE || expected === "both") {
      ownerRows += 1;
      if (verdict === "other_variant") {
        falseOther += 1;
      }
    }
  }

  return {
    total: rows.length,
    scored: rows.length - unclear,
    unclear,
    falseApplies,
    ownerRows,
    falseOther,
    falseOtherRate: ownerRows ? falseOther / ownerRows : 0,
    matrix,
  };
}

/**
 * Unit-bearing figures on a page, skipping the ALLDATA account header: its
 * "1.8L" is the account's vehicle, not a specification (the first sample
 * drew 100 of 233 figures from it). Offsets point into the real page text.
 *
 * @param {string} pageText
 */
export function candidateFigures(pageText) {
  return [...blankAccountHeader(pageText).matchAll(FIGURE)];
}

/**
 * Offset of the `occurrence`-th match of `figure` at or after `startChar`, or -1.
 *
 * @param {string} pageText
 * @param {number} startChar
 * @param {string} figure
 * @param {number} occurrence 1-based
 */
export function locateFigure(pageText, startChar, figure, occurrence) {
  let at = startChar - 1;
  for (let seen = 0; seen < occurrence; seen += 1) {
    at = pageText.indexOf(figure, at + 1);
    if (at === -1) {
      return -1;
    }
  }
  return at;
}

/** Character offset of word `wordIndex` in a single-space-joined page text. */
function wordStartChar(pageText, wordIndex) {
  let at = 0;
  for (let index = 0; index < wordIndex; index += 1) {
    const next = pageText.indexOf(" ", at);
    if (next === -1) {
      return pageText.length;
    }
    at = next + 1;
  }
  return at;
}

function loadDocument(db, documentId) {
  const rows = db
    .prepare(
      "SELECT id, page_number, chunk_index, chunk_text FROM document_chunks WHERE document_id = ? ORDER BY page_number, chunk_index"
    )
    .all(documentId);
  /** @type {Map<number, Array<{ id: number, chunkIndex: number, text: string }>>} */
  const byPage = new Map();
  for (const row of rows) {
    const pageNumber = Number(row.page_number);
    if (!byPage.has(pageNumber)) {
      byPage.set(pageNumber, []);
    }
    byPage.get(pageNumber)?.push({ id: Number(row.id), chunkIndex: Number(row.chunk_index), text: String(row.chunk_text) });
  }
  const scoped = computeDocumentScopes(
    [...byPage.entries()].map(([pageNumber, chunks]) => ({
      pageNumber,
      text: reconstructPageWords(chunks.map((chunk) => chunk.text)).join(" "),
    }))
  );
  return { byPage, scoped };
}

const knownEngineValues = (markers) =>
  new Set(
    markers
      .filter((marker) => marker.axis === "engine" && KNOWN_ENGINE_CODES.includes(String(marker.value)))
      .map((marker) => String(marker.value))
  );

function everyNth(items, count) {
  if (items.length <= count) {
    return items;
  }
  const step = items.length / count;
  return Array.from({ length: count }, (_, index) => items[Math.floor(index * step)]);
}

/** @param {DatabaseSync} db */
export function sampleCandidates(db) {
  const documents = db.prepare("SELECT id, original_filename FROM documents ORDER BY id").all();
  const pools = { A: [], B: [], C: [] };

  for (const document of documents) {
    const { byPage, scoped } = loadDocument(db, document.id);
    const titledByEngine = scoped.some((page) =>
      page.segments.some((segment) => segment.scope.engine && segment.scope.engine.kind === "article_title")
    );

    for (const page of scoped) {
      const stored = byPage.get(page.pageNumber) || [];
      const articleLine = (page.text.match(ARTICLE_LINE) || [""])[0];

      for (const chunk of page.chunks) {
        const storedChunk = stored.find((row) => row.chunkIndex === chunk.chunkIndex);
        if (!storedChunk || !storedChunk.text.match(FIGURE)) {
          continue;
        }

        const values = knownEngineValues(chunk.ownMarkers);
        const startChar = wordStartChar(page.text, chunkStartWordIndex(chunk.chunkIndex));
        const endChar = startChar + storedChunk.text.length;
        const figures = candidateFigures(page.text).filter(
          (match) => match.index >= startChar && match.index < endChar
        );
        if (!figures.length) {
          continue;
        }

        let source = null;
        let picked = [];
        if ([...values].some((value) => value !== OWNER_ENGINE)) {
          source = "A";
          // The first figure after each engine marker, plus the chunk's last figure.
          const markerStarts = chunk.ownMarkers.filter((marker) => marker.axis === "engine").map((marker) => marker.start);
          for (const markerStart of markerStarts) {
            const after = figures.find((match) => match.index > markerStart);
            if (after && !picked.includes(after)) {
              picked.push(after);
            }
          }
          const last = figures[figures.length - 1];
          if (!picked.includes(last)) {
            picked.push(last);
          }
          picked = picked.slice(0, 3);
        } else if (!values.size && hasAccountHeader(storedChunk.text)) {
          source = "B";
          picked = [figures[0]];
        } else if (!values.size && titledByEngine) {
          source = "C";
          picked = [figures[0]];
        }
        if (!source) {
          continue;
        }

        for (const match of picked) {
          const figure = match[0];
          let occurrence = 0;
          let at = startChar - 1;
          do {
            at = page.text.indexOf(figure, at + 1);
            occurrence += 1;
          } while (at !== -1 && at < match.index);

          pools[source].push({
            id: `${document.id}:${page.pageNumber}:${chunk.chunkIndex}:${figure}:${occurrence}`,
            chunkId: storedChunk.id,
            source,
            documentId: document.id,
            filename: document.original_filename,
            pageNumber: page.pageNumber,
            chunkIndex: chunk.chunkIndex,
            figure,
            occurrence,
            articleTitle: articleLine,
            contextBefore: page.text.slice(Math.max(0, match.index - CONTEXT_BEFORE), match.index),
            contextAfter: page.text.slice(match.index + figure.length, match.index + figure.length + CONTEXT_AFTER),
            expected: null,
            note: "",
          });
        }
      }
    }
  }

  const byChunkId = (left, right) => left.chunkId - right.chunkId;
  const pickChunks = (rows, count) => {
    const chunkIds = [...new Set(rows.sort(byChunkId).map((row) => row.chunkId))];
    const keep = new Set(everyNth(chunkIds, count));
    return rows.filter((row) => keep.has(row.chunkId));
  };

  return [
    ...pools.A.sort(byChunkId),
    ...pickChunks(pools.B, HEADER_ONLY_SAMPLE),
    ...pickChunks(pools.C, INHERITED_SAMPLE),
  ];
}

/**
 * @param {DatabaseSync} db
 * @param {Array<{ id: string, documentId: number, pageNumber: number, chunkIndex: number, figure: string, occurrence: number, expected: string }>} rows
 */
export function judgeLabels(db, rows) {
  /** @type {Map<number, ReturnType<typeof loadDocument>>} */
  const cache = new Map();

  return rows.map((row) => {
    if (!cache.has(row.documentId)) {
      cache.set(row.documentId, loadDocument(db, row.documentId));
    }
    const page = cache.get(row.documentId)?.scoped.find((entry) => entry.pageNumber === row.pageNumber);
    if (!page) {
      return { ...row, verdict: "unlocated" };
    }
    const offset = locateFigure(page.text, wordStartChar(page.text, chunkStartWordIndex(row.chunkIndex)), row.figure, row.occurrence);
    if (offset === -1) {
      return { ...row, verdict: "unlocated" };
    }
    const scope = scopeAt(page.segments, offset);
    return { ...row, verdict: classifyScope(scope, OWNER_PROFILE).verdict, scope };
  });
}

function parseArguments(argv) {
  const options = { sample: false, labels: "", out: LABELS_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--sample") {
      options.sample = true;
    } else if (argv[index] === "--labels") {
      options.labels = String(argv[index + 1] || "");
      index += 1;
    } else if (argv[index] === "--out") {
      options.out = String(argv[index + 1] || LABELS_DIR);
      index += 1;
    }
  }
  return options;
}

/** @param {string[]} argv */
export async function runCli(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const db = new DatabaseSync(config.databaseFile, { readOnly: true });

  try {
    await fs.mkdir(options.out, { recursive: true });

    if (options.sample) {
      const candidates = sampleCandidates(db);
      const file = path.join(options.out, "candidates.jsonl");
      await fs.writeFile(file, `${candidates.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
      const counts = candidates.reduce((acc, row) => ({ ...acc, [row.source]: (acc[row.source] || 0) + 1 }), {});
      console.log(`Wrote ${candidates.length} unlabeled candidates (${JSON.stringify(counts)}) to ${file}`);
      return;
    }

    if (!options.labels) {
      console.error("Pass --sample to write candidates, or --labels FILE to score labels.");
      process.exitCode = 1;
      return;
    }

    const labeled = readFileSync(options.labels, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line))
      .filter((row) => typeof row.expected === "string" && row.expected);
    const judged = judgeLabels(db, labeled);
    const score = scoreLabels(judged);
    const unlocated = judged.filter((row) => row.verdict === "unlocated");

    await fs.writeFile(
      path.join(options.out, "results.jsonl"),
      `${judged.map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8"
    );
    console.log(JSON.stringify({ ...score, unlocated: unlocated.length }, null, 2));
    for (const row of judged.filter((entry) => entry.expected === "2AZ-FE" && entry.verdict === "applies")) {
      console.log(`FALSE APPLIES: ${row.id}`);
    }
    for (const row of judged.filter(
      (entry) => (entry.expected === OWNER_ENGINE || entry.expected === "both") && entry.verdict === "other_variant"
    )) {
      console.log(`false other: ${row.id}`);
    }

    if (score.falseApplies > 0 || score.falseOtherRate > 0.05 || unlocated.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
