// Read-only corpus survey for the Repair Planner evaluation (Tier B,
// docs/planner-eval-spec.md, Phase 4).
//
//   DATABASE_FILE=<snapshot.db> npm run eval:planner:survey
//   DATABASE_FILE=<snapshot.db> npm run eval:planner:survey -- --output-dir <folder> --probes <draft-probes.json>
//
// For every committed fact of the S1, S2, and S8 scenarios (plannerScenarios.js),
// and for any draft candidate in an optional probe file, it lists:
//
//   - candidate chunks: every chunk whose text holds the fact (a part matcher and
//     an acceptable figure in a declared unit), with document, page, chunk index,
//     extraction status, and content-group key;
//   - whether the figure is inside the planner's evidence window (the first
//     1,500 characters of whitespace-collapsed text the model is shown,
//     EVIDENCE_CONTEXT_CHAR_LIMIT) or only further down the chunk;
//   - keyword golden-query probes: does the scenario brief, or a canonical
//     query, put a chunk holding the fact into the top 8?
//
// plus the chunk-length distribution against 1,500 and the S8 timing-belt
// precondition (checkTimingBeltRefusalPrecondition).
//
// STRICTLY READ-ONLY, NO KEY, NO NETWORK. The database is opened with
// { readOnly: true } and nothing else; neither database.js (which opens the
// file read-write and migrates it) nor config.js (which reads the API key) is
// imported, and a test walks the import graph to keep it that way. The probes
// are KEYWORD ranking only, a faithful copy of retrieveKeywordChunks (a test
// compares the two), not the hybrid ranking a live planner run uses.
//
// The console prints aggregates only. The JSON and CSV (default:
// <database folder>/diagnostics/, gitignored beside server/data) name each
// document and page so the owner can open it; they carry no chunk text, but the
// S8 section keeps the precondition's own excerpt when it fires. Run it against
// a `VACUUM INTO` snapshot, never the live file.
//
// What it does NOT do: confirm a fact. A chunk that holds a part name and a
// figure is a candidate for a human to check on the rendered PDF page, and the
// `suggested` fields are suggestions. Nothing here writes plannerScenarios.js.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { checkTimingBeltRefusalPrecondition } from "../evals/negativeCorpusPreconditions.js";
import { PLANNER_SCENARIOS } from "../evals/plannerScenarios.js";
import { EVIDENCE_CONTEXT_CHAR_LIMIT, MAX_SEARCH_RESULTS } from "../services/agent/repairTools.js";
import { extractSpecNumbers } from "../services/askEvidenceContract.js";
import { DEFAULT_MAX_CHUNKS_PER_SOURCE, diversifyRankedChunks } from "../services/retrievalDiversity.js";

export const EVIDENCE_WINDOW_CHARS = EVIDENCE_CONTEXT_CHAR_LIMIT;
export const PROBE_TOP_K = MAX_SEARCH_RESULTS;

