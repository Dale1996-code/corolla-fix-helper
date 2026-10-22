// npm run diagnose:applicability -- [--engine 2ZR-FE] [--output-dir DIR] [--limit N]
//
// STRICTLY READ-ONLY report of which documents, pages, and chunks are scoped to
// which engine (N5 P1, docs/n5-applicability-design.md). It opens the database
// with readOnly:true, reads only the stored chunks (never a PDF), makes no API
// call, and writes JSON + CSV under server/data/diagnostics/ (gitignored).
//
// It CLASSIFIES; it changes nothing Ask or the Repair Planner does. Run it
// against a VACUUM INTO snapshot (DATABASE_FILE=...) rather than the live file.
//
// "Owner" in every count means the engine the report is run for: --engine, or
// the engine code saved in Settings. With neither, it refuses rather than
// guess -- an unknown engine is never assumed to be the 2ZR-FE.

import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { config } from "../config.js";
import {
  KNOWN_ENGINE_CODES,
  hasAccountHeader,
  computeDocumentScopes,
  findScopeMarkers,
} from "../services/applicabilityScope.js";
import { reconstructPageWords } from "../services/chunkGeometry.js";
import { normalizeApplicabilityProfile } from "../services/vehicleApplicabilityProfile.js";

// A unit-bearing figure: the chunks worth checking for a wrong-engine spec.
const SPEC_FIGURE = /\d\s*(N\*m|N·m|Nm|kgf\*cm|ft\.\*lbf|in\.\*lbf|mm|kPa|V\b|Ω|°C|L\b)/;
const CSV_COLUMNS = [
  "id",
  "filename",
  "pages",
  "chunks",
  "documentClass",
  "headerOnly",
  "pagesOwner",
  "pagesOther",
  "pagesMixed",
  "unresolvedPages",
];

/**
 * @param {string[]} argv
 * @returns {{ outputDir?: string, limit?: number, engine?: string }}
 */
export function parseArguments(argv = []) {
  /** @type {{ outputDir?: string, limit?: number, engine?: string }} */
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];

    if (argument === "--output-dir") {
      options.outputDir = String(value || "");
      index += 1;
    } else if (argument === "--limit") {
      options.limit = Math.max(0, Number(value) || 0);
      index += 1;
    } else if (argument === "--engine") {
      options.engine = normalizeApplicabilityProfile({ engineCode: value }).engineCode || undefined;
      index += 1;
    }
  }

  return options;
}

/** Engine values a set of markers names, known codes only. */
function engineValues(markers) {
  return new Set(
    markers
      .filter((marker) => marker.axis === "engine" && KNOWN_ENGINE_CODES.includes(String(marker.value)))
      .map((marker) => String(marker.value))
  );
}

function classOf(values, ownerEngine) {
  const owner = values.has(ownerEngine);
  const other = [...values].some((value) => value !== ownerEngine);
  if (owner && other) {
    return "mixed";
  }
  if (owner) {
    return "owner_only";
  }
  return other ? "other_only" : "none";
}

const emptyClasses = () => ({ none: 0, owner_only: 0, mixed: 0, other_only: 0 });

/**
 * Build the report from an already-open (read-only) connection.
 *
 * @param {DatabaseSync} db
 * @param {{ ownerEngine: string, limit?: number }} options
 */
