import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { RestoreError } from "../src/services/backupService.js";
import {
  describeRestoreFailure,
  describeRestoreSuccess,
} from "../src/scripts/restoreBackup.js";

// The restore CLI is the only thing the owner reads after a failed restore, so
// what it claims must match what actually happened on disk.

const live = {
  databaseFile: path.join("C:", "app", "server", "data", "app.db"),
  uploadsDir: path.join("C:", "app", "server", "uploads"),
};
const snapshotDir = path.join("C:", "app", "server", "data", "pre-restore-2026-10-18T10-00-00-000Z");
const previousUploadsDir = `${live.uploadsDir}.pre-restore-2026-10-18T10-00-00-000Z`;

function failure(outcome, extra = {}) {
  return new RestoreError("EPERM: operation not permitted, rename", {
    outcome,
    cause: Object.assign(new Error("EPERM"), { code: "EPERM" }),
    ...live,
    ...extra,
  });
}

test("no failure message claims the data was left in place", () => {
  for (const outcome of ["failed_before_change", "rolled_back", "rollback_failed"]) {
    const text = describeRestoreFailure(failure(outcome), live).join("\n");
    assert.doesNotMatch(text, /left in place/i, outcome);
    assert.match(text, /EPERM: operation not permitted/, outcome);
  }
});

test("a failure before any change says nothing changed and names no snapshot", () => {
  const text = describeRestoreFailure(failure("failed_before_change"), live).join("\n");

  assert.match(text, /Nothing was changed/);
  assert.doesNotMatch(text, /pre-restore/);
  // A locked file is the usual Windows cause; say what to close.
  assert.match(text, /open/i);
});

test("a rolled-back failure says the previous data was moved back", () => {
  const text = describeRestoreFailure(failure("rolled_back"), live).join("\n");

  assert.match(text, /rolled back/i);
  assert.match(text, /moved back into place/i);
  assert.ok(text.includes(live.databaseFile));
  assert.ok(text.includes(live.uploadsDir));
  assert.doesNotMatch(text, /Nothing was changed/);
});

test("a failed rollback names every pre-restore location and the moves that recover it", () => {
  const restoredUploads = { from: `${live.uploadsDir}.restore-x`, to: live.uploadsDir, holds: "restored" };
  const previousUploads = { from: live.uploadsDir, to: previousUploadsDir, holds: "previous" };
  const previousDatabase = {
    from: live.databaseFile,
    to: path.join(snapshotDir, "database", "app.db"),
    holds: "previous",
  };

  const text = describeRestoreFailure(
    failure("rollback_failed", {
      snapshotDir,
      previousUploadsDir,
      unrestoredMoves: [previousUploads, restoredUploads, previousDatabase],
      rollbackErrors: [new Error("EPERM: rename back failed")],
    }),
    live
  ).join("\n");

  assert.match(text, /rollback also failed/i);
  assert.match(text, /EPERM: rename back failed/);
  assert.match(text, /nothing was deleted/i);
  assert.ok(text.includes(snapshotDir));
  assert.ok(text.includes(previousUploadsDir));
  assert.match(text, /stop the app/i);

  // The restored copy in the way is cleared first, then each original goes
  // back where the app looks for it.
  const clearRestored = text.indexOf(`${live.uploadsDir} holds the restored backup`);
  const moveUploadsBack = text.indexOf(`Move ${previousUploadsDir} back to ${live.uploadsDir}`);
  assert.ok(clearRestored !== -1, text);
  assert.ok(moveUploadsBack > clearRestored, text);
  assert.ok(
    text.includes(`Move ${previousDatabase.to} back to ${live.databaseFile}`)
  );
});

test("an error with no recorded outcome claims nothing about the data", () => {
  const text = describeRestoreFailure(new Error("something unexpected"), live).join("\n");

  assert.doesNotMatch(text, /Nothing was changed/);
  assert.doesNotMatch(text, /moved back into place/);
  assert.match(text, /could not tell/i);
  assert.ok(text.includes(path.dirname(live.databaseFile)));
  assert.ok(text.includes(path.dirname(live.uploadsDir)));
});

test("a successful restore names where the previous data was kept", () => {
  const text = describeRestoreSuccess({
    ...live,
    snapshotDir,
    previousUploadsDir,
  }).join("\n");

  assert.match(text, /Restore succeeded/);
  assert.ok(text.includes(snapshotDir));
  assert.ok(text.includes(previousUploadsDir));
});