// Canonical queries per committed fact: the words a careful searcher would use.
// They are QUERIES, not facts, so they hold no figure. The brief is probed too.
const CANONICAL_QUERIES = {
  "s1-drain-plug-torque": ["oil drain plug torque", "engine oil drain plug tightening torque"],
  "s2-new-plug-gap": ["spark plug electrode gap", "new spark plug gap"],
  "s2-used-plug-max-gap": ["spark plug electrode gap", "used spark plug maximum electrode gap"],
  // Phase 4 Stage B (the owner's D11 facts).
  "s1-step-remove-filler-cap": ["remove oil filler cap"],
  "s1-step-drain-oil": ["drain engine oil", "remove oil drain plug drain oil"],
  "s1-step-new-drain-gasket": ["oil drain plug new gasket"],
  "s1-step-drain-filter-cap": ["loosen oil filter cap drain remaining oil"],
  "s1-step-remove-old-element": ["remove oil filter element o-ring"],
  "s1-step-clean-cap-threads": ["clean oil filter cap threads o-ring groove"],
  "s1-step-new-oring-oiled": ["oil filter cap new o-ring engine oil"],
  "s1-step-new-filter-element": ["new oil filter element"],
  "s1-step-clean-install-surface": ["oil filter installation surface dirt"],
  "s1-cap-alignment": ["align oil filter cap cutout bracket"],
  "s1-step-install-filter-cap": ["install oil filter cap assembly"],
  "s1-filter-cap-torque": ["oil filter cap torque", "oil filter cap assembly tightening torque"],
  "s1-step-add-oil": ["add fresh engine oil"],
  "s1-step-refit-filler-cap": ["install oil filler cap"],
  "s1-oil-viscosity": ["engine oil viscosity", "engine oil grade viscosity"],
  "s1-oil-capacity-with-filter": ["engine oil capacity", "engine oil capacity with oil filter change"],
  "s1-step-inspect-leak": ["inspect for oil leak"],
  "s2-step-remove-head-cover": ["remove no. 2 cylinder head cover"],
  "s2-step-disconnect-coils": ["disconnect ignition coil connectors"],
  "s2-step-remove-coils": ["remove ignition coil"],
  "s2-notice-plug-tube": ["ignition coil spark plug tube damage"],
  "s2-step-remove-plugs": ["remove spark plug"],
  "s2-plug-wrench-size": ["spark plug wrench"],
  "s2-recommended-plug": ["recommended spark plug"],
  "s2-step-install-plugs": ["install spark plug"],
  "s2-spark-plug-torque": ["spark plug torque", "install spark plug torque"],
  "s2-step-install-coils": ["install ignition coil"],
  "s2-coil-bolt-torque": ["ignition coil bolt torque"],
  "s2-step-connect-coils": ["connect ignition coil connectors"],
  "s2-step-refit-head-cover": ["install no. 2 cylinder head cover"],
};

const LENGTH_BUCKETS = [500, 1000, EVIDENCE_WINDOW_CHARS, 2000, 3000];

// ---- Text the planner shows ---------------------------------------------------

const collapse = (text) => (typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "");

/**
 * The text the planner's search tool shows the model for a chunk (buildEvidenceText
 * in repairTools.js): whitespace collapsed, then the first 1,500 characters.
 *
 * @param {unknown} text
 */
export function evidenceWindow(text) {
  const normalized = collapse(text);
  return normalized.length > EVIDENCE_WINDOW_CHARS ? normalized.slice(0, EVIDENCE_WINDOW_CHARS) : normalized;
}

/** @param {unknown} text */
export function evidenceLength(text) {
  return collapse(text).length;
}

// ---- Keyword ranking (a copy of chunkRetrievalService's keyword mode) -------------
//
// chunkRetrievalService.js imports database.js, which opens the file read-write,
// so the survey cannot call it. The functions below repeat its keyword path
// line for line; `surveyPlannerCorpus.test.js` ranks the same queries with both
// and fails on any difference.

/** @param {string} question */
function tokenizeQuestion(question) {
  if (typeof question !== "string") {
    return [];
  }
  return [
    ...new Set(
      question
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .map((part) => part.trim())
        .filter((part) => part.length >= 2)
    ),
  ];
}

function scoreChunk(row, terms) {
  let score = 0;
  let matchedTerms = 0;

  for (const term of terms) {
    let matched = false;
    if (row.lowerText.includes(term)) {
      score += 6;
      matched = true;
    }
    if (row.lowerTitle.includes(term)) {
      score += 2;
      matched = true;
    }
    if (row.lowerFilename.includes(term)) {
      score += 1;
      matched = true;
    }
    if (row.lowerSystem.includes(term)) {
      score += 1;
      matched = true;
    }
    if (matched) {
      matchedTerms += 1;
    }
  }
  return { score, matchedTerms };
}

function compareRanked(left, right) {
  return (
    right.relevanceScore - left.relevanceScore ||
    right.matchedTerms - left.matchedTerms ||
    left.documentId - right.documentId ||
    left.pageNumber - right.pageNumber ||
    left.chunkIndex - right.chunkIndex
  );
}

/**
 * The top keyword results for a query, after the same diversity selection as
 * production (identical text once, at most `maxChunksPerSource` per content group,
 * backfilled).
 *
 * @param {ReturnType<typeof loadCorpus>} corpus
 * @param {string} query
 * @param {{ limit?: number, maxChunksPerSource?: number }} [options]
 */