export function buildApplicabilityReport(db, { ownerEngine, limit }) {
  const documentRows = db
    .prepare(`SELECT id, original_filename FROM documents ORDER BY id${limit ? " LIMIT ?" : ""}`)
    .all(...(limit ? [limit] : []));
  const chunkStatement = db.prepare(`
    SELECT page_number, chunk_index, chunk_text
    FROM document_chunks
    WHERE document_id = ?
    ORDER BY page_number, chunk_index
  `);

  const report = {
    ownerEngine,
    totals: { documents: documentRows.length, pages: 0, chunks: 0 },
    accountHeader: { documents: 0, pages: 0, headerOnlyDocuments: 0 },
    documentClasses: emptyClasses(),
    unknownCodeDocuments: 0,
    pageClasses: emptyClasses(),
    pagesWithBothInlineBlocks: 0,
    specChunks: { mixed: 0, otherOnly: 0 },
    entryScope: { chunksWithoutOwnMarker: 0, inheritingOther: 0, inheritingOwner: 0, unresolvedAtEntry: 0 },
    /** @type {Record<string, number>} */
    markerKinds: {},
    /** @type {Array<Record<string, unknown>>} */
    documents: [],
  };

  for (const documentRow of documentRows) {
    /** @type {Map<number, Array<{ chunk_index: number, chunk_text: string }>>} */
    const byPage = new Map();
    for (const row of chunkStatement.all(documentRow.id)) {
      const pageNumber = Number(row.page_number);
      if (!byPage.has(pageNumber)) {
        byPage.set(pageNumber, []);
      }
      byPage.get(pageNumber)?.push({ chunk_index: Number(row.chunk_index), chunk_text: String(row.chunk_text) });
    }

    const storedChunks = [...byPage.values()].flat();
    const pages = [...byPage.entries()].map(([pageNumber, chunks]) => ({
      pageNumber,
      text: reconstructPageWords(chunks.map((chunk) => chunk.chunk_text)).join(" "),
    }));
    const scoped = computeDocumentScopes(pages);

    const documentValues = new Set();
    const documentClassCounts = emptyClasses();
    let hasHeader = false;
    let unknownCode = false;
    let unresolvedPages = 0;

    for (const page of scoped) {
      const markers = findScopeMarkers(page.text);
      const values = engineValues(markers);
      for (const value of values) {
        documentValues.add(value);
      }

      const pageClass = classOf(values, ownerEngine);
      report.pageClasses[pageClass] += 1;
      documentClassCounts[pageClass] += 1;
      if (hasAccountHeader(page.text)) {
        hasHeader = true;
        report.accountHeader.pages += 1;
      }
      if (markers.some((marker) => marker.kind === "unknown_code")) {
        unknownCode = true;
      }
      if (page.segments.some((segment) => segment.scope.engine && "unresolved" in segment.scope.engine)) {
        unresolvedPages += 1;
      }

      const inlineValues = markers.filter((marker) => marker.axis === "engine" && marker.kind === "inline_for");
      if (
        inlineValues.some((marker) => marker.value === ownerEngine) &&
        inlineValues.some((marker) => marker.value !== ownerEngine && KNOWN_ENGINE_CODES.includes(String(marker.value)))
      ) {
        report.pagesWithBothInlineBlocks += 1;
      }

      for (const marker of markers) {
        const key =
          marker.axis === "engine"
            ? `${marker.kind}:${marker.value === ownerEngine ? "owner" : "other"}`
            : `plant:${marker.kind}`;
        report.markerKinds[key] = (report.markerKinds[key] || 0) + 1;
      }

      const pageChunks = byPage.get(page.pageNumber) || [];
      for (const chunk of page.chunks) {
        const ownEngine = chunk.ownMarkers.filter((marker) => marker.axis === "engine");
        const stored = pageChunks.find((row) => row.chunk_index === chunk.chunkIndex);
        const chunkClass = classOf(engineValues(ownEngine), ownerEngine);

        if (stored && SPEC_FIGURE.test(stored.chunk_text)) {
          if (chunkClass === "mixed") {
            report.specChunks.mixed += 1;
          } else if (chunkClass === "other_only") {
            report.specChunks.otherOnly += 1;
          }
        }

        if (!ownEngine.length) {
          report.entryScope.chunksWithoutOwnMarker += 1;
          const entry = chunk.entryScope.engine;
          if (entry && "unresolved" in entry) {
            report.entryScope.unresolvedAtEntry += 1;
          } else if (entry && "value" in entry && entry.value === ownerEngine) {
            report.entryScope.inheritingOwner += 1;
          } else if (entry) {
            report.entryScope.inheritingOther += 1;
          }
        }
      }
    }

    const documentClass = classOf(documentValues, ownerEngine);
    const mentionsOwner = pages.some((page) => page.text.includes(ownerEngine));
    const headerOnly = mentionsOwner && !documentValues.has(ownerEngine);

    report.totals.pages += pages.length;
    report.totals.chunks += storedChunks.length;
    report.documentClasses[documentClass] += 1;
    if (hasHeader) {
      report.accountHeader.documents += 1;
    }
    if (headerOnly) {
      report.accountHeader.headerOnlyDocuments += 1;
    }
    if (unknownCode) {
      report.unknownCodeDocuments += 1;
    }

    report.documents.push({
      id: documentRow.id,
      filename: documentRow.original_filename,
      pages: pages.length,
      chunks: storedChunks.length,
      documentClass,
      headerOnly,
      pagesOwner: documentClassCounts.owner_only,
      pagesOther: documentClassCounts.other_only,
      pagesMixed: documentClassCounts.mixed,
      unresolvedPages,
    });
  }

  return report;
}

function toCsvValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  const text = String(value).replace(/\r?\n/g, " ");
  return /[",]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** @param {Array<Record<string, unknown>>} documents */
export function buildCsvReport(documents = []) {
  return [
    CSV_COLUMNS.join(","),
    ...documents.map((document) => CSV_COLUMNS.map((column) => toCsvValue(document[column])).join(",")),
  ].join("\n");
}

/** @param {ReturnType<typeof buildApplicabilityReport>} report */
export function formatConsoleReport(report) {
  const { totals, accountHeader, documentClasses, pageClasses, specChunks, entryScope } = report;
  return [
    `Applicability report (read-only), owner engine ${report.ownerEngine}`,
    `  ${totals.documents} documents, ${totals.pages} pages, ${totals.chunks} chunks`,
    `  account header: ${accountHeader.documents} documents, ${accountHeader.pages} pages; header-only 2ZR-FE mention: ${accountHeader.headerOnlyDocuments} documents`,
    `  documents: none ${documentClasses.none}, owner only ${documentClasses.owner_only}, mixed ${documentClasses.mixed}, other only ${documentClasses.other_only}`,
    `  pages:     none ${pageClasses.none}, owner only ${pageClasses.owner_only}, mixed ${pageClasses.mixed}, other only ${pageClasses.other_only}`,
    `  pages with both engines' (for X) blocks: ${report.pagesWithBothInlineBlocks}`,
    `  spec-bearing chunks naming both engines: ${specChunks.mixed}; naming only another: ${specChunks.otherOnly}`,
    `  chunks naming no engine themselves: ${entryScope.chunksWithoutOwnMarker} (inside another engine's scope: ${entryScope.inheritingOther}, the owner's: ${entryScope.inheritingOwner}, unresolved: ${entryScope.unresolvedAtEntry})`,
    `  documents with an unrecognized engine code: ${report.unknownCodeDocuments}`,
  ].join("\n");
}

async function writeReports(report, outputDir) {
  const directory = outputDir || path.join(path.dirname(config.databaseFile), "diagnostics");
  await fs.mkdir(directory, { recursive: true });
  const jsonPath = path.join(directory, "applicability-report.json");
  const csvPath = path.join(directory, "applicability-report.csv");
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(csvPath, `${buildCsvReport(report.documents)}\n`, "utf8");
  return { jsonPath, csvPath };
}

function readSavedEngineCode(db) {
  try {
    const row = db.prepare("SELECT engine_code FROM vehicles ORDER BY id LIMIT 1").get();
    return row && typeof row.engine_code === "string" ? row.engine_code : null;
  } catch {
    // A database from before migration 006 has no engine_code column.
    return null;
  }
}

/** @param {string[]} argv */
export async function runCli(argv = process.argv.slice(2)) {
  let db;
  try {
    const options = parseArguments(argv);
    db = new DatabaseSync(config.databaseFile, { readOnly: true });
    const ownerEngine = options.engine || readSavedEngineCode(db);

    if (!ownerEngine) {
      console.error(
        "Set the engine code in Settings → Variant details, or pass --engine 2ZR-FE. " +
          "The report will not assume which engine the car has."
      );
      process.exitCode = 1;
      return;
    }

    const report = buildApplicabilityReport(db, { ownerEngine, limit: options.limit });
    console.log(formatConsoleReport(report));
    const { jsonPath, csvPath } = await writeReports(report, options.outputDir);
    console.log(`\nJSON report: ${jsonPath}\nCSV report:  ${csvPath}`);
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
