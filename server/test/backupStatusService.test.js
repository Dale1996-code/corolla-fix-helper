import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";

import {
  BACKUP_STALE_AFTER_DAYS,
  backupStatusFileFor,
  describeLastBackup,
  recordSuccessfulBackup,
} from "../src/services/backupStatusService.js";

// The status file is the only thing Settings reads to say how safe the owner's
// last backup is, so these tests pin what each state may and may not claim.
// They use real files in a throwaway folder: the file checks are the point.

let tempRoot;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-backup-status-"));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const NOW = new Date("2026-11-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function isoAgo(milliseconds) {
  return new Date(NOW.getTime() - milliseconds).toISOString();
}

function statusFile() {
  return path.join(tempRoot, "data", "backup-status.json");
}

function writeArchive(name, contents = "archive bytes") {
  const archivePath = path.join(tempRoot, "backups", name);
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, contents);
  return archivePath;
}

function cliBackup(archivePath, overrides = {}) {
  return {
    createdAt: isoAgo(2 * DAY_MS),
    source: "cli",
    archivePath,
    archiveBytes: fs.statSync(archivePath).size,
    verification: { state: "passed", checkedAt: isoAgo(2 * DAY_MS) },
    ...overrides,
  };
}

test("the status file sits beside the database, outside the database and the uploads folder", () => {
  const databaseFile = path.join(tempRoot, "server", "data", "corolla-fix-helper.db");

  assert.equal(
    backupStatusFileFor(databaseFile),
    path.join(tempRoot, "server", "data", "backup-status.json")
  );
});

test("with no status file nothing is recorded and the owner is told to take a backup", () => {
  const result = describeLastBackup({ statusFile: statusFile(), now: () => NOW });

  assert.deepEqual(result, {
    recorded: false,
    stale: true,
    staleAfterDays: BACKUP_STALE_AFTER_DAYS,
  });
});

test("a corrupt status file reads as no record instead of breaking Settings", () => {
  fs.mkdirSync(path.dirname(statusFile()), { recursive: true });
  fs.writeFileSync(statusFile(), "{ this is not json");

  const result = describeLastBackup({ statusFile: statusFile(), now: () => NOW });

  assert.equal(result.recorded, false);
  assert.equal(result.stale, true);
});

test("a record with an unreadable date is ignored rather than treated as a recent backup", () => {
  const archivePath = writeArchive("a.tar.gz");
  fs.mkdirSync(path.dirname(statusFile()), { recursive: true });
  fs.writeFileSync(
    statusFile(),
    JSON.stringify({
      version: 1,
      lastBackup: cliBackup(archivePath, { createdAt: "not a date" }),
    })
  );

  const result = describeLastBackup({ statusFile: statusFile(), now: () => NOW });

  assert.equal(result.recorded, false);
  assert.equal(result.stale, true);
});

test("a verified command-line backup whose file is still there is reported as verified", () => {
  const archivePath = writeArchive("corolla-fix-helper-backup-a.tar.gz", "twelve bytes");
  recordSuccessfulBackup({ statusFile: statusFile(), backup: cliBackup(archivePath) });

  const result = describeLastBackup({ statusFile: statusFile(), now: () => NOW });

  assert.deepEqual(result, {
    recorded: true,
    createdAt: isoAgo(2 * DAY_MS),
    source: "cli",
    destination: archivePath,
    archiveBytes: 12,
    file: "found",
    verification: "passed",
    verifiedAt: isoAgo(2 * DAY_MS),
    assurance: "verified",
    ageDays: 2,
    stale: false,
    staleAfterDays: 7,
  });
});

test("a backup that was created but never test-restored is not called verified", () => {
  const archivePath = writeArchive("b.tar.gz");
  recordSuccessfulBackup({
    statusFile: statusFile(),
    backup: cliBackup(archivePath, { verification: { state: "not_run", checkedAt: null } }),
  });

  const result = describeLastBackup({ statusFile: statusFile(), now: () => NOW });

  assert.equal(result.file, "found");
  assert.equal(result.verification, "not_run");
  assert.equal(result.verifiedAt, null);
  assert.equal(result.assurance, "created");
});