export function rankKeywordChunks(corpus, query, { limit = PROBE_TOP_K, maxChunksPerSource = DEFAULT_MAX_CHUNKS_PER_SOURCE } = {}) {
  const terms = tokenizeQuestion(query);

  if (!terms.length) {
    return [];
  }
  const ranked = [];

  for (const row of corpus.chunks) {
    const { score, matchedTerms } = scoreChunk(row, terms);
    if (score > 0) {
      ranked.push({
        chunkId: row.chunkId,
        documentId: row.documentId,
        pageNumber: row.pageNumber,
        chunkIndex: row.chunkIndex,
        chunkText: row.chunkText,
        relevanceScore: score,
        matchedTerms,
      });
    }
  }
  ranked.sort(compareRanked);

  return diversifyRankedChunks(ranked, {
    limit: Math.max(1, Number(limit) || PROBE_TOP_K),
    maxPerSource: maxChunksPerSource,
    resolveSourceKey: (chunk) => corpus.groupKeyOf(chunk.documentId),
  });
}

// ---- Loading ------------------------------------------------------------------

/** documentContentIdentity.js's key: sha256 of the normalized extracted text. */
function contentGroupKey(documentId, extractedText) {
  const normalized = collapse(String(extractedText ?? "")).toLowerCase();
  return normalized ? `text:${createHash("sha256").update(normalized).digest("hex")}` : `document:${documentId}`;
}

/**
 * Every chunk and document, read once through the read-only connection.
 *
 * @param {DatabaseSync} db opened with { readOnly: true }
 */
export function loadCorpus(db) {
  const documents = new Map();

  for (const row of /** @type {any[]} */ (
    db.prepare("SELECT id, title, original_filename, stored_filename, file_path, system, extraction_status, extracted_text FROM documents").all()
  )) {
    const id = Number(row.id);
    documents.set(id, {
      documentId: id,
      title: row.title ?? "",
      originalFilename: row.original_filename ?? "",
      storedFilename: row.stored_filename || (row.file_path ? path.basename(String(row.file_path)) : ""),
      system: row.system ?? "",
      extractionStatus: row.extraction_status ?? null,
      contentGroupKey: contentGroupKey(id, row.extracted_text),
    });
  }

  const chunks = /** @type {any[]} */ (
    db.prepare("SELECT id, document_id, page_number, chunk_index, chunk_text FROM document_chunks").all()
  ).map((row) => {
    const document = documents.get(Number(row.document_id));
    const chunkText = row.chunk_text ?? "";
    return {
      chunkId: Number(row.id),
      documentId: Number(row.document_id),
      pageNumber: Number(row.page_number),
      chunkIndex: Number(row.chunk_index),
      chunkText,
      lowerText: chunkText.toLowerCase(),
      lowerTitle: String(document?.title ?? "").toLowerCase(),
      lowerFilename: String(document?.originalFilename ?? "").toLowerCase(),
      lowerSystem: String(document?.system ?? "").toLowerCase(),
    };
  });

  return {
    documents,
    chunks,
    groupKeyOf: (documentId) => documents.get(Number(documentId))?.contentGroupKey ?? `document:${documentId}`,
  };
}

// ---- Fact matching -------------------------------------------------------------

const unitKey = (unit) => String(unit ?? "").toLowerCase().replace(/[^a-zµΩω]/g, "");
const sameNumber = (left, right) => Math.abs(left - right) < 1e-9;

/**
 * The figures printed in `text` that match one of `forms`, read by the
 * verifier's own parser (extractSpecNumbers), so a figure the verifier could not
 * read is not counted here either. A range needs both ends, printed one after
 * the other in the same unit.
 *
 * @param {string} text
 * @param {Array<{ kind: string, value?: number, low?: number, high?: number, unitKeys: Set<string>, label: string }>} forms
 */
function figuresIn(text, forms) {
  const specs = extractSpecNumbers(text);
  const found = [];

  for (const form of forms) {
    const inUnit = specs.filter((spec) => form.unitKeys.has(unitKey(spec.unit)));
    const hit =
      form.kind === "range"
        ? specs.some(
            (spec, index) =>
              form.unitKeys.has(unitKey(spec.unit)) &&
              sameNumber(spec.value, form.low) &&
              specs[index + 1] &&
              form.unitKeys.has(unitKey(specs[index + 1].unit)) &&
              sameNumber(specs[index + 1].value, form.high)
          )
        : inUnit.some((spec) => sameNumber(spec.value, form.value));

    if (hit) {
      found.push(form.label);
    }
  }
  return found;
}

