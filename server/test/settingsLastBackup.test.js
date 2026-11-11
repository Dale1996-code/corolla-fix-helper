// GET /api/settings -> `backupExport.lastBackup`: what Settings shows under
// "Last backup". It must come from the status file beside the database (so a
// restore cannot rewind it) and be re-derived on every request (so a deleted
// archive stops being called safe the moment it is gone).

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";
import request from "supertest";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-settings-last-backup-"));

process.env.DATABASE_FILE = path.join(tempRoot, "data", "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OCR_ENABLED = "false";

const { config } = await import("../src/config.js");
const { db } = await import("../src/database.js");
const { createApp } = await import("../src/app.js");
const { backupStatusFileFor, recordSuccessfulBackup } = await import(
  "../src/services/backupStatusService.js"
);

const app = createApp();
const statusFile = backupStatusFileFor(config.databaseFile);

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(statusFile, { force: true });
});

async function getLastBackup() {
  const response = await request(app).get("/api/settings").expect(200);

  return response.body.backupExport.lastBackup;
}

test("Settings reports no backup when none has been recorded", async () => {
  assert.deepEqual(await getLastBackup(), {
    recorded: false,
    stale: true,
    staleAfterDays: 7,
  });
});

test("Settings reports the recorded backup and re-checks its file on every request", async () => {
  const archivePath = path.join(tempRoot, "backups", "corolla-fix-helper-backup-x.tar.gz");
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, "archive");
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  recordSuccessfulBackup({
    statusFile,
    backup: {
      createdAt: yesterday,
      source: "cli",
      archivePath,
      archiveBytes: 7,
      verification: { state: "passed", checkedAt: yesterday },
    },
  });

  const present = await getLastBackup();
  assert.equal(present.recorded, true);
  assert.equal(present.destination, archivePath);
  assert.equal(present.assurance, "verified");
  assert.equal(present.stale, false);

  fs.rmSync(archivePath);

  const gone = await getLastBackup();
  assert.equal(gone.file, "missing");
  assert.equal(gone.assurance, "unknown");
});

test("the existing backup and restore details are still served, with the backup command beside them", async () => {
  const response = await request(app).get("/api/settings").expect(200);
  const { backupExport } = response.body;

  assert.equal(backupExport.supported, true);
  assert.equal(
    backupExport.restore.command,
    'npm run restore -- "/path/to/corolla-fix-helper-backup-....tar.gz"'
  );
  assert.match(backupExport.cli.command, /^npm run backup -- "/);
});
