// Explicitly load the demo/sample workspace data (a sample maintenance document
// with retrievable chunks). This is intentionally kept out of normal startup so
// a real workspace stays empty until the user adds their own documents.
//
// Usage: npm run demo:seed
import { db } from "../database.js";
import { initializeDatabase, seedDemoData } from "../initDatabase.js";

initializeDatabase();
seedDemoData();

const documentCount = db
  .prepare("SELECT COUNT(*) AS count FROM documents")
  .get().count;

console.log(`Demo data seeded. Documents in workspace: ${documentCount}.`);