/** Turn a fact's acceptable / decoy forms into matchable forms. */
function formsFromFact(fact, list) {
  const aliases = new Map((fact.units ?? []).map((unit) => [unit.canonical, [unit.canonical, ...unit.aliases]]));

  return (list ?? []).map((form) => {
    const spellings = aliases.get(form.unit) ?? [form.unit];
    const shown = form.kind === "range" ? `${form.low} to ${form.high}` : String(form.value);
    return { ...form, unitKeys: new Set(spellings.map(unitKey)), label: `${shown} ${form.unit}` };
  });
}

// The judge's sentence split (plannerJudge.js statesFact), kept identical.
const sentencesOf = (text) => String(text ?? "").split(/(?<=[.!?;])\s+(?=[A-Z(])/);

/**
 * One matcher per surveyed item: `holds(text)` says whether the text states it.
 * A numeric fact holds when a part matcher hits and an acceptable figure is
 * printed; a probe holds when every `allOf` pattern hits and, if it lists
 * figures, one of them is printed.
 *
 * A STEP is read sentence by sentence. Its matchers are written for one claim
 * -- every pattern must hit it, and some exclude a neighbouring step's words
 * ("not when the O-ring is named") -- so testing them across a whole chunk
 * would let one sentence's exclusion hide another sentence's step. This is the
 * judge's own rule for whether a step was in front of the model (statesFact).
 *
 * @param {any} fact
 */
export function matcherForFact(fact) {
  if (fact.kind === "numeric_spec") {
    const acceptable = formsFromFact(fact, fact.acceptable);
    const decoys = formsFromFact(fact, fact.decoys);
    return {
      holds: (text) => fact.partMatchers.some((matcher) => matcher.test(text)) && figuresIn(text, acceptable).length > 0,
      figures: (text) => figuresIn(text, acceptable),
      decoys: (text) => figuresIn(text, decoys),
    };
  }
  if (fact.kind === "procedure_step") {
    const statesStep = (sentence) => fact.stepMatchers.every((matcher) => matcher.test(sentence));
    return {
      holds: (text) => sentencesOf(text).some(statesStep),
      figures: () => [],
      decoys: () => [],
    };
  }
  return null;
}

function matcherForProbe(probe) {
  const patterns = probe.allOf.map((source) => new RegExp(source, probe.flags ?? "i"));
  const forms = (probe.figures ?? []).map((form) => ({
    ...form,
    unitKeys: new Set(form.units.map(unitKey)),
    label: `${form.kind === "range" ? `${form.low} to ${form.high}` : form.value} ${form.units[0]}`,
  }));

  return {
    holds: (text) => patterns.every((pattern) => pattern.test(text)) && (forms.length === 0 || figuresIn(text, forms).length > 0),
    figures: (text) => figuresIn(text, forms),
    decoys: () => [],
  };
}

/**
 * Read and check a draft probe file. The file stays outside the repository: a
 * draft candidate is not a confirmed fact and must not be committed as one.
 *
 * @param {string} file
 */
export function loadProbeFile(file) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const probes = Array.isArray(parsed?.probes) ? parsed.probes : null;

  if (!probes) {
    throw new Error(`${file}: expected { "probes": [...] }`);
  }
  const ids = new Set();

  probes.forEach((probe, index) => {
    const at = `${file} probe ${index + 1}`;
    for (const key of ["scenarioId", "id", "concept"]) {
      if (typeof probe?.[key] !== "string" || !probe[key].trim()) {
        throw new Error(`${at}: ${key} is required`);
      }
    }
    if (ids.has(probe.id)) {
      throw new Error(`${at}: duplicate id ${probe.id}`);
    }
    ids.add(probe.id);
    if (!Array.isArray(probe.allOf) || probe.allOf.length === 0 || !probe.allOf.every((entry) => typeof entry === "string")) {
      throw new Error(`${at}: allOf must be a non-empty array of regular-expression strings`);
    }
    probe.allOf.forEach((source) => new RegExp(source, probe.flags ?? "i"));
    if (probe.queries !== undefined && !(Array.isArray(probe.queries) && probe.queries.every((entry) => typeof entry === "string"))) {
      throw new Error(`${at}: queries must be an array of strings`);
    }
    for (const form of probe.figures ?? []) {
      const numeric = form?.kind === "range" ? Number.isFinite(form.low) && Number.isFinite(form.high) : form?.kind === "value" && Number.isFinite(form.value);
      if (!numeric || !Array.isArray(form.units) || form.units.length === 0) {
        throw new Error(`${at}: a figure is { kind: "value", value, units[] } or { kind: "range", low, high, units[] }`);
      }
    }
  });
  return probes;
}

