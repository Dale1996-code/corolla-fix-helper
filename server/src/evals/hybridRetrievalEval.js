import { db } from "../database.js";
import { initializeDatabase } from "../initDatabase.js";
import {
  clearChunkEmbeddingCache,
  float32ArrayToBuffer,
} from "../services/chunkEmbeddingService.js";
import {
  retrieveKeywordChunks,
  retrieveRelevantChunks,
} from "../services/chunkRetrievalService.js";
import { config } from "../config.js";

const EVAL_SOURCE = "Hybrid Retrieval Eval";

export const HYBRID_RETRIEVAL_EVAL_CASES = [
  {
    id: "oil-drain-plug-torque",
    question: "What is the oil drain plug torque?",
    expectedSpec: "27 ft-lb",
    expectedSpecPattern: "27 ft-lb",
    decoyPage: 1,
    expectedPage: 2,
    decoyText:
      "Oil drain plug torque torque torque lookup reminder. This page only says to inspect the old washer and does not give the tightening value.",
    correctText:
      "Engine oil service: install a new drain plug gasket. The drain plug tightening specification is 27 ft-lb.",
  },
  {
    id: "spark-plug-gap",
    question: "What is the spark plug gap?",
    expectedSpec: "0.044 inch",
    expectedSpecPattern: "0\\.044 inch",
    decoyPage: 3,
    expectedPage: 4,
    decoyText:
      "Spark plug gap gap gap index page. This page explains where spark plugs are located but does not list the gap.",
    correctText:
      "Ignition tune-up specification: set each plug electrode clearance to 0.044 inch before installation.",
  },
  {
    id: "transmission-fluid-type",
    question: "Which transmission fluid type is required?",
    expectedSpec: "Toyota ATF WS",
    expectedSpecPattern: "Toyota ATF WS",
    decoyPage: 5,
    expectedPage: 6,
    decoyText:
      "Transmission fluid type type type overview. This page warns not to mix fluids but gives no approved fluid name.",
    correctText:
      "Automatic transaxle refill note: use Toyota ATF WS only for the required service fluid.",
  },
  {
    id: "wheel-lug-nut-torque",
    question: "What is the wheel lug nut torque?",
    expectedSpec: "76 ft-lb",
    expectedSpecPattern: "76 ft-lb",
    decoyPage: 7,
    expectedPage: 8,
    decoyText:
      "Wheel lug nut torque torque torque reminder. This page says to tighten in a star pattern but omits the final value.",
    correctText:
      "Wheel installation specification: tighten the wheel nuts evenly to 76 ft-lb after lowering the vehicle.",
  },
  {
    id: "coolant-capacity",
    question: "What is the coolant capacity?",
    expectedSpec: "6.9 quarts",
    expectedSpecPattern: "6\\.9 quarts",
    decoyPage: 9,
    expectedPage: 10,
    decoyText:
      "Coolant capacity capacity capacity front matter. This page says to avoid spills but does not state the fill amount.",
    correctText:
      "Cooling system refill specification: total engine coolant fill quantity is 6.9 quarts.",
  },
  {
    id: "drive-belt-deflection",
    question: "How much drive belt deflection is allowed?",
    expectedSpec: "10 mm",
    expectedSpecPattern: "10 mm",
    decoyPage: 11,
    expectedPage: 12,
    decoyText:
      "Drive belt deflection deflection deflection check overview. This page says to inspect the belt ribs but gives no measurement.",
    correctText:
      "Accessory belt inspection: press midway between pulleys. The allowed movement is 10 mm.",
  },
  {
    id: "idle-relearn",
    question: "What is the throttle body idle relearn step?",
    expectedSpec: "idle air volume initialization",
    expectedSpecPattern: "idle air volume initialization",
    decoyPage: 13,
    expectedPage: 14,
    decoyText:
      "Throttle body idle relearn relearn relearn reference. This page only says to clean carbon from the bore.",
    correctText:
      "After throttle body service, perform idle air volume initialization and let the engine stabilize at operating temperature.",
  },
  {
    id: "front-caliper-torque",
    question: "What is the front brake caliper bolt torque?",
    expectedSpec: "25 ft-lb",
    expectedSpecPattern: "25 ft-lb",
    decoyPage: 15,
    expectedPage: 16,
    decoyText:
      "Front brake caliper bolt torque torque torque reminder. This page describes pad wear checks but not the bolt value.",
    correctText:
      "Front disc brake installation: tighten the caliper slide pin bolts to 25 ft-lb.",
  },
  {
    id: "charging-voltage",
    question: "What charging voltage should the alternator show?",
    expectedSpec: "13.8 to 14.5 volts",
    expectedSpecPattern: "13\\.8 to 14\\.5 volts",
    decoyPage: 17,
    expectedPage: 18,
    decoyText:
      "Charging voltage alternator alternator voltage voltage diagnostic notes. This page says to inspect the belt and battery terminals.",
    correctText:
      "Charging system test: with the engine idling, normal generator output is 13.8 to 14.5 volts.",
  },
  {
    id: "camshaft-sensor-resistance",
    question: "What is the camshaft position sensor resistance?",
    expectedSpec: "835 to 1400 ohms",
    expectedSpecPattern: "835 to 1400 ohms",
    decoyPage: 19,
    expectedPage: 20,
    decoyText:
      "Camshaft position sensor resistance resistance resistance connector location. This page says to disconnect the harness first.",
    correctText:
      "CMP sensor bench check: resistance across the sensor terminals should be 835 to 1400 ohms at room temperature.",
  },
  {
    id: "oxygen-sensor-heater-resistance",
    question: "What is the oxygen sensor heater resistance?",
    expectedSpec: "11 to 16 ohms",
    expectedSpecPattern: "11 to 16 ohms",
    decoyPage: 21,
    expectedPage: 22,
    decoyText:
      "Oxygen sensor heater resistance resistance resistance inspection heading. This page identifies connector pins but omits the range.",
    correctText:
      "Heated oxygen sensor test: heater circuit resistance should measure 11 to 16 ohms.",
  },
  {
    id: "thermostat-opening-temperature",
    question: "What is the thermostat opening temperature?",
    expectedSpec: "176 to 183 F",
    expectedSpecPattern: "176 to 183 F",
    decoyPage: 23,
    expectedPage: 24,
    decoyText:
      "Thermostat opening temperature temperature temperature removal notes. This page says to drain coolant before removal.",
    correctText:
      "Thermostat inspection: the valve begins to open at 176 to 183 F in the hot water test.",
  },
];

