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

const clientPort = Number(process.env.CLIENT_PORT || 5173);
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
  openAiAnswerModel:
    process.env.OPENAI_ANSWER_MODEL || process.env.OPENAI_MODEL || "gpt-4.1",
  openAiEmbeddingModel,
  openAiEmbeddingDimensions,
  openAiEmbeddingVersion: `${openAiEmbeddingModel}@${openAiEmbeddingDimensions}`,
  openAiEmbeddingBatchSize: readPositiveInteger(
    process.env.OPENAI_EMBEDDING_BATCH_SIZE,
    64
  ),
  clientDistDir: path.join(projectRoot, "client", "dist"),
  databaseFile:
    process.env.DATABASE_FILE ||
    path.join(projectRoot, "server", "data", "corolla-fix-helper.db"),
  uploadsDir:
    process.env.UPLOADS_DIR ||
    path.join(projectRoot, "server", "uploads"),
};
