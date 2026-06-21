import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  BackupValidationError,
  SQLITE_HEADER,
  createBackupArchive,
  restoreBackup,
  validateExtractedBackup,
} from "../src/services/backupService.js";

let tempRoot;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-backup-test-"));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function fakeSqliteFile(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from(`${SQLITE_HEADER}${payload}`, "latin1"));
}

// Lay out a valid extracted-backup directory: database/<name>.db + uploads/.
function writeBackupSource(rootDir, { dbPayload, uploadFiles, manifest }) {
  const databaseDir = path.join(rootDir, "database");
  const uploadsDir = path.join(rootDir, "uploads");
  fakeSqliteFile(path.join(databaseDir, "corolla-fix-helper.db"), dbPayload);
  fs.mkdirSync(uploadsDir, { recursive: true });

  for (const [name, contents] of Object.entries(uploadFiles || {})) {
    fs.writeFileSync(path.join(uploadsDir, name), contents);
  }

  if (manifest) {
    fs.writeFileSync(
      path.join(rootDir, "manifest.json"),
      JSON.stringify(manifest)
    );
  }
}

// Build an injectable extractArchive that copies a prepared directory into the
// restore work dir, so tests never need a real tar binary.
function extractorFrom(sourceDir) {
  return async (_archivePath, destDir) => {
    fs.cpSync(sourceDir, destDir, { recursive: true });
  };
}

function setupLiveInstall() {
  const databaseFile = path.join(tempRoot, "live", "data", "app.db");
  const uploadsDir = path.join(tempRoot, "live", "uploads");
  fakeSqliteFile(databaseFile, "ORIGINAL-DB");
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.writeFileSync(path.join(uploadsDir, "old.pdf"), "OLD-PDF");

  const archivePath = path.join(tempRoot, "backup.tar.gz");
  fs.writeFileSync(archivePath, "stand-in archive bytes");

  return { databaseFile, uploadsDir, archivePath };
}

test("createBackupArchive captures rows still held in the WAL sidecar", async () => {
  const databaseFile = path.join(tempRoot, "live", "data", "app.db");
  const uploadsDir = path.join(tempRoot, "live", "uploads");
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });

  // Open the database exactly as the running server does: WAL mode, with the
  // connection kept open. Disable auto-checkpoint so the newest committed row
  // stays in the `-wal` sidecar and never reaches the main `.db` file — the
  // precise condition under which a raw file copy would lose data.
  const db = new DatabaseSync(databaseFile);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA wal_autocheckpoint = 0;");
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, content TEXT);");
  db.prepare("INSERT INTO notes (content) VALUES (?)").run("checkpointed note");
  db.prepare("INSERT INTO notes (content) VALUES (?)").run("wal-only note");

  // Sanity check: the committed row really is absent from the on-disk main
  // file, so a plain copy of that file would silently drop it.
  const mainFileBytes = fs.readFileSync(databaseFile, "latin1");
  assert.ok(
    !mainFileBytes.includes("wal-only note"),
    "test setup invalid: WAL row already checkpointed into the main file"
  );

  // Capture the staged database the archive step would tar up.
  let stagedDatabaseFile = null;
  const createArchive = async (stagingDir) => {
    const databaseDir = path.join(stagingDir, "database");
    const [name] = fs.readdirSync(databaseDir);
    stagedDatabaseFile = path.join(tempRoot, "verify.db");
    fs.copyFileSync(path.join(databaseDir, name), stagedDatabaseFile);
  };

  await createBackupArchive({
    databaseFile,
    uploadsDir,
    outFile: path.join(tempRoot, "backup.tar.gz"),
    createArchive,
    db,
  });

  db.close();

  // The exported snapshot must contain both the checkpointed row and the
  // WAL-only row.
  const exported = new DatabaseSync(stagedDatabaseFile);
  const rows = exported
    .prepare("SELECT content FROM notes ORDER BY id")
    .all()
    .map((row) => row.content);
  exported.close();

  assert.deepEqual(rows, ["checkpointed note", "wal-only note"]);
});

test("validateExtractedBackup accepts a well-formed backup", () => {
  const sourceDir = path.join(tempRoot, "src");
  writeBackupSource(sourceDir, {
    dbPayload: "DB",
    uploadFiles: { "a.pdf": "A" },
    manifest: { formatVersion: 1 },
  });

  const result = validateExtractedBackup(sourceDir);

  assert.equal(result.manifest.formatVersion, 1);
  assert.ok(result.databaseFile.endsWith(".db"));
});

test("validateExtractedBackup rejects a non-SQLite database file", () => {
  const sourceDir = path.join(tempRoot, "src");
  const databaseDir = path.join(sourceDir, "database");
  fs.mkdirSync(databaseDir, { recursive: true });
  fs.writeFileSync(path.join(databaseDir, "app.db"), "not a database");
  fs.mkdirSync(path.join(sourceDir, "uploads"), { recursive: true });

  assert.throws(
    () => validateExtractedBackup(sourceDir),
    BackupValidationError
  );
});

