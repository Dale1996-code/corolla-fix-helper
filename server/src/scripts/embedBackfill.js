import { db } from "../database.js";
import { initializeDatabase } from "../initDatabase.js";
import { backfillChunkEmbeddings } from "../services/chunkEmbeddingService.js";

function printSummary(summary) {
  console.log("Embedding backfill complete.");
  console.log(`Embedding version: ${summary.embeddingVersion}`);
  console.log(`Total chunks checked: ${summary.totalChunks}`);
  console.log(`Already current: ${summary.skippedCurrentVersion}`);
  console.log(`Pending before run: ${summary.pendingChunks}`);
  console.log(`Embedded this run: ${summary.embeddedChunks}`);
}

try {
  initializeDatabase();
  const summary = await backfillChunkEmbeddings();
  printSummary(summary);
} finally {
  if (typeof db.close === "function") {
    db.close();
  }
}
