import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { afterEach, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createBackupArchive, restoreBackup } from "../src/services/backupService.js";
import {
  backupStatusFileFor,
  describeLastBackup,
  recordSuccessfulBackup,
} from "../src/services/backupStatusService.js";
import { resolveTarExecutable } from "../src/services/tarExecutable.js";
import {
  describeBackupSuccess,
  parseBackupArgs,
  runBackup,
} from "../src/scripts/createBackup.js";

// `npm run backup` is the owner's only scheduled-safe way to make a backup, so
// these tests pin the safety rules: it never overwrites or deletes an existing
// file, it never leaves a half-written .tar.gz that looks complete, a failed run
// never moves "last backup" forward, and the record survives a restore.

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
const scriptPath = fileURLToPath(new URL("../src/scripts/createBackup.js", import.meta.url));

const NOW = new Date("2026-11-10T12:00:00.000Z");
const EXPECTED_NAME = "corolla-fix-helper-backup-2026-11-10T12-00-00-000Z.tar.gz";

let tempRoot;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-backup-cli-"));
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function seedInstall({ withRequiredTables = true, note = "torque caliper bolts" } = {}) {
  const databaseFile = path.join(tempRoot, "live", "data", "app.db");
  const uploadsDir = path.join(tempRoot, "live", "uploads");
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.writeFileSync(path.join(uploadsDir, "brake-guide.pdf"), "%PDF-1.4 brake guide");

  const db = new DatabaseSync(databaseFile);
  db.exec(
    withRequiredTables
      ? `CREATE TABLE documents (id INTEGER PRIMARY KEY);
         CREATE TABLE symptoms (id INTEGER PRIMARY KEY);
         CREATE TABLE procedures (id INTEGER PRIMARY KEY);
         CREATE TABLE notes (id INTEGER PRIMARY KEY, content TEXT);`
      : "CREATE TABLE unrelated (id INTEGER PRIMARY KEY);"
  );

  if (withRequiredTables) {
    db.prepare("INSERT INTO notes (content) VALUES (?)").run(note);
  }

  db.close();

  return {
    databaseFile,
    uploadsDir,
    statusFile: backupStatusFileFor(databaseFile),
  };
}

function destinationDir() {
  return path.join(tempRoot, "Backups");
}

test("the backup command writes a verified archive to the chosen folder and records it", { skip: tarUnavailable }, async () => {
  const install = seedInstall();

  const result = await runBackup({
    destinationDir: destinationDir(),
    ...install,
    now: () => NOW,
    logger: { log() {}, warn() {} },
  });

  // The destination folder did not exist; it is created, and holds exactly the
  // finished archive: no .partial left behind.
  assert.deepEqual(fs.readdirSync(destinationDir()), [EXPECTED_NAME]);
  assert.equal(result.archivePath, path.join(destinationDir(), EXPECTED_NAME));
  assert.equal(result.verification, "passed");
  assert.ok(result.archiveBytes > 0);

  const status = describeLastBackup({ statusFile: install.statusFile, now: () => NOW });
  assert.equal(status.recorded, true);
  assert.equal(status.source, "cli");
  assert.equal(status.destination, result.archivePath);
  assert.equal(status.createdAt, "2026-11-10T12:00:00.000Z");
  assert.equal(status.verification, "passed");
  assert.equal(status.assurance, "verified");
});

test("the backup command never overwrites a file that already has the archive's name", { skip: tarUnavailable }, async () => {
  const install = seedInstall();
  fs.mkdirSync(destinationDir(), { recursive: true });
  const existing = path.join(destinationDir(), EXPECTED_NAME);
  fs.writeFileSync(existing, "my only copy");

  await assert.rejects(
    runBackup({
      destinationDir: destinationDir(),
      ...install,
      now: () => NOW,
      logger: { log() {}, warn() {} },
    }),
    /already exists/
  );

  assert.equal(fs.readFileSync(existing, "utf8"), "my only copy");
  assert.deepEqual(fs.readdirSync(destinationDir()), [EXPECTED_NAME]);
  assert.equal(describeLastBackup({ statusFile: install.statusFile }).recorded, false);
});

test("the backup command refuses a destination inside the uploads folder", { skip: tarUnavailable }, async () => {
  const install = seedInstall();
  const before = fs.readdirSync(install.uploadsDir);

  await assert.rejects(
    runBackup({
      destinationDir: path.join(install.uploadsDir, "backups"),
      ...install,
      now: () => NOW,
      logger: { log() {}, warn() {} },
    }),
    /uploads/i
  );

  // It must not even create the folder: the next backup would have archived it.
  assert.deepEqual(fs.readdirSync(install.uploadsDir), before);
});

test("a backup that fails verification leaves no archive and keeps the previous record", { skip: tarUnavailable }, async () => {
  const install = seedInstall({ withRequiredTables: false });
  const priorArchive = path.join(tempRoot, "prior.tar.gz");
  fs.writeFileSync(priorArchive, "prior");
  recordSuccessfulBackup({
    statusFile: install.statusFile,
    backup: {
      createdAt: "2026-11-01T09:00:00.000Z",
      source: "cli",
      archivePath: priorArchive,
      archiveBytes: 5,
      verification: { state: "passed", checkedAt: "2026-11-01T09:00:00.000Z" },
    },
  });

  await assert.rejects(
    runBackup({
      destinationDir: destinationDir(),
      ...install,
      now: () => NOW,
      logger: { log() {}, warn() {} },
    }),
    /missing required tables/
  );

  assert.deepEqual(fs.readdirSync(destinationDir()), [], "no .tar.gz and no .partial");
  const status = describeLastBackup({ statusFile: install.statusFile, now: () => NOW });
  assert.equal(status.createdAt, "2026-11-01T09:00:00.000Z");
});