test("validateExtractedBackup rejects a missing uploads directory", () => {
  const sourceDir = path.join(tempRoot, "src");
  fakeSqliteFile(path.join(sourceDir, "database", "app.db"), "DB");

  assert.throws(
    () => validateExtractedBackup(sourceDir),
    /uploads\/ directory/
  );
});

test("validateExtractedBackup rejects a too-new format version", () => {
  const sourceDir = path.join(tempRoot, "src");
  writeBackupSource(sourceDir, {
    dbPayload: "DB",
    uploadFiles: {},
    manifest: { formatVersion: 999 },
  });

  assert.throws(() => validateExtractedBackup(sourceDir), /newer than/);
});

test("restoreBackup swaps in the backup database and uploads", async () => {
  const { databaseFile, uploadsDir, archivePath } = setupLiveInstall();

  const sourceDir = path.join(tempRoot, "src");
  writeBackupSource(sourceDir, {
    dbPayload: "RESTORED-DB",
    uploadFiles: { "new.pdf": "NEW-PDF" },
    manifest: { formatVersion: 1 },
  });

  const result = await restoreBackup({
    archivePath,
    databaseFile,
    uploadsDir,
    extractArchive: extractorFrom(sourceDir),
  });

  assert.match(fs.readFileSync(databaseFile, "latin1"), /RESTORED-DB/);
  assert.equal(fs.readFileSync(path.join(uploadsDir, "new.pdf"), "utf8"), "NEW-PDF");
  // The old upload is gone after the swap.
  assert.ok(!fs.existsSync(path.join(uploadsDir, "old.pdf")));
  assert.ok(result.snapshotDir && fs.existsSync(result.snapshotDir));
});

test("restoreBackup keeps a recoverable snapshot of the prior data", async () => {
  const { databaseFile, uploadsDir, archivePath } = setupLiveInstall();

  const sourceDir = path.join(tempRoot, "src");
  writeBackupSource(sourceDir, { dbPayload: "RESTORED-DB", uploadFiles: {} });

  const { snapshotDir } = await restoreBackup({
    archivePath,
    databaseFile,
    uploadsDir,
    extractArchive: extractorFrom(sourceDir),
  });

  const snapshotDb = path.join(snapshotDir, "database", path.basename(databaseFile));
  const snapshotUpload = path.join(snapshotDir, "uploads", "old.pdf");
  assert.match(fs.readFileSync(snapshotDb, "latin1"), /ORIGINAL-DB/);
  assert.equal(fs.readFileSync(snapshotUpload, "utf8"), "OLD-PDF");
});

test("restoreBackup rejects a corrupt archive without touching live data", async () => {
  const { databaseFile, uploadsDir, archivePath } = setupLiveInstall();

  // Corrupt source: database file is not a real SQLite file.
  const sourceDir = path.join(tempRoot, "src");
  const databaseDir = path.join(sourceDir, "database");
  fs.mkdirSync(databaseDir, { recursive: true });
  fs.writeFileSync(path.join(databaseDir, "app.db"), "garbage");
  fs.mkdirSync(path.join(sourceDir, "uploads"), { recursive: true });

  await assert.rejects(
    restoreBackup({
      archivePath,
      databaseFile,
      uploadsDir,
      extractArchive: extractorFrom(sourceDir),
    }),
    BackupValidationError
  );

  // Live data is untouched.
  assert.match(fs.readFileSync(databaseFile, "latin1"), /ORIGINAL-DB/);
  assert.equal(fs.readFileSync(path.join(uploadsDir, "old.pdf"), "utf8"), "OLD-PDF");
});

test("restoreBackup rolls back to the snapshot when the swap fails", async () => {
  const { databaseFile, uploadsDir, archivePath } = setupLiveInstall();

  const sourceDir = path.join(tempRoot, "src");
  writeBackupSource(sourceDir, {
    dbPayload: "RESTORED-DB",
    uploadFiles: { "new.pdf": "NEW-PDF" },
  });

  // Wrap fs so that copying the *extracted* uploads into the live dir fails
  // (simulating a mid-swap error), while snapshot and rollback copies succeed.
  const brokenFs = {
    ...fs,
    cpSync(source, destination, options) {
      if (source.includes("corolla-fix-helper-restore-")) {
        throw new Error("simulated swap failure");
      }
      return fs.cpSync(source, destination, options);
    },
  };

  await assert.rejects(
    restoreBackup({
      archivePath,
      databaseFile,
      uploadsDir,
      fs: brokenFs,
      extractArchive: extractorFrom(sourceDir),
      keepSnapshot: false,
    }),
    /simulated swap failure/
  );

  // The database and uploads were rolled back to their original contents.
  assert.match(fs.readFileSync(databaseFile, "latin1"), /ORIGINAL-DB/);
  assert.equal(fs.readFileSync(path.join(uploadsDir, "old.pdf"), "utf8"), "OLD-PDF");
  assert.ok(!fs.existsSync(path.join(uploadsDir, "new.pdf")));
});