test("a backup whose file has gone missing is unknown even though it once passed verification", () => {
  const archivePath = writeArchive("c.tar.gz");
  recordSuccessfulBackup({ statusFile: statusFile(), backup: cliBackup(archivePath) });
  fs.rmSync(archivePath);

  const result = describeLastBackup({ statusFile: statusFile(), now: () => NOW });

  assert.equal(result.file, "missing");
  assert.equal(result.verification, "passed");
  assert.equal(result.assurance, "unknown");
});

test("a backup file whose size changed since it was recorded is unknown", () => {
  const archivePath = writeArchive("d.tar.gz", "original contents");
  recordSuccessfulBackup({ statusFile: statusFile(), backup: cliBackup(archivePath) });
  fs.writeFileSync(archivePath, "something else entirely, and longer");

  const result = describeLastBackup({ statusFile: statusFile(), now: () => NOW });

  assert.equal(result.file, "changed");
  assert.equal(result.assurance, "unknown");
});

test("a Settings download has no known location, so the app cannot vouch for it", () => {
  recordSuccessfulBackup({
    statusFile: statusFile(),
    backup: {
      createdAt: isoAgo(DAY_MS),
      source: "settings",
      archivePath: null,
      archiveBytes: null,
      verification: { state: "not_run", checkedAt: null },
    },
  });

  const result = describeLastBackup({ statusFile: statusFile(), now: () => NOW });

  assert.equal(result.recorded, true);
  assert.equal(result.source, "settings");
  assert.equal(result.destination, null);
  assert.equal(result.file, "not_checkable");
  assert.equal(result.assurance, "unknown");
  assert.equal(result.stale, false);
});

test("a backup becomes stale only once it is more than seven days old", () => {
  const archivePath = writeArchive("e.tar.gz");

  const cases = [
    { ageMs: 6 * DAY_MS + 23 * 60 * 60 * 1000, stale: false, ageDays: 6 },
    { ageMs: 7 * DAY_MS, stale: false, ageDays: 7 },
    { ageMs: 7 * DAY_MS + 60 * 1000, stale: true, ageDays: 7 },
    { ageMs: 30 * DAY_MS, stale: true, ageDays: 30 },
  ];

  for (const { ageMs, stale, ageDays } of cases) {
    recordSuccessfulBackup({
      statusFile: statusFile(),
      backup: cliBackup(archivePath, { createdAt: isoAgo(ageMs) }),
    });

    const result = describeLastBackup({ statusFile: statusFile(), now: () => NOW });

    assert.equal(result.stale, stale, `age ${ageMs} ms`);
    assert.equal(result.ageDays, ageDays, `age ${ageMs} ms`);
  }
});

test("a backup dated in the future by a clock change is not reported as negative days old", () => {
  const archivePath = writeArchive("f.tar.gz");
  recordSuccessfulBackup({
    statusFile: statusFile(),
    backup: cliBackup(archivePath, { createdAt: new Date(NOW.getTime() + DAY_MS).toISOString() }),
  });

  const result = describeLastBackup({ statusFile: statusFile(), now: () => NOW });

  assert.equal(result.ageDays, 0);
  assert.equal(result.stale, false);
});

test("recording a new backup replaces the previous record and leaves no temporary file", () => {
  const first = writeArchive("first.tar.gz", "1");
  const second = writeArchive("second.tar.gz", "22");
  recordSuccessfulBackup({ statusFile: statusFile(), backup: cliBackup(first) });
  recordSuccessfulBackup({ statusFile: statusFile(), backup: cliBackup(second) });

  const result = describeLastBackup({ statusFile: statusFile(), now: () => NOW });

  assert.equal(result.destination, second);
  assert.equal(result.archiveBytes, 2);
  assert.deepEqual(fs.readdirSync(path.dirname(statusFile())), ["backup-status.json"]);
});
