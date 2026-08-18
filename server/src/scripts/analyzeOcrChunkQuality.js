// Read-only quality measurement for OCR-recovered wiring-diagram chunks.
//
//   npm run analyze:ocr-quality                 (all completed_with_ocr documents)
//   npm run analyze:ocr-quality -- --ids 91,638,841
//
// This exists to answer one decision: are raw OCR chunks from scanned wiring
// diagrams good enough to embed and cite as Ask evidence, or are they only good
// enough to make a diagram findable?
//
// HEURISTICS ARE COMPARATIVE SIGNALS, NOT GROUND TRUTH. There is no reference
// transcription of these pages, so nothing here measures OCR accuracy. Every
// number below is a proxy, and each one is wrong in a knowable direction:
//
//   - "word-like token" counts tokens matching /^[A-Za-z][A-Za-z-]{2,}$/. It
//     UNDER-counts correct output, because a wiring diagram's most valuable
//     tokens are exactly the ones it rejects: CANH, FL+, A51, +BS, 2AZ-FE. It
//     also OVER-counts, because a garbled run like "eu" or "Speen" scores as a
//     word. Use it to compare documents against each other, never as accuracy.
//   - Domain-term, connector, signal and pin detectors are pattern matches.
//     They confirm a recognizable token SURVIVED; they cannot confirm it was
//     read correctly, or attached to the right component.
//   - "Mostly noise" is a reported cut, not a production threshold. The
//     sensitivity table shows how the count moves as the cut moves, precisely
//     so no single number gets mistaken for a validated filter.
//
// Nothing here writes to the database or filters anything.

import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { config } from "../config.js";

// Electrical/repair vocabulary that actually appears in Toyota EWD sheets.
// A hit means the chunk carries at least one recognizable domain concept.
const DOMAIN_TERMS = [
  "abs", "accessory", "actuator", "alternator", "amplifier", "antenna", "assembly",
  "battery", "brake", "bulb", "buzzer", "circuit", "clutch", "coil", "combination",
  "compressor", "computer", "condenser", "connector", "control", "cooling", "cruise",
  "cylinder", "detector", "diode", "door", "driver", "ecu", "ecm", "engine", "fan",
  "fuse", "generator", "ground", "harness", "headlight", "heater", "horn", "ignition",
  "igniter", "immobiliser", "immobilizer", "indicator", "injector", "instrument",
  "interior", "junction", "lamp", "light", "lock", "meter", "mirror", "module",
  "motor", "neutral", "outlet", "panel", "position", "power", "pump", "regulator",
  "relay", "resistor", "sensor", "shield", "shielded", "signal", "socket", "solenoid",
  "speaker", "starter", "steering", "stop", "switch", "system", "terminal",
  "throttle", "transmission", "valve", "voltage", "warning", "window", "wiper",
  "wire", "harness",
];

// Toyota EWD connector codes: a letter (sometimes two) plus 1-3 digits, e.g. A51,
// B31, E46, IG1. Anchored so it does not fire on stray digit runs.
const CONNECTOR_PATTERN = /\b[A-Z]{1,2}\d{1,3}\b/g;

// Signal / wire labels seen on these sheets.
const SIGNAL_PATTERN =
  /\b(CANH|CANL|GND\d?|IG\d?|ACC|BAT|VCC|VCTA|VTA\d?|\+B|\+BS|W-B|FL[+-]|FR[+-]|RL[+-]|RR[+-]|MIL|VF|ETA|E\d)\b/g;

const PIN_PATTERN = /(?:^|\s)\d{1,2}(?=\s|$)/g;

function tokenize(text) {
  return String(text || "").split(/\s+/).filter(Boolean);
}

/** See the header: comparative signal only, biased against valid identifiers. */
export function wordLikeRatio(text) {
  const tokens = tokenize(text);

  if (!tokens.length) {
    return 0;
  }

  const wordLike = tokens.filter((token) => /^[A-Za-z][A-Za-z-]{2,}$/.test(token));
  return wordLike.length / tokens.length;
}

export function countMatches(text, pattern) {
  return (String(text || "").match(pattern) || []).length;
}

export function countDomainTerms(text) {
  const lowered = ` ${String(text || "").toLowerCase()} `;
  return DOMAIN_TERMS.filter((term) => lowered.includes(` ${term} `)).length;
}

export function measureChunk(chunkText) {
  return {
    characters: String(chunkText || "").length,
    tokens: tokenize(chunkText).length,
    wordLikeRatio: wordLikeRatio(chunkText),
    domainTerms: countDomainTerms(chunkText),
    connectors: countMatches(chunkText, CONNECTOR_PATTERN),
    signals: countMatches(chunkText, SIGNAL_PATTERN),
    pins: countMatches(chunkText, PIN_PATTERN),
  };
}

/**
 * A chunk counts as "mostly noise" when it is BOTH visually unreadable and
 * carries no recognizable domain concept. Requiring both keeps a legitimate
 * pin-row (low word ratio, but real connector codes) out of the noise bucket.
 */
export function isMostlyNoise(measurement, wordCut = 0.15) {
  return measurement.wordLikeRatio <= wordCut && measurement.domainTerms === 0;
}

/** Did the diagram's own subject line survive OCR on this page? */
export function titleSurvives(chunkText, title) {
  const titleWords = String(title || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 3);

  if (!titleWords.length) {
    return false;
  }

  const lowered = String(chunkText || "").toLowerCase();
  const hits = titleWords.filter((word) => lowered.includes(word)).length;
  return hits / titleWords.length >= 0.5;
}

