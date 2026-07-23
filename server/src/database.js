import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

fs.mkdirSync(path.dirname(config.databaseFile), { recursive: true });
fs.mkdirSync(config.uploadsDir, { recursive: true });

export const db = new DatabaseSync(config.databaseFile);

db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
// Wait briefly for a competing writer instead of failing immediately with
// SQLITE_BUSY (e.g. an import/backfill script running alongside the server).
db.exec("PRAGMA busy_timeout = 5000;");