// ---- The survey ------------------------------------------------------------------

function surveyItem(corpus, item, { maxChunksPerSource }) {
  const candidates = [];

  for (const chunk of corpus.chunks) {
    const collapsed = collapse(chunk.chunkText);
    if (!item.matcher.holds(collapsed)) {
      continue;
    }
    const document = corpus.documents.get(chunk.documentId);
    const window = evidenceWindow(chunk.chunkText);
    candidates.push({
      documentId: chunk.documentId,
      title: document?.title ?? "",
      storedFilename: document?.storedFilename ?? "",
      pageNumber: chunk.pageNumber,
      chunkIndex: chunk.chunkIndex,
      chunkId: chunk.chunkId,
      extractionStatus: document?.extractionStatus ?? null,
      contentGroupKey: corpus.groupKeyOf(chunk.documentId),
      rawChunkLength: chunk.chunkText.length,
      chunkLength: collapsed.length,
      inChunk: true,
      inEvidenceWindow: item.matcher.holds(window),
      figuresInChunk: item.matcher.figures(collapsed),
      decoysInChunk: item.matcher.decoys(collapsed),
    });
  }
  candidates.sort((left, right) => left.documentId - right.documentId || left.pageNumber - right.pageNumber || left.chunkIndex - right.chunkIndex);

  const byChunk = new Map(candidates.map((candidate) => [candidate.chunkId, candidate]));
  const probes = item.queries.map(({ query, isBrief }) => {
    const top = rankKeywordChunks(corpus, query, { limit: PROBE_TOP_K, maxChunksPerSource }).map((chunk, index) => {
      const candidate = byChunk.get(chunk.chunkId);
      return {
        rank: index + 1,
        documentId: chunk.documentId,
        pageNumber: chunk.pageNumber,
        chunkIndex: chunk.chunkIndex,
        holdsFact: Boolean(candidate),
        factInEvidenceWindow: Boolean(candidate?.inEvidenceWindow),
      };
    });
    return {
      query,
      isBrief,
      firstHoldingRank: top.find((entry) => entry.holdsFact)?.rank ?? null,
      firstVisibleRank: top.find((entry) => entry.factInEvidenceWindow)?.rank ?? null,
      top,
    };
  });

  const visible = candidates.filter((candidate) => candidate.inEvidenceWindow);
  const summary = {
    candidateChunks: candidates.length,
    distinctDocuments: new Set(candidates.map((candidate) => candidate.documentId)).size,
    distinctContentGroups: new Set(candidates.map((candidate) => candidate.contentGroupKey)).size,
    visibleInEvidenceWindow: visible.length,
    beyondEvidenceWindowOnly: candidates.length - visible.length,
    fromOcr: candidates.filter((candidate) => String(candidate.extractionStatus).includes("ocr")).length,
    withDecoyInChunk: candidates.filter((candidate) => candidate.decoysInChunk.length > 0).length,
    chunksOverEvidenceWindow: candidates.filter((candidate) => candidate.chunkLength > EVIDENCE_WINDOW_CHARS).length,
  };

  return {
    scenarioId: item.scenarioId,
    factId: item.id,
    source: item.source,
    kind: item.kind,
    concept: item.concept,
    confirmed: item.confirmed,
    summary,
    suggested: suggestSurveyFields(summary, probes, item.kind),
    probes,
    candidates,
  };
}

