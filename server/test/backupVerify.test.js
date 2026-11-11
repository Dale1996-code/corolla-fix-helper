import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  BackupValidationError,
  createBackupArchive,
  verifyBackupArchive,
} from "../src/services/backupService.js";
import { resolveTarExecutable } from "../src/services/tarExecutable.js";

// "Verified" in Settings means an archive was unpacked into a scratch folder and
// the database inside passed the same checks a real restore runs before it
// touches anything. These tests pin that a bad archive is never called verified
// and that the check leaves nothing behind and touches no live data.

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
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-backup-verify-"));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function seedInstall({ withRequiredTables = true } = {}) {
  const databaseFile = path.join(tempRoot, "install", "data", "app.db");
  const uploadsDir = path.join(tempRoot, "install", "uploads");
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.writeFileSync(path.join(uploadsDir, "brake-guide.pdf"), "%PDF-1.4 brake guide");

  const db = new DatabaseSync(databaseFile);
  db.exec(
    withRequiredTables
      ? `CREATE TABLE documents (id INTEGER PRIMARY KEY);
         CREATE TABLE symptoms (id INTEGER PRIMARY KEY);
         CREATE TABLE procedures (id INTEGER PRIMARY KEY);`
      : "CREATE TABLE unrelated (id INTEGER PRIMARY KEY);"
  );
  db.close();

  return { databaseFile, uploadsDir };
}

test(
  "an archive made by the real backup passes verification and reports its manifest",
  { skip: tarUnavailable },
  async () => {
    const install = seedInstall();
    const archivePath = path.join(tempRoot, "good.tar.gz");
    await createBackupArchive({ ...install, outFile: archivePath });

    const result = await verifyBackupArchive({ archivePath });

    assert.equal(result.manifest.app, "corolla-fix-helper");
    assert.equal(result.manifest.databaseFilename, "app.db");
  }
);

test(
  "a file that is not a real archive fails verification",
  { skip: tarUnavailable },
  async () => {
    const archivePath = path.join(tempRoot, "garbage.tar.gz");
    fs.writeFileSync(archivePath, "this was never a tar file");

    await assert.rejects(verifyBackupArchive({ archivePath }), Error);
  }
);

test(
  "an archive whose database is not this app's database fails verification",
  { skip: tarUnavailable },
  async () => {
    const install = seedInstall({ withRequiredTables: false });
    const archivePath = path.join(tempRoot, "wrong-database.tar.gz");
    await createBackupArchive({ ...install, outFile: archivePath });

    await assert.rejects(
      verifyBackupArchive({ archivePath }),
      (error) =>
        error instanceof BackupValidationError &&
        /missing required tables/.test(error.message)
    );
  }
);

test("a missing archive fails verification instead of passing on nothing", async () => {
  await assert.rejects(
    verifyBackupArchive({ archivePath: path.join(tempRoot, "does-not-exist.tar.gz") }),
    /not found/i
  );
});

test("the scratch folder is removed whether verification passes or fails", async () => {
  const install = seedInstall();
  const good = path.join(tempRoot, "good.tar.gz");
  await createBackupArchive({
    ...install,
    outFile: good,
    createArchive: async (stagingRoot, outFile) => {
      // A stand-in archive: the extractor below copies this folder back out.
      fs.cpSync(stagingRoot, `${outFile}.contents`, { recursive: true });
      fs.writeFileSync(outFile, "stand-in");
    },
  });

  const scratchFolders = [];
  const extractFrom = (contentsDir) => async (_archivePath, scratch) => {
    scratchFolders.push(scratch);
    fs.cpSync(contentsDir, scratch, { recursive: true });
  };

  await verifyBackupArchive({
    archivePath: good,
    extractArchive: extractFrom(`${good}.contents`),
  });

  fs.rmSync(path.join(`${good}.contents`, "database"), { recursive: true });
  await assert.rejects(
    verifyBackupArchive({ archivePath: good, extractArchive: extractFrom(`${good}.contents`) }),
    BackupValidationError
  );

  assert.equal(scratchFolders.length, 2);
  for (const scratch of scratchFolders) {
    assert.equal(fs.existsSync(scratch), false, `${scratch} should be gone`);
  }
});
