// CLI: end-to-end backup + restore drill with fake data.
//
//   npm run backup:drill
//
// An export you cannot restore is not a real backup. This drill proves the
// round trip on a throwaway install so it never touches your real data:
//
//   1. Build a temp install (temp DATABASE_FILE + UPLOADS_DIR).
//   2. Seed fake documents, symptoms, procedures, notes, and a fake PDF.
//   3. Export a .tar.gz backup.
//   4. Wipe the database and uploads (simulate data loss).
//   5. Restore from the backup.
//   6. Assert the rows and the PDF bytes came back intact.
//
// Exits non-zero if any assertion fails.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  createBackupArchive,
  restoreBackup,
} from "../services/backupService.js";

const FAKE_PDF_BYTES = Buffer.from(
  "%PDF-1.4\n% Fake Corolla drill PDF\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n",
  "utf8"
);

// First bytes of a PNG file header; enough to prove the image folder round-trips.
const FAKE_IMAGE_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x44, 0x52, 0x49, 0x4c, 0x4c,
]);

// Where attachmentService stores image uploads, relative to the uploads dir.
const ATTACHMENT_IMAGE_RELPATH = path.join(
  "attachments",
  "images",
  "drill-symptom-photo.png"
);

function seedFakeData({ databaseFile, uploadsDir }) {
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });

  const storedFilename = "drill-brake-guide.pdf";
  fs.writeFileSync(path.join(uploadsDir, storedFilename), FAKE_PDF_BYTES);

  const attachmentImagePath = path.join(uploadsDir, ATTACHMENT_IMAGE_RELPATH);
  fs.mkdirSync(path.dirname(attachmentImagePath), { recursive: true });
  fs.writeFileSync(attachmentImagePath, FAKE_IMAGE_BYTES);

  const db = new DatabaseSync(databaseFile);

  db.exec(`
    CREATE TABLE vehicles (id INTEGER PRIMARY KEY, year INTEGER, make TEXT, model TEXT);
    CREATE TABLE documents (id INTEGER PRIMARY KEY, title TEXT, stored_filename TEXT);
    CREATE TABLE symptoms (id INTEGER PRIMARY KEY, title TEXT);
    CREATE TABLE procedures (id INTEGER PRIMARY KEY, title TEXT);
    CREATE TABLE notes (id INTEGER PRIMARY KEY, content TEXT);
  `);

  db.prepare("INSERT INTO vehicles (year, make, model) VALUES (?, ?, ?)").run(
    2009,
    "Toyota",
    "Corolla"
  );
  db.prepare("INSERT INTO documents (title, stored_filename) VALUES (?, ?)").run(
    "Brake Service Guide",
    storedFilename
  );
  db.prepare("INSERT INTO symptoms (title) VALUES (?)").run("Squealing brakes");
  db.prepare("INSERT INTO procedures (title) VALUES (?)").run(
    "Replace front brake pads"
  );
  db.prepare("INSERT INTO notes (content) VALUES (?)").run(
    "Torque caliper bolts to spec."
  );

  const counts = readCounts(db);
  db.close();

  return { storedFilename, counts };
}

function readCounts(db) {
  const count = (table) =>
    db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

  return {
    vehicles: count("vehicles"),
    documents: count("documents"),
    symptoms: count("symptoms"),
    procedures: count("procedures"),
    notes: count("notes"),
  };
}

async function runDrill() {
  const drillRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "corolla-fix-helper-drill-")
  );
  const databaseFile = path.join(drillRoot, "data", "corolla-fix-helper.db");
  const uploadsDir = path.join(drillRoot, "uploads");
  const archivePath = path.join(drillRoot, "drill-backup.tar.gz");

  try {
    console.log("1. Seeding fake data ...");
    const { storedFilename, counts: seededCounts } = seedFakeData({
      databaseFile,
      uploadsDir,
    });
    console.log(`   seeded ${JSON.stringify(seededCounts)} + 1 PDF`);

    console.log("2. Exporting backup ...");
    await createBackupArchive({ databaseFile, uploadsDir, outFile: archivePath });
    assert.ok(fs.existsSync(archivePath), "backup archive should exist");

    console.log("3. Wiping live data ...");
    fs.rmSync(databaseFile, { force: true });
    fs.rmSync(uploadsDir, { recursive: true, force: true });
    assert.ok(!fs.existsSync(databaseFile), "database should be gone");
    assert.ok(!fs.existsSync(uploadsDir), "uploads should be gone");

    console.log("4. Restoring from backup ...");
    await restoreBackup({
      archivePath,
      databaseFile,
      uploadsDir,
      keepSnapshot: false,
    });

    console.log("5. Verifying round-trip integrity ...");
    const restoredDb = new DatabaseSync(databaseFile);
    const restoredCounts = readCounts(restoredDb);
    restoredDb.close();
    assert.deepEqual(
      restoredCounts,
      seededCounts,
      "row counts should match after restore"
    );

    const restoredPdf = fs.readFileSync(path.join(uploadsDir, storedFilename));
    assert.ok(
      restoredPdf.equals(FAKE_PDF_BYTES),
      "restored PDF bytes should match the original"
    );

    const restoredImage = fs.readFileSync(
      path.join(uploadsDir, ATTACHMENT_IMAGE_RELPATH)
    );
    assert.ok(
      restoredImage.equals(FAKE_IMAGE_BYTES),
      "restored attachment image bytes should match the original"
    );

    console.log("");
    console.log(
      "Backup + restore drill PASSED. Data, PDF, and attachment image came back intact."
    );
  } finally {
    fs.rmSync(drillRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runDrill();
  } catch (error) {
    console.error("");
    console.error(`Backup + restore drill FAILED: ${error.message || error}`);
    process.exitCode = 1;
  }
}