/**
 * What the survey can say about corpusSupport and goldenQueryRetrieves, and why.
 * Suggestions only: the owner's check of the rendered page decides, and a value
 * the survey cannot settle stays null (spec 16.1, 2b-2: unknown stays unknown).
 */
function suggestSurveyFields(summary, probes, kind) {
  if (summary.candidateChunks === 0) {
    return {
      corpusSupport: null,
      goldenQueryRetrieves: null,
      reason: "no chunk states it as matched; it may be absent, worded differently, or split across chunks",
    };
  }
  // A step is a sentence; whether all of it is in one place needs a human.
  const corpusSupport = kind === "numeric_spec" ? "full" : null;

  if (summary.visibleInEvidenceWindow === 0) {
    return {
      corpusSupport,
      goldenQueryRetrieves: null,
      reason: "every copy sits beyond the 1,500-character evidence window, so a miss is a source limit (cap_truncated), not a query question",
    };
  }
  const canonical = probes.filter((probe) => !probe.isBrief);
  if (canonical.length === 0) {
    return { corpusSupport, goldenQueryRetrieves: null, reason: "no canonical query was given" };
  }
  const reached = canonical.some((probe) => probe.firstVisibleRank !== null);

  return {
    corpusSupport,
    goldenQueryRetrieves: reached,
    reason: reached
      ? "a canonical keyword query puts a visible copy in the top 8"
      : "no canonical keyword query puts a visible copy in the top 8",
  };
}

function chunkLengthDistribution(corpus) {
  const lengths = corpus.chunks.map((chunk) => evidenceLength(chunk.chunkText)).sort((left, right) => left - right);
  const at = (share) => (lengths.length ? lengths[Math.min(lengths.length - 1, Math.floor(share * lengths.length))] : 0);
  const buckets = [];
  let low = 0;

  for (const high of [...LENGTH_BUCKETS, Infinity]) {
    buckets.push({
      label: high === Infinity ? `> ${low}` : `${low === 0 ? 0 : low + 1}-${high}`,
      count: lengths.filter((length) => length > low && length <= high).length + (low === 0 ? lengths.filter((length) => length === 0).length : 0),
    });
    low = high;
  }
  const over = lengths.filter((length) => length > EVIDENCE_WINDOW_CHARS).length;

  return {
    totalChunks: lengths.length,
    evidenceWindow: EVIDENCE_WINDOW_CHARS,
    overEvidenceWindow: over,
    overEvidenceWindowShare: lengths.length ? Number((over / lengths.length).toFixed(4)) : 0,
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: lengths.length ? lengths[lengths.length - 1] : 0,
    buckets,
  };
}

function s8Precondition(db) {
  const result = checkTimingBeltRefusalPrecondition(db);
  const byRule = {};

  for (const match of result.matches) {
    byRule[match.ruleId] = (byRule[match.ruleId] ?? 0) + 1;
  }
  const belt = /** @type {any} */ (
    db.prepare("SELECT COUNT(*) AS n FROM document_chunks WHERE chunk_text LIKE '%belt%'").get()
  );

  return {
    check: "checkTimingBeltRefusalPrecondition",
    holds: !result.stale,
    matchingChunks: result.matches.length,
    chunksMentioningBelt: Number(belt?.n ?? 0),
    byRule,
    matches: result.matches,
  };
}

/**
 * The whole survey from a read-only connection.
 *
 * @param {DatabaseSync} db opened with { readOnly: true }
 * @param {{ maxChunksPerSource?: number, extraProbes?: any[], scenarios?: any[] }} [options]
 */