function insertEvalDocument({ title, originalFilename, pageCount }) {
  const vehicle = db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get();

  const result = db
    .prepare(`
      INSERT INTO documents (
        vehicle_id,
        title,
        original_filename,
        stored_filename,
        file_path,
        file_type,
        system,
        document_type,
        source,
        extracted_text,
        extraction_status,
        page_count
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      vehicle.id,
      title,
      originalFilename,
      originalFilename,
      `server/uploads/${originalFilename}`,
      "application/pdf",
      "Engine",
      "Repair Manual",
      EVAL_SOURCE,
      "",
      "completed",
      pageCount
    );

  return Number(result.lastInsertRowid);
}

function insertEvalChunk({ documentId, pageNumber, chunkIndex, chunkText, embedding }) {
  db.prepare(`
    INSERT INTO document_chunks (
      document_id,
      page_number,
      chunk_index,
      chunk_text,
      embedding,
      embedding_version
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    documentId,
    pageNumber,
    chunkIndex,
    chunkText,
    float32ArrayToBuffer(embedding),
    config.openAiEmbeddingVersion
  );
}

function deletePriorEvalRows() {
  db.prepare(`
    DELETE FROM document_chunks
    WHERE document_id IN (
      SELECT id FROM documents WHERE source = ?
    )
  `).run(EVAL_SOURCE);

  db.prepare(`
    DELETE FROM documents
    WHERE source = ?
  `).run(EVAL_SOURCE);
}

function makeEmptyVector() {
  return new Float32Array(config.openAiEmbeddingDimensions);
}

export function createDeterministicEvalEmbedding(text, { kind } = {}) {
  const normalizedText = String(text || "").toLowerCase();
  const vector = makeEmptyVector();

  for (let index = 0; index < HYBRID_RETRIEVAL_EVAL_CASES.length; index += 1) {
    const evalCase = HYBRID_RETRIEVAL_EVAL_CASES[index];
    const expectedSpecMatches = new RegExp(evalCase.expectedSpecPattern, "i").test(text);

    if (kind === "query" && normalizedText === evalCase.question.toLowerCase()) {
      vector[index] = 1;
    }

    if (kind === "chunk" && expectedSpecMatches) {
      vector[index] = 1;
    }
  }

  return vector;
}

function seedEvalCorpus({ distractorDocumentCount }) {
  initializeDatabase();
  deletePriorEvalRows();

  const expectedSources = new Map();

  db.exec("BEGIN IMMEDIATE TRANSACTION");

  try {
    for (const evalCase of HYBRID_RETRIEVAL_EVAL_CASES) {
      const documentId = insertEvalDocument({
        title: `Hybrid Eval ${evalCase.id}`,
        originalFilename: `hybrid-eval-${evalCase.id}.pdf`,
        pageCount: Math.max(evalCase.decoyPage, evalCase.expectedPage),
      });

      insertEvalChunk({
        documentId,
        pageNumber: evalCase.decoyPage,
        chunkIndex: 0,
        chunkText: evalCase.decoyText,
        embedding: createDeterministicEvalEmbedding(evalCase.decoyText, {
          kind: "chunk",
        }),
      });
      insertEvalChunk({
        documentId,
        pageNumber: evalCase.expectedPage,
        chunkIndex: 0,
        chunkText: evalCase.correctText,
        embedding: createDeterministicEvalEmbedding(evalCase.correctText, {
          kind: "chunk",
        }),
      });

      expectedSources.set(evalCase.id, {
        documentId,
        pageNumber: evalCase.expectedPage,
      });
    }

    for (let index = 0; index < distractorDocumentCount; index += 1) {
      const documentId = insertEvalDocument({
        title: `Hybrid Eval Distractor ${String(index + 1).padStart(4, "0")}`,
        originalFilename: `hybrid-eval-distractor-${String(index + 1).padStart(4, "0")}.pdf`,
        pageCount: 1,
      });

      insertEvalChunk({
        documentId,
        pageNumber: 1,
        chunkIndex: 0,
        chunkText:
          "Generic archive reference for unrelated trim clips, cabin labels, and service category notes.",
        embedding: makeEmptyVector(),
      });
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  clearChunkEmbeddingCache();
  return expectedSources;
}

function summarizeTopResult(result) {
  if (!result) {
    return null;
  }

  return {
    documentId: result.documentId,
    documentTitle: result.documentTitle,
    pageNumber: result.pageNumber,
    chunkIndex: result.chunkIndex,
    chunkText: result.chunkText,
    keywordScore: result.keywordScore,
    semanticScore: result.semanticScore,
    hybridScore: result.hybridScore,
  };
}

function isExpectedTopResult(result, expectedSource) {
  return (
    Boolean(result) &&
    result.documentId === expectedSource.documentId &&
    result.pageNumber === expectedSource.pageNumber
  );
}

/**
 * Label one hybrid-vs-rerank outcome so an A/B run reads at a glance.
 *
 *   both_right    fusion already had it; rerank kept it
 *   rerank_fixed  fusion got it wrong; rerank moved the right chunk to the top
 *   rerank_broke  fusion had it right; rerank pushed the right chunk down
 *   both_wrong    neither put the expected chunk on top
 */
export function classifyRerankAb({ fusionCorrect, rerankCorrect }) {
  if (fusionCorrect && rerankCorrect) {
    return "both_right";
  }

  if (!fusionCorrect && rerankCorrect) {
    return "rerank_fixed";
  }

  if (fusionCorrect && !rerankCorrect) {
    return "rerank_broke";
  }

  return "both_wrong";
}

/**
 * A/B the fusion-only retrieval against reranked retrieval on the same corpus.
 *
 * The reranker is injectable (`rerank`) so tests pass a deterministic mock and
 * never need an API key; a local run can pass the real `rerankChunks`. The query
 * embedding is the same deterministic stub the hybrid eval uses.
 */
export async function runRerankAbEval({
  distractorDocumentCount = 50,
  rerank,
  createQueryEmbedding = async (question) =>
    createDeterministicEvalEmbedding(question, { kind: "query" }),
} = {}) {
  const expectedSources = seedEvalCorpus({ distractorDocumentCount });
  const items = [];

  for (const evalCase of HYBRID_RETRIEVAL_EVAL_CASES) {
    const expectedSource = expectedSources.get(evalCase.id);

    const fusionResults = await retrieveRelevantChunks(evalCase.question, {
      limit: 5,
      mode: "hybrid",
      createQueryEmbedding,
      rerankEnabled: false,
    });

    const rerankedResults = await retrieveRelevantChunks(evalCase.question, {
      limit: 5,
      mode: "hybrid",
      createQueryEmbedding,
      rerankEnabled: true,
      rerankCandidateLimit: 20,
      ...(rerank ? { rerank } : {}),
    });

    const fusionCorrect = isExpectedTopResult(fusionResults[0] || null, expectedSource);
    const rerankCorrect = isExpectedTopResult(rerankedResults[0] || null, expectedSource);
    const label = classifyRerankAb({ fusionCorrect, rerankCorrect });

    items.push({
      id: evalCase.id,
      question: evalCase.question,
      expectedSpec: evalCase.expectedSpec,
      expectedPage: evalCase.expectedPage,
      fusionCorrect,
      rerankCorrect,
      label,
      fusionTop: summarizeTopResult(fusionResults[0] || null),
      rerankTop: summarizeTopResult(rerankedResults[0] || null),
    });
  }

  return {
    summary: {
      evalCaseCount: HYBRID_RETRIEVAL_EVAL_CASES.length,
      distractorDocumentCount,
      bothRight: items.filter((item) => item.label === "both_right").length,
      rerankFixed: items.filter((item) => item.label === "rerank_fixed").length,
      rerankBroke: items.filter((item) => item.label === "rerank_broke").length,
      bothWrong: items.filter((item) => item.label === "both_wrong").length,
    },
    items,
  };
}

export async function runHybridRetrievalEval({ distractorDocumentCount = 2500 } = {}) {
  const expectedSources = seedEvalCorpus({ distractorDocumentCount });
  const items = [];

  for (const evalCase of HYBRID_RETRIEVAL_EVAL_CASES) {
    const expectedSource = expectedSources.get(evalCase.id);
    const keywordResults = retrieveKeywordChunks(evalCase.question, { limit: 5 });
    const hybridResults = await retrieveRelevantChunks(evalCase.question, {
      limit: 5,
      createQueryEmbedding: async (question) =>
        createDeterministicEvalEmbedding(question, { kind: "query" }),
    });
    const keywordTop = keywordResults[0] || null;
    const hybridTop = hybridResults[0] || null;
    const keywordCorrect = isExpectedTopResult(keywordTop, expectedSource);
    const hybridCorrect = isExpectedTopResult(hybridTop, expectedSource);

    items.push({
      id: evalCase.id,
      question: evalCase.question,
      expectedSpec: evalCase.expectedSpec,
      expectedSpecPattern: evalCase.expectedSpecPattern,
      expectedPage: evalCase.expectedPage,
      keywordCorrect,
      hybridCorrect,
      fixedWrongPage: !keywordCorrect && hybridCorrect,
      keywordTop: summarizeTopResult(keywordTop),
      hybridTop: summarizeTopResult(hybridTop),
    });
  }

  return {
    summary: {
      evalCaseCount: HYBRID_RETRIEVAL_EVAL_CASES.length,
      distractorDocumentCount,
      keywordWrongHybridRight: items.filter((item) => item.fixedWrongPage).length,
      keywordWrong: items.filter((item) => !item.keywordCorrect).length,
      hybridWrong: items.filter((item) => !item.hybridCorrect).length,
    },
    items,
  };
}
