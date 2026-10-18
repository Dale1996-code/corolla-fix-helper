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

// Create a genuinely valid workspace database: a real SQLite file containing
// the required application tables, plus a marker row carrying `payload` so the
// existing byte-content assertions (e.g. /RESTORED-DB/) still match the file.
function realSqliteFile(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE documents (id INTEGER PRIMARY KEY);
    CREATE TABLE symptoms (id INTEGER PRIMARY KEY);
    CREATE TABLE procedures (id INTEGER PRIMARY KEY);
    CREATE TABLE backup_marker (label TEXT);
  `);
  db.prepare("INSERT INTO backup_marker (label) VALUES (?)").run(payload);
  db.close();
}

// Lay out a valid extracted-backup directory: database/<name>.db + uploads/.
function writeBackupSource(rootDir, { dbPayload, uploadFiles, manifest }) {
  const databaseDir = path.join(rootDir, "database");
  const uploadsDir = path.join(rootDir, "uploads");
  realSqliteFile(path.join(databaseDir, "corolla-fix-helper.db"), dbPayload);
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

function eperm(syscall, target) {
  return Object.assign(
    new Error(`EPERM: operation not permitted, ${syscall} '${target}'`),
    { code: "EPERM", syscall, path: target }
  );
}

// Emulates how Windows treats a file another program holds open without
// FILE_SHARE_DELETE, as a PDF viewer does: it can still be read and copied,
// but deleting, overwriting or renaming it fails with EPERM, and so does
// renaming any folder above it (checked on this repo's Windows box: the
// folder rename is refused whole, nothing moves). A recursive delete removes
// entries in name order until it reaches the locked file and then fails,
// which is how the 2026-10-18 audit lost 2 of 4 PDFs through a real restore.
// The lock is held for the whole restore, so it hits the rollback too.
function fsWithLockedFile(lockedFile) {
  const isLockedOrAbove = (target) => {
    const relative = path.relative(path.resolve(target), lockedFile);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  const removeUntilLocked = (target) => {
    if (path.resolve(target) === lockedFile) {
      throw eperm("unlink", target);
    }

    for (const name of fs.readdirSync(target).sort()) {
      const child = path.join(target, name);

      if (isLockedOrAbove(child)) {
        removeUntilLocked(child);
      } else {
        fs.rmSync(child, { recursive: true, force: true });
      }
    }

    throw eperm("rmdir", target);
  };

  return {
    ...fs,
    rmSync(target, options) {
      if (fs.existsSync(target) && isLockedOrAbove(target)) {
        removeUntilLocked(target);
      }

      return fs.rmSync(target, options);
    },
    rmdirSync(target, options) {
      if (isLockedOrAbove(target)) {
        throw eperm("rmdir", target);
      }

      return fs.rmdirSync(target, options);
    },
    unlinkSync(target) {
      if (isLockedOrAbove(target)) {
        throw eperm("unlink", target);
      }

      return fs.unlinkSync(target);
    },
    renameSync(from, to) {
      if (isLockedOrAbove(from) || isLockedOrAbove(to)) {
        throw eperm("rename", from);
      }

      return fs.renameSync(from, to);
    },
    copyFileSync(from, to, mode) {
      if (isLockedOrAbove(to)) {
        throw eperm("copyfile", to);
      }

      return fs.copyFileSync(from, to, mode);
    },
  };
}

// Every file under `root` whose bytes equal `contents`.
function filesWithContents(root, contents) {
  const matches = [];
  const expected = Buffer.from(contents);

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (fs.readFileSync(entryPath).equals(expected)) {
        matches.push(entryPath);
      }
    }
  };

  walk(root);
  return matches;
}

// A live install holding a real database and four uploaded PDFs, each with
// distinct bytes so a test can tell whether every original still exists.
const LIVE_PDFS = ["a-live.pdf", "b-live.pdf", "m-open-in-viewer.pdf", "z-live.pdf"];

function setupLiveInstallWithPdfs() {
  const liveRoot = path.join(tempRoot, "live");
  const databaseFile = path.join(liveRoot, "data", "app.db");
  const uploadsDir = path.join(liveRoot, "uploads");
  realSqliteFile(databaseFile, "ORIGINAL-DB");
  fs.mkdirSync(uploadsDir, { recursive: true });

  const originals = new Map();

  for (const name of LIVE_PDFS) {
    const contents = `%PDF-1.4 original ${name}`;
    fs.writeFileSync(path.join(uploadsDir, name), contents);
    originals.set(name, contents);
  }

  const archivePath = path.join(tempRoot, "backup.tar.gz");
  fs.writeFileSync(archivePath, "stand-in archive bytes");

  const sourceDir = path.join(tempRoot, "src");
  writeBackupSource(sourceDir, {
    dbPayload: "RESTORED-DB",
    uploadFiles: { "backup-only.pdf": "BACKUP-PDF" },
  });

  return {
    liveRoot,
    databaseFile,
    uploadsDir,
    archivePath,
    originals,
    originalDatabaseBytes: fs.readFileSync(databaseFile),
    extractArchive: extractorFrom(sourceDir),
  };
}

// The live install is exactly as it was: same database bytes, same PDFs at
// the same paths, and no restore leftovers beside them.
function assertLiveInstallUntouched(install) {
  assert.ok(
    fs.readFileSync(install.databaseFile).equals(install.originalDatabaseBytes),
    "the live database must be byte-identical"
  );
  assert.deepEqual(fs.readdirSync(install.uploadsDir).sort(), [...LIVE_PDFS].sort());

  for (const [name, contents] of install.originals) {
    assert.equal(fs.readFileSync(path.join(install.uploadsDir, name), "utf8"), contents);
  }

  assert.deepEqual(fs.readdirSync(install.liveRoot).sort(), ["data", "uploads"]);
  assert.deepEqual(fs.readdirSync(path.dirname(install.databaseFile)), ["app.db"]);
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

test("validateExtractedBackup rejects a header-valid but corrupt database", () => {
  const sourceDir = path.join(tempRoot, "src");
  const databaseDir = path.join(sourceDir, "database");
  fs.mkdirSync(databaseDir, { recursive: true });
  // Starts with the real SQLite magic header (so the old 16-byte check would
  // accept it) but the rest of the file is garbage, not a real database.
  fs.writeFileSync(
    path.join(databaseDir, "app.db"),
    Buffer.from(`${SQLITE_HEADER}this is not a real database body`, "latin1")
  );
  fs.mkdirSync(path.join(sourceDir, "uploads"), { recursive: true });

  assert.throws(() => validateExtractedBackup(sourceDir), BackupValidationError);
});

test("validateExtractedBackup rejects a database missing required tables", () => {
  const sourceDir = path.join(tempRoot, "src");
  const databaseDir = path.join(sourceDir, "database");
  fs.mkdirSync(databaseDir, { recursive: true });
  // A structurally valid SQLite database, but without the application tables a
  // real Corolla Fix Helper backup must contain.
  const databaseFile = path.join(databaseDir, "app.db");
  const db = new DatabaseSync(databaseFile);
  db.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY);");
  db.close();
  fs.mkdirSync(path.join(sourceDir, "uploads"), { recursive: true });

  assert.throws(() => validateExtractedBackup(sourceDir), BackupValidationError);
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

  const { snapshotDir, previousUploadsDir } = await restoreBackup({
    archivePath,
    databaseFile,
    uploadsDir,
    extractArchive: extractorFrom(sourceDir),
  });

  const snapshotDb = path.join(snapshotDir, "database", path.basename(databaseFile));
  assert.match(fs.readFileSync(snapshotDb, "latin1"), /ORIGINAL-DB/);
  // The previous uploads folder is moved aside whole, next to the live one.
  assert.equal(path.dirname(previousUploadsDir), path.dirname(uploadsDir));
  assert.match(path.basename(previousUploadsDir), /^uploads\.pre-restore-/);
  assert.equal(fs.readFileSync(path.join(previousUploadsDir, "old.pdf"), "utf8"), "OLD-PDF");
});

test("restoreBackup stops before changing anything when an upload is held open by a viewer", async () => {
  const install = setupLiveInstallWithPdfs();
  // The 3rd file in name order, as in the audit's reproduction. The lock lasts
  // the whole restore, so a rollback would hit it too.
  const lockedFile = path.join(install.uploadsDir, LIVE_PDFS[2]);

  await assert.rejects(
    restoreBackup({
      archivePath: install.archivePath,
      databaseFile: install.databaseFile,
      uploadsDir: install.uploadsDir,
      fs: fsWithLockedFile(lockedFile),
      extractArchive: install.extractArchive,
    }),
    (error) => {
      assert.equal(error.outcome, "failed_before_change");
      assert.equal(error.cause?.code, "EPERM");
      return true;
    }
  );

  assertLiveInstallUntouched(install);
});

test("restoreBackup moves the uploads back when the database turns out to be locked", async () => {
  const install = setupLiveInstallWithPdfs();

  // A running server holds the live database open, so it cannot be moved or
  // replaced — but only after the uploads have already been swapped.
  await assert.rejects(
    restoreBackup({
      archivePath: install.archivePath,
      databaseFile: install.databaseFile,
      uploadsDir: install.uploadsDir,
      fs: fsWithLockedFile(install.databaseFile),
      extractArchive: install.extractArchive,
    }),
    (error) => {
      assert.equal(error.outcome, "rolled_back");
      assert.equal(error.cause?.code, "EPERM");
      return true;
    }
  );

  assertLiveInstallUntouched(install);
});

test("restoreBackup deletes nothing and says where the data is when the rollback is blocked too", async () => {
  const install = setupLiveInstallWithPdfs();

  // Something holds the live uploads path (for example the app was started
  // mid-restore and recreated the folder), so neither the restored uploads
  // nor, on rollback, the previous ones can be moved into it.
  const blockedFs = {
    ...fs,
    renameSync(from, to) {
      if (path.resolve(to) === path.resolve(install.uploadsDir)) {
        throw eperm("rename", from);
      }

      return fs.renameSync(from, to);
    },
  };

  let failure;
  await assert.rejects(
    restoreBackup({
      archivePath: install.archivePath,
      databaseFile: install.databaseFile,
      uploadsDir: install.uploadsDir,
      fs: blockedFs,
      extractArchive: install.extractArchive,
    }),
    (error) => {
      failure = error;
      return true;
    }
  );

  assert.equal(failure.outcome, "rollback_failed");
  assert.equal(failure.cause?.code, "EPERM");
  assert.ok(failure.rollbackErrors.length > 0);

  // Every original PDF still exists, in the folder the error names...
  for (const [name, contents] of install.originals) {
    assert.equal(
      fs.readFileSync(path.join(failure.previousUploadsDir, name), "utf8"),
      contents
    );
    assert.equal(filesWithContents(tempRoot, contents).length, 1);
  }

  // ...the error says how to put that folder back...
  assert.deepEqual(
    failure.unrestoredMoves.map(({ from, to, holds }) => ({ from, to, holds })),
    [{ from: install.uploadsDir, to: failure.previousUploadsDir, holds: "previous" }]
  );

  // ...and the database, which comes after the uploads, was never touched.
  assert.ok(fs.readFileSync(install.databaseFile).equals(install.originalDatabaseBytes));
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
    (error) => {
      assert.equal(error.outcome, "failed_before_change");
      assert.ok(error.cause instanceof BackupValidationError);
      return true;
    }
  );

  // Live data is untouched.
  assert.match(fs.readFileSync(databaseFile, "latin1"), /ORIGINAL-DB/);
  assert.equal(fs.readFileSync(path.join(uploadsDir, "old.pdf"), "utf8"), "OLD-PDF");
});

test("restoreBackup changes nothing when copying the backup's uploads fails", async () => {
  const { databaseFile, uploadsDir, archivePath } = setupLiveInstall();

  const sourceDir = path.join(tempRoot, "src");
  writeBackupSource(sourceDir, {
    dbPayload: "RESTORED-DB",
    uploadFiles: { "new.pdf": "NEW-PDF" },
  });

  // Copying the *extracted* uploads fails (a full disk, say). That copy is
  // staged beside the live folder before anything live is moved.
  const brokenFs = {
    ...fs,
    cpSync(source, destination, options) {
      if (source.includes("corolla-fix-helper-restore-")) {
        throw new Error("simulated copy failure");
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
    (error) => {
      assert.equal(error.outcome, "failed_before_change");
      assert.match(error.message, /simulated copy failure/);
      return true;
    }
  );

  assert.match(fs.readFileSync(databaseFile, "latin1"), /ORIGINAL-DB/);
  assert.equal(fs.readFileSync(path.join(uploadsDir, "old.pdf"), "utf8"), "OLD-PDF");
  assert.ok(!fs.existsSync(path.join(uploadsDir, "new.pdf")));
  assert.deepEqual(fs.readdirSync(path.join(tempRoot, "live")).sort(), ["data", "uploads"]);
});

// Fails only the swap's last step: renaming the staged restored database
// (`<db>.restore-<ts>`) into place. Moving the previous database back into
// that same path during rollback still works.
function fsFailingRestoredDatabaseMove(databaseFile) {
  return {
    ...fs,
    renameSync(from, to) {
      if (
        path.resolve(to) === path.resolve(databaseFile) &&
        path.basename(from).startsWith(`${path.basename(databaseFile)}.restore-`)
      ) {
        throw new Error("simulated swap failure");
      }

      return fs.renameSync(from, to);
    },
  };
}

test("restoreBackup moves everything back when the swap fails partway", async () => {
  const install = setupLiveInstallWithPdfs();

  await assert.rejects(
    restoreBackup({
      archivePath: install.archivePath,
      databaseFile: install.databaseFile,
      uploadsDir: install.uploadsDir,
      fs: fsFailingRestoredDatabaseMove(install.databaseFile),
      extractArchive: install.extractArchive,
      keepSnapshot: false,
    }),
    (error) => {
      assert.equal(error.outcome, "rolled_back");
      assert.match(error.message, /simulated swap failure/);
      return true;
    }
  );

  assertLiveInstallUntouched(install);
});

test("restoreBackup moves a WAL sidecar with its database, and back on rollback", async () => {
  const install = setupLiveInstallWithPdfs();
  // Committed rows can live only in the -wal file after an unclean stop, so
  // the sidecar must travel with the .db file and never be deleted.
  fs.writeFileSync(`${install.databaseFile}-wal`, "WAL-FRAMES");

  await assert.rejects(
    restoreBackup({
      archivePath: install.archivePath,
      databaseFile: install.databaseFile,
      uploadsDir: install.uploadsDir,
      fs: fsFailingRestoredDatabaseMove(install.databaseFile),
      extractArchive: install.extractArchive,
    }),
    { outcome: "rolled_back" }
  );

  assert.equal(fs.readFileSync(`${install.databaseFile}-wal`, "utf8"), "WAL-FRAMES");

  // And on success the sidecar ends up beside the previous database.
  const { snapshotDir } = await restoreBackup({
    archivePath: install.archivePath,
    databaseFile: install.databaseFile,
    uploadsDir: install.uploadsDir,
    extractArchive: install.extractArchive,
  });

  const previousDatabase = path.join(snapshotDir, "database", "app.db");
  assert.equal(fs.readFileSync(`${previousDatabase}-wal`, "utf8"), "WAL-FRAMES");
  assert.ok(!fs.existsSync(`${install.databaseFile}-wal`));
  assert.match(fs.readFileSync(install.databaseFile, "latin1"), /RESTORED-DB/);
});

test("restoreBackup refuses a database file inside the uploads folder", async () => {
  const uploadsDir = path.join(tempRoot, "live", "uploads");
  const databaseFile = path.join(uploadsDir, "app.db");
  fakeSqliteFile(databaseFile, "ORIGINAL-DB");
  const archivePath = path.join(tempRoot, "backup.tar.gz");
  fs.writeFileSync(archivePath, "stand-in archive bytes");

  const sourceDir = path.join(tempRoot, "src");
  writeBackupSource(sourceDir, { dbPayload: "RESTORED-DB", uploadFiles: {} });

  await assert.rejects(
    restoreBackup({
      archivePath,
      databaseFile,
      uploadsDir,
      extractArchive: extractorFrom(sourceDir),
    }),
    { outcome: "failed_before_change" }
  );

  assert.match(fs.readFileSync(databaseFile, "latin1"), /ORIGINAL-DB/);
  assert.deepEqual(fs.readdirSync(uploadsDir), ["app.db"]);
});