test("--no-verify makes the archive but records it as not test-restored", { skip: tarUnavailable }, async () => {
  const install = seedInstall();

  const result = await runBackup({
    destinationDir: destinationDir(),
    verify: false,
    ...install,
    now: () => NOW,
    logger: { log() {}, warn() {} },
  });

  assert.equal(result.verification, "not_run");
  const status = describeLastBackup({ statusFile: install.statusFile, now: () => NOW });
  assert.equal(status.verification, "not_run");
  assert.equal(status.assurance, "created");
});

test("a status file that cannot be written does not fail a backup that succeeded", { skip: tarUnavailable }, async () => {
  const install = seedInstall();
  const aFile = path.join(tempRoot, "not-a-folder");
  fs.writeFileSync(aFile, "x");
  const warnings = [];

  const result = await runBackup({
    destinationDir: destinationDir(),
    ...install,
    statusFile: path.join(aFile, "backup-status.json"),
    now: () => NOW,
    logger: { log() {}, warn: (line) => warnings.push(line) },
  });

  assert.equal(result.statusRecorded, false);
  assert.ok(fs.existsSync(result.archivePath), "the archive is kept");
  assert.match(warnings.join("\n"), /could not be saved/i);
});

test("the last-backup record survives restoring an older backup over the live data", { skip: tarUnavailable }, async () => {
  const install = seedInstall({ note: "the note as it stood last month" });
  const olderArchive = path.join(tempRoot, "older.tar.gz");
  await createBackupArchive({ ...install, outFile: olderArchive });

  // The owner keeps working, then takes the backup that Settings should report.
  const db = new DatabaseSync(install.databaseFile);
  db.prepare("INSERT INTO notes (content) VALUES (?)").run("a note added this week");
  db.close();
  const result = await runBackup({
    destinationDir: destinationDir(),
    ...install,
    now: () => NOW,
    logger: { log() {}, warn() {} },
  });

  await restoreBackup({
    archivePath: olderArchive,
    databaseFile: install.databaseFile,
    uploadsDir: install.uploadsDir,
  });

  // The restored database predates the backup, yet Settings still reports it.
  const restored = new DatabaseSync(install.databaseFile, { readOnly: true });
  const notes = restored.prepare("SELECT content FROM notes").all().map((row) => row.content);
  restored.close();
  assert.deepEqual(notes, ["the note as it stood last month"]);

  const status = describeLastBackup({ statusFile: install.statusFile, now: () => NOW });
  assert.equal(status.destination, result.archivePath);
  assert.equal(status.assurance, "verified");
});

test("parseBackupArgs takes one folder and an optional --no-verify, in either order", () => {
  const cases = [
    { argv: ["D:\\Backups"], want: { destination: "D:\\Backups", verify: true } },
    { argv: ["D:\\Backups", "--no-verify"], want: { destination: "D:\\Backups", verify: false } },
    { argv: ["--no-verify", "/mnt/backups"], want: { destination: "/mnt/backups", verify: false } },
  ];

  for (const { argv, want } of cases) {
    assert.deepEqual(parseBackupArgs(argv), want, argv.join(" "));
  }
});

test("parseBackupArgs rejects a missing folder, extra folders, and unknown options", () => {
  for (const argv of [[], ["--no-verify"], ["a", "b"], ["a", "--bogus"], ["--force", "a"]]) {
    const parsed = parseBackupArgs(argv);

    assert.match(parsed.error, /Usage: npm run backup/, argv.join(" "));
  }
});

test("the success report names the archive and does not claim an unverified backup was tested", () => {
  const archivePath = path.join(destinationDir(), EXPECTED_NAME);

  const verified = describeBackupSuccess({
    archivePath,
    archiveBytes: 2048,
    verification: "passed",
    statusRecorded: true,
  }).join("\n");
  const unverified = describeBackupSuccess({
    archivePath,
    archiveBytes: 2048,
    verification: "not_run",
    statusRecorded: true,
  }).join("\n");

  assert.ok(verified.includes(archivePath));
  assert.match(verified, /passed a test restore/i);
  assert.ok(unverified.includes(archivePath));
  assert.match(unverified, /not verified/i);
  assert.doesNotMatch(unverified, /passed/i);
});

test("running the script prints the archive path and exits 0; with no folder it prints usage and exits 1", { skip: tarUnavailable }, () => {
  const install = seedInstall();
  const env = {
    ...process.env,
    DATABASE_FILE: install.databaseFile,
    UPLOADS_DIR: install.uploadsDir,
  };

  const ok = spawnSync(process.execPath, [scriptPath, destinationDir()], { env, encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  const [archiveName] = fs.readdirSync(destinationDir());
  assert.match(archiveName, /^corolla-fix-helper-backup-.*\.tar\.gz$/);
  assert.ok(ok.stdout.includes(path.join(destinationDir(), archiveName)), ok.stdout);
  assert.equal(describeLastBackup({ statusFile: install.statusFile }).assurance, "verified");

  const usage = spawnSync(process.execPath, [scriptPath], { env, encoding: "utf8" });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /Usage: npm run backup/);
});
