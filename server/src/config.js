import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(serverRoot, "..");

function readPositiveInteger(value, fallback) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readBoolean(value, fallback) {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }

  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

// Like readPositiveInteger but allows 0 as an explicit "disabled" value (the
// daily AI ceiling uses 0/negative to mean "no limit").
function readNonNegativeInteger(value, fallback) {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

const clientPort = Number(process.env.CLIENT_PORT || 5173);
const openAiAnswerModel =
  process.env.OPENAI_ANSWER_MODEL || process.env.OPENAI_MODEL || "gpt-4.1";
// The optional Ask reranker reuses the answer model unless OPENAI_RERANK_MODEL
// is set, so enabling it needs no extra model configuration.
const openAiRerankModel = process.env.OPENAI_RERANK_MODEL || openAiAnswerModel;
const openAiEmbeddingModel =
  process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const openAiEmbeddingDimensions = readPositiveInteger(
  process.env.OPENAI_EMBEDDING_DIMENSIONS,
  512
);

// Default-safe binding: loopback only. Reaching the app from a phone or another
// LAN/Tailscale device is a deliberate opt-in (NETWORK_MODE=1), so the network
// port is never the default state. See docs/mobile-access.md.
const networkMode = readBoolean(process.env.NETWORK_MODE, false);

export const config = {
  port: Number(process.env.PORT || 4000),
  networkMode,
  host: networkMode ? "0.0.0.0" : "127.0.0.1",
  clientPort,
  corsOrigin: process.env.CORS_ORIGIN || `http://localhost:${clientPort}`,
  maxUploadSizeMb: Number(process.env.MAX_UPLOAD_SIZE_MB || 20),
  openAiApiKey: typeof process.env.OPENAI_API_KEY === "string" ? process.env.OPENAI_API_KEY : "",
  // Accidental-spend guards (not abuse defense — single-user, trusted-LAN app):
  // cap tokens per model reply, bound a stalled stream, and a coarse daily call
  // ceiling as a runaway-loop backstop. Set AI_DAILY_CALL_LIMIT=0 to disable.
  openAiMaxOutputTokens: readPositiveInteger(process.env.OPENAI_MAX_OUTPUT_TOKENS, 2048),
  openAiStreamIdleTimeoutMs: readPositiveInteger(
    process.env.OPENAI_STREAM_IDLE_TIMEOUT_MS,
    30_000
  ),
  openAiDailyCallLimit: readNonNegativeInteger(process.env.AI_DAILY_CALL_LIMIT, 500),
  openAiAnswerModel,
  // Vision Ask reuses the answer model unless OPENAI_VISION_MODEL is set, so a
  // text-only deployment needs no extra configuration.
  openAiVisionModel: process.env.OPENAI_VISION_MODEL || openAiAnswerModel,
  // Dev-only Ask visibility. When on, Ask attaches a log-safe `metrics` object
  // (durations, counts, sizes, numeric IDs — never document text) to the service
  // result and the /api/ask response. Off by default so the response shape and
  // logs are unchanged in normal use.
  askDebugMetrics: readBoolean(process.env.ASK_DEBUG_METRICS, false),
  // Optional LLM reranker over hybrid retrieval results. Off by default; when on
  // it reorders a bounded candidate pool before the final limit slice.
  rerankEnabled: readBoolean(process.env.RERANK_ENABLED, false),
  // Ask evidence contract: structured atomic claims, each with a verbatim quote
  // the server verifies against the cited chunk, plus a numeric anomaly
  // detector. Off by default -- with the flag off the Ask response is
  // byte-identical to before (pinned by test).
  askEvidenceContract: readBoolean(process.env.ASK_EVIDENCE_CONTRACT, false),
  // Per-chunk relevance floor. SHADOW BY DEFAULT: it computes what it would drop
  // and reports that through Ask metrics, but changes nothing until the
  // threshold has been calibrated on a real corpus (npm run eval:relevance-floor).
  askRelevanceFloor: readBoolean(process.env.ASK_RELEVANCE_FLOOR, false),
  rerankCandidateLimit: readPositiveInteger(process.env.RERANK_CANDIDATE_LIMIT, 20),
  openAiRerankModel,
  openAiEmbeddingModel,
  openAiEmbeddingDimensions,
  openAiEmbeddingVersion: `${openAiEmbeddingModel}@${openAiEmbeddingDimensions}`,
  openAiEmbeddingBatchSize: readPositiveInteger(
    process.env.OPENAI_EMBEDDING_BATCH_SIZE,
    64
  ),
  ocrEnabled: readBoolean(process.env.OCR_ENABLED, true),
  ocrMinTextCharacters: readPositiveInteger(process.env.OCR_MIN_TEXT_CHARACTERS, 20),
  ocrDpi: readPositiveInteger(process.env.OCR_DPI, 300),
  ocrLanguage: process.env.OCR_LANGUAGE || "eng",
  ocrTesseractCommand: process.env.OCR_TESSERACT_COMMAND || "tesseract",
  ocrPdftoppmCommand: process.env.OCR_PDFTOPPM_COMMAND || "pdftoppm",
  clientDistDir: path.join(projectRoot, "client", "dist"),
  databaseFile:
    process.env.DATABASE_FILE ||
    path.join(projectRoot, "server", "data", "corolla-fix-helper.db"),
  uploadsDir:
    process.env.UPLOADS_DIR ||
    path.join(projectRoot, "server", "uploads"),
};