export function buildPlannerCorpusSurvey(db, { maxChunksPerSource = DEFAULT_MAX_CHUNKS_PER_SOURCE, extraProbes = [], scenarios = PLANNER_SCENARIOS } = {}) {
  const corpus = loadCorpus(db);
  const briefOf = new Map(scenarios.map((scenario) => [scenario.id, scenario.brief]));
  const items = [];

  for (const scenario of scenarios) {
    for (const fact of scenario.facts) {
      const matcher = matcherForFact(fact);
      if (!matcher) {
        continue; // an absence fact is surveyed by the S8 precondition below
      }
      items.push({
        scenarioId: scenario.id,
        id: fact.id,
        source: "plannerScenarios",
        kind: fact.kind,
        concept: fact.concept,
        confirmed: fact.confirmed === true,
        matcher,
        queries: [
          { query: scenario.brief, isBrief: true },
          ...(CANONICAL_QUERIES[fact.id] ?? []).map((query) => ({ query, isBrief: false })),
        ],
      });
    }
  }

  for (const probe of extraProbes) {
    const brief = briefOf.get(probe.scenarioId);
    items.push({
      scenarioId: probe.scenarioId,
      id: probe.id,
      source: "probe-file",
      kind: probe.figures?.length ? "numeric_spec" : "procedure_step",
      concept: probe.concept,
      confirmed: false,
      matcher: matcherForProbe(probe),
      queries: [
        ...(brief ? [{ query: brief, isBrief: true }] : []),
        ...(probe.queries ?? []).map((query) => ({ query, isBrief: false })),
      ],
    });
  }

  return {
    readOnly: true,
    retrievalMode: "keyword",
    retrievalNote: "keyword ranking only (a copy of retrieveKeywordChunks); a live planner run ranks with hybrid retrieval",
    probeTopK: PROBE_TOP_K,
    maxChunksPerSource,
    totalDocuments: corpus.documents.size,
    chunkLengths: chunkLengthDistribution(corpus),
    s8Precondition: s8Precondition(db),
    facts: items.map((item) => surveyItem(corpus, item, { maxChunksPerSource })),
  };
}

// ---- Output --------------------------------------------------------------------------

/**
 * Aggregates only: counts, ranks, and fact ids. No title, no chunk text, not
 * even the matched phrase.
 *
 * @param {ReturnType<typeof buildPlannerCorpusSurvey>} report
 */
export function formatConsoleSummary(report) {
  const lengths = report.chunkLengths;
  const lines = [
    "Planner corpus survey (read-only, keyword ranking, no key)",
    `Documents: ${report.totalDocuments}   Chunks: ${lengths.totalChunks}   Per-source cap: ${report.maxChunksPerSource}`,
    "",
    `Chunk length vs the ${lengths.evidenceWindow}-character evidence window (whitespace collapsed):`,
    `  over the window: ${lengths.overEvidenceWindow} of ${lengths.totalChunks} (${(lengths.overEvidenceWindowShare * 100).toFixed(1)}%)`,
    `  p50 ${lengths.p50}   p90 ${lengths.p90}   p99 ${lengths.p99}   max ${lengths.max}`,
    `  ${lengths.buckets.map((bucket) => `${bucket.label}: ${bucket.count}`).join("   ")}`,
    "",
    `S8 precondition: ${report.s8Precondition.holds ? "HOLDS" : "BROKEN"} (${report.s8Precondition.matchingChunks} timing/cam/toothed-belt chunks; ${report.s8Precondition.chunksMentioningBelt} chunks mention "belt")`,
  ];

  for (const [rule, count] of Object.entries(report.s8Precondition.byRule)) {
    lines.push(`  ${rule}: ${count}`);
  }

  for (const fact of report.facts) {
    const s = fact.summary;
    lines.push(
      "",
      `${fact.scenarioId} / ${fact.factId} [${fact.source}${fact.confirmed ? ", confirmed" : ""}]`,
      `  candidates ${s.candidateChunks} chunks in ${s.distinctDocuments} documents (${s.distinctContentGroups} content groups); OCR ${s.fromOcr}; decoy in same chunk ${s.withDecoyInChunk}`,
      `  inside the evidence window ${s.visibleInEvidenceWindow}; beyond it only ${s.beyondEvidenceWindowOnly}; chunks over ${EVIDENCE_WINDOW_CHARS} chars ${s.chunksOverEvidenceWindow}`
    );
    for (const probe of fact.probes) {
      lines.push(
        `  probe ${probe.isBrief ? "(brief)" : "(canonical)"} "${probe.query}": first holding rank ${probe.firstHoldingRank ?? "-"}, first visible rank ${probe.firstVisibleRank ?? "-"}`
      );
    }
    lines.push(
      `  suggested: corpusSupport ${fact.suggested.corpusSupport ?? "null"}, goldenQueryRetrieves ${fact.suggested.goldenQueryRetrieves ?? "null"} (${fact.suggested.reason})`
    );
  }

  return lines.join("\n");
}

