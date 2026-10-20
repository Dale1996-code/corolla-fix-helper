import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  createBackupArchive,
  restoreBackup,
} from "../src/services/backupService.js";
import { resolveTarExecutable } from "../src/services/tarExecutable.js";

// Every other restore test injects a directory-copy extractor, so the real
// `tar` invocation (runTar, defaultExtractArchive, defaultCreateArchive) would
// otherwise never run in CI. This suite drives the production tar on whatever
// platform the tests run on: GNU tar on the ubuntu CI runner, the native
// %SystemRoot%\System32\tar.exe on Windows.

function findTar() {
  try {
    const tar = resolveTarExecutable();
    const probe = spawnSync(tar, ["--version"], { stdio: "ignore" });
    return probe.status === 0 ? tar : null;
  } catch {
    return null;
  }
}

const tarUnavailable = findTar() ? false : "no usable tar executable on this machine";

let tempRoot;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-backup-real-tar-"));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function seedInstall({ databaseFile, uploadsDir, notes, files }) {
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true });

  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(uploadsDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }

  const db = new DatabaseSync(databaseFile);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE documents (id INTEGER PRIMARY KEY, title TEXT);
    CREATE TABLE symptoms (id INTEGER PRIMARY KEY);
    CREATE TABLE procedures (id INTEGER PRIMARY KEY);
    CREATE TABLE notes (id INTEGER PRIMARY KEY, content TEXT);
  `);

  for (const note of notes) {
    db.prepare("INSERT INTO notes (content) VALUES (?)").run(note);
  }

  db.close();
}

function readNotes(databaseFile) {
  const db = new DatabaseSync(databaseFile, { readOnly: true });

  try {
    return db
      .prepare("SELECT content FROM notes ORDER BY id")
      .all()
      .map((row) => row.content);
  } finally {
    db.close();
  }
}

test(
  "a backup made by the real tar restores through the real tar",
  { skip: tarUnavailable },
  async () => {
    const backedUp = {
      databaseFile: path.join(tempRoot, "backed-up", "data", "app.db"),
      uploadsDir: path.join(tempRoot, "backed-up", "uploads"),
    };
    const pdfBytes = Buffer.from("%PDF-1.4\n% brake guide\n%%EOF\n");
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    seedInstall({
      ...backedUp,
      notes: ["torque caliper bolts", "bleed the rear brakes"],
      files: {
        "brake-guide.pdf": pdfBytes,
        [path.join("attachments", "images", "caliper.png")]: imageBytes,
      },
    });

    const archivePath = path.join(tempRoot, "backup.tar.gz");
    await createBackupArchive({ ...backedUp, outFile: archivePath });
    assert.ok(fs.statSync(archivePath).size > 0, "the real tar should write an archive");

    // A different live install that the restore must replace.
    const live = {
      databaseFile: path.join(tempRoot, "live", "data", "app.db"),
      uploadsDir: path.join(tempRoot, "live", "uploads"),
    };
    seedInstall({
      ...live,
      notes: ["a note that only exists before the restore"],
      files: { "live-only.pdf": Buffer.from("%PDF-1.4 live only") },
    });

    await restoreBackup({ archivePath, ...live });

    assert.deepEqual(readNotes(live.databaseFile), [
      "torque caliper bolts",
      "bleed the rear brakes",
    ]);
    assert.ok(fs.readFileSync(path.join(live.uploadsDir, "brake-guide.pdf")).equals(pdfBytes));
    assert.ok(
      fs
        .readFileSync(path.join(live.uploadsDir, "attachments", "images", "caliper.png"))
        .equals(imageBytes)
    );
    assert.ok(!fs.existsSync(path.join(live.uploadsDir, "live-only.pdf")));
  }
);