export function analyzeDocument(row, chunks) {
  const measurements = chunks.map((chunk) => measureChunk(chunk.chunk_text));
  const pages = new Set(chunks.map((chunk) => chunk.page_number));
  const totals = measurements.reduce(
    (accumulator, measurement) => ({
      tokens: accumulator.tokens + measurement.tokens,
      wordLike: accumulator.wordLike + measurement.tokens * measurement.wordLikeRatio,
      connectors: accumulator.connectors + measurement.connectors,
      signals: accumulator.signals + measurement.signals,
      pins: accumulator.pins + measurement.pins,
    }),
    { tokens: 0, wordLike: 0, connectors: 0, signals: 0, pins: 0 }
  );

  const noisy = measurements.filter((measurement) => isMostlyNoise(measurement)).length;
  const meaningful = measurements.filter(
    (measurement) => measurement.domainTerms > 0
  ).length;
  const titlePages = chunks.filter((chunk) => titleSurvives(chunk.chunk_text, row.title))
    .length;

  return {
    documentId: row.id,
    title: row.title,
    pageCount: row.page_count,
    textLength: row.text_length,
    charactersPerPage: row.page_count
      ? Math.round(row.text_length / row.page_count)
      : 0,
    chunkCount: chunks.length,
    chunksPerPage: row.page_count
      ? Math.round((chunks.length / row.page_count) * 100) / 100
      : 0,
    pagesCovered: pages.size,
    pageCoverageComplete: pages.size === row.page_count,
    wordLikePercent: totals.tokens
      ? Math.round((totals.wordLike / totals.tokens) * 1000) / 10
      : 0,
    connectorIds: totals.connectors,
    signalLabels: totals.signals,
    pinNumbers: totals.pins,
    chunksWithTitle: titlePages,
    meaningfulChunks: meaningful,
    meaningfulPercent: chunks.length
      ? Math.round((meaningful / chunks.length) * 1000) / 10
      : 0,
    noisyChunks: noisy,
    noisyPercent: chunks.length ? Math.round((noisy / chunks.length) * 1000) / 10 : 0,
    measurements,
  };
}

function readDocuments(db, ids) {
  const filter = ids.length
    ? `id IN (${ids.join(",")})`
    : "extraction_status LIKE 'completed_with_ocr%'";

  return db
    .prepare(`
      SELECT id, title, original_filename, page_count, extraction_status,
             LENGTH(COALESCE(extracted_text, '')) AS text_length
      FROM documents
      WHERE ${filter}
      ORDER BY id ASC
    `)
    .all();
}

function readChunks(db, documentId) {
  return db
    .prepare(`
      SELECT page_number, chunk_index, chunk_text
      FROM document_chunks
      WHERE document_id = ?
      ORDER BY page_number, chunk_index
    `)
    .all(documentId);
}

export function parseArguments(argv = []) {
  const options = { ids: [] };

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--ids") {
      options.ids = String(argv[index + 1] || "")
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value > 0);
      index += 1;
    }
  }

  return options;
}

function formatReport(reports) {
  const lines = [
    "OCR chunk quality (heuristic comparative signals -- NOT an accuracy score)",
    "",
    "doc    pages  chars/pg  chunks  ch/pg  word-like  conn  signal  pins  title  meaningful  noisy",
  ];

  for (const report of reports) {
    lines.push(
      `#${String(report.documentId).padEnd(5)} ${String(report.pageCount).padStart(4)} ` +
        `${String(report.charactersPerPage).padStart(9)} ${String(report.chunkCount).padStart(7)} ` +
        `${String(report.chunksPerPage).padStart(6)} ${(String(report.wordLikePercent) + "%").padStart(10)} ` +
        `${String(report.connectorIds).padStart(5)} ${String(report.signalLabels).padStart(7)} ` +
        `${String(report.pinNumbers).padStart(5)} ${String(report.chunksWithTitle).padStart(6)} ` +
        `${(report.meaningfulChunks + " (" + report.meaningfulPercent + "%)").padStart(12)} ` +
        `${(report.noisyChunks + " (" + report.noisyPercent + "%)").padStart(10)}`
    );
  }

  const allMeasurements = reports.flatMap((report) => report.measurements);

  lines.push("", "Sensitivity of the 'mostly noise' cut (chunks flagged / total):");

  for (const cut of [0.05, 0.1, 0.15, 0.2, 0.25, 0.3]) {
    const flagged = allMeasurements.filter((measurement) =>
      isMostlyNoise(measurement, cut)
    ).length;
    lines.push(
      `  word-like <= ${String(Math.round(cut * 100)).padStart(2)}% and 0 domain terms: ` +
        `${String(flagged).padStart(3)} / ${allMeasurements.length} ` +
        `(${Math.round((flagged / allMeasurements.length) * 1000) / 10}%)`
    );
  }

  const totalChunks = allMeasurements.length;
  const withDomain = allMeasurements.filter((m) => m.domainTerms > 0).length;

  lines.push(
    "",
    `Across the sample: ${totalChunks} chunks, ${withDomain} carry at least one domain term ` +
      `(${Math.round((withDomain / totalChunks) * 1000) / 10}%).`
  );

  return lines.join("\n");
}

export function analyzeOcrChunkQuality(options = {}) {
  const db = new DatabaseSync(config.databaseFile, { readOnly: true });

  try {
    return readDocuments(db, options.ids || []).map((row) =>
      analyzeDocument(row, readChunks(db, row.id))
    );
  } finally {
    db.close();
  }
}

async function runCli() {
  const options = parseArguments(process.argv.slice(2));
  const reports = analyzeOcrChunkQuality(options);

  if (!reports.length) {
    console.log("No OCR-recovered documents to analyze.");
    return;
  }

  console.log(formatReport(reports));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