/**
 * One CSV cell; a leading = + - @ is prefixed so a spreadsheet shows it as text.
 *
 * @param {unknown} value
 */
function toCsvValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  let text = Array.isArray(value) ? value.join(";") : String(value).replace(/\r?\n/g, " ");
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  return /[",']/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const CSV_COLUMNS = [
  "scenarioId",
  "factId",
  "source",
  "documentId",
  "title",
  "storedFilename",
  "pageNumber",
  "chunkIndex",
  "chunkId",
  "extractionStatus",
  "contentGroupKey",
  "chunkLength",
  "inEvidenceWindow",
  "figuresInChunk",
  "decoysInChunk",
];

/** @param {ReturnType<typeof buildPlannerCorpusSurvey>} report */
export function buildCsvReport(report) {
  const rows = report.facts.flatMap((fact) =>
    fact.candidates.map((candidate) => ({ scenarioId: fact.scenarioId, factId: fact.factId, source: fact.source, ...candidate }))
  );
  return [CSV_COLUMNS.join(","), ...rows.map((row) => CSV_COLUMNS.map((column) => toCsvValue(row[column])).join(","))].join("\n");
}

/**
 * @param {string[]} argv
 * @returns {{ outputDir: string, probesFile: string, maxChunksPerSource: number }}
 */
export function parseArguments(argv = []) {
  const options = { outputDir: "", probesFile: "", maxChunksPerSource: DEFAULT_MAX_CHUNKS_PER_SOURCE };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = String(argv[index + 1] ?? "");

    if (argument === "--output-dir") {
      options.outputDir = next;
      index += 1;
    } else if (argument === "--probes") {
      options.probesFile = next;
      index += 1;
    } else if (argument === "--max-per-source") {
      const value = Number(next);
      options.maxChunksPerSource = Number.isInteger(value) && value >= 0 ? value : DEFAULT_MAX_CHUNKS_PER_SOURCE;
      index += 1;
    }
  }
  return options;
}

/**
 * @param {string[]} [argv]
 * @param {{ databaseFile?: string }} [overrides] tests name an invented library
 */
export async function runCli(argv = process.argv.slice(2), overrides = {}) {
  let db;

  try {
    const options = parseArguments(argv);
    // No default: a survey that guessed would guess the live database.
    const databaseFile = overrides.databaseFile || process.env.DATABASE_FILE || "";

    if (!databaseFile) {
      throw new Error("Set DATABASE_FILE to a VACUUM INTO snapshot of the database; the survey has no default.");
    }
    // Checked first so a mistyped path is an error, never a new empty file.
    if (!fs.existsSync(databaseFile)) {
      throw new Error(`Database file not found: ${databaseFile}`);
    }
    // npm --prefix runs this in server/, so a relative path is read from where the owner typed it.
    const base = process.env.INIT_CWD || process.cwd();
    const extraProbes = options.probesFile ? loadProbeFile(path.resolve(base, options.probesFile)) : [];

    db = new DatabaseSync(databaseFile, { readOnly: true });
    const report = {
      databaseFile,
      generatedAt: new Date().toISOString(),
      ...buildPlannerCorpusSurvey(db, { maxChunksPerSource: options.maxChunksPerSource, extraProbes }),
    };
    db.close();
    db = undefined;

    console.log(formatConsoleSummary(report));
    const outputDir = options.outputDir ? path.resolve(base, options.outputDir) : path.join(path.dirname(databaseFile), "diagnostics");
    fs.mkdirSync(outputDir, { recursive: true });
    const jsonPath = path.join(outputDir, "planner-corpus-survey.json");
    const csvPath = path.join(outputDir, "planner-corpus-survey.csv");
    fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    fs.writeFileSync(csvPath, `${buildCsvReport(report)}\n`, "utf8");
    console.log(`\nJSON report: ${jsonPath}\nCSV report:  ${csvPath}`);
  } catch (error) {
    console.error(/** @type {Error} */ (error)?.message || String(error));
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
