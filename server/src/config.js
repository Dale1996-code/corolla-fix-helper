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

export const config = {
  port: Number(process.env.PORT || 4000),
  clientPort,
  corsOrigin: process.env.CORS_ORIGIN || `http://localhost:${clientPort}`,
  maxUploadSizeMb: Number(process.env.MAX_UPLOAD_SIZE_MB || 20),
  openAiApiKey: typeof process.env.OPENAI_API_KEY === "string" ? process.env.OPENAI_API_KEY : "",
  openAiAnswerModel,
  // Vision Ask reuses the answer model unless OPENAI_VISION_MODEL is set, so a
  // text-only deployment needs no extra configuration.
  openAiVisionModel: process.env.OPENAI_VISION_MODEL || openAiAnswerModel,
  // Optional LLM reranker over hybrid retrieval results. Off by default; when on
  // it reorders a bounded candidate pool before the final limit slice.
  rerankEnabled: readBoolean(process.env.RERANK_ENABLED, false),
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
