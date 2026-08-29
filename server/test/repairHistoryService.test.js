import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Repair history's integrity guarantees, exercised against a real SQLite file
// rather than through HTTP, because what is being pinned here is the SCHEMA and
// the transaction boundaries -- not request parsing.
//
// The properties below are the reason this table exists at all. A completed
// repair must stay true after the records it points at are renamed, edited, or
// deleted; and a repair record must never commit half-written.

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-repair-history-"));

process.env.DATABASE_FILE = path.join(tempRoot, "history.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OPENAI_API_KEY = "";

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const {
  createRepairHistory,
  deleteRepairHistory,
  getRepairHistory,
  listRepairHistory,
  normalizeOdometerMiles,
  normalizeOutcome,
  normalizePerformedOn,
  normalizeSourceInputs,
  updateRepairHistory,
  MAX_ODOMETER_MILES,
} = await import("../src/services/repairHistoryService.js");

initializeDatabase();

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function vehicleId() {
  return Number(db.prepare("SELECT id FROM vehicles ORDER BY id ASC LIMIT 1").get().id);
}

function insertDocument(title) {
  return Number(
    db
      .prepare(`
        INSERT INTO documents (
          vehicle_id, title, original_filename, stored_filename, file_path,
          file_type, system, document_type, extraction_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        vehicleId(),
        title,
        `${title}.pdf`,
        `${title}-stored.pdf`,
        `server/uploads/${title}.pdf`,
        "application/pdf",
        "Brakes",
        "Repair Manual",
        "completed"
      ).lastInsertRowid
  );
}

function insertSymptom(title) {
  return Number(
    db
      .prepare("INSERT INTO symptoms (vehicle_id, title, system, status) VALUES (?, ?, ?, ?)")
      .run(vehicleId(), title, "Brakes", "open").lastInsertRowid
  );
}

function insertChecklist(title) {
  return Number(
    db
      .prepare("INSERT INTO repair_checklists (vehicle_id, title, status) VALUES (?, ?, ?)")
      .run(vehicleId(), title, "planned").lastInsertRowid
  );
}

function sourceRowCount(repairHistoryId) {
  return Number(
    db
      .prepare("SELECT COUNT(*) AS count FROM repair_history_documents WHERE repair_history_id = ?")
      .get(repairHistoryId).count
  );
}

function historyRowCount() {
  return Number(db.prepare("SELECT COUNT(*) AS count FROM repair_history").get().count);
}

function baseFields(overrides = {}) {
  return {
    performedOn: "2026-08-14",
    odometerMiles: 142350,
    title: "Front brake pads and rotors",
    outcome: "fixed",
    summary: "Replaced pads and rotors on both sides.",
    followUp: "Re-torque the lug nuts after 50 miles.",
    symptomId: null,
    checklistId: null,
    sources: [],
    ...overrides,
  };
}

test("migration 004 creates both tables with the expected shape", () => {
  const applied = db
    .prepare("SELECT 1 FROM schema_migrations WHERE name = ?")
    .get("004_repair_history");
  assert.ok(applied, "004_repair_history should be recorded as applied");

  const historyColumns = db
    .prepare("PRAGMA table_info(repair_history)")
    .all()
    .map((column) => column.name);

  for (const expected of [
    "id",
    "vehicle_id",
    "performed_on",
    "odometer_miles",
    "title",
    "outcome",
    "summary",
    "follow_up",
    "symptom_id",
    "symptom_title",
    "checklist_id",
    "checklist_title",
    "created_at",
    "updated_at",
  ]) {
    assert.ok(historyColumns.includes(expected), `repair_history should have ${expected}`);
  }

  const sourceColumns = db
    .prepare("PRAGMA table_info(repair_history_documents)")
    .all()
    .map((column) => column.name);

  for (const expected of [
    "id",
    "repair_history_id",
    "document_id",
    "document_title",
    "page_number",
  ]) {
    assert.ok(
      sourceColumns.includes(expected),
      `repair_history_documents should have ${expected}`
    );
  }

  // `vehicles` must be untouched by this migration -- the odometer is a fact on
  // the repair, and there is deliberately no vehicle-level current reading.
  const vehicleColumns = db
    .prepare("PRAGMA table_info(vehicles)")
    .all()
    .map((column) => String(column.name));
  assert.ok(
    !vehicleColumns.some((column) => /odometer|mileage/i.test(column)),
    "migration 004 must not add an odometer column to vehicles"
  );

  const indexNames = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all()
    .map((row) => row.name);

  for (const expectedIndex of [
    "idx_repair_history_vehicle_performed",
    "idx_repair_history_symptom",
    "idx_repair_history_checklist",
    "idx_repair_history_documents_history",
    "idx_repair_history_documents_document",
    "idx_repair_history_documents_unique",
  ]) {
    assert.ok(indexNames.includes(expectedIndex), `${expectedIndex} should exist`);
  }

  // The uniqueness backstop must stay PARTIAL: without the predicate, several
  // provenance rows dropping to document_id NULL after a document delete would
  // collide with each other.
  const uniqueIndexSql = String(
    db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_repair_history_documents_unique").sql
  );
  assert.match(uniqueIndexSql, /WHERE document_id IS NOT NULL/i);
});

test("creates a record with date, mileage, symptom, checklist and a document source", () => {
  const symptomId = insertSymptom("Grinding noise when braking");
  const checklistId = insertChecklist("Front brake job");
  const documentId = insertDocument("brake-service");

  const created = createRepairHistory(
    vehicleId(),
    baseFields({
      symptomId,
      checklistId,
      sources: [{ documentId, pageNumber: 412 }],
    })
  );

  assert.ok(created.id > 0);
  assert.equal(created.performedOn, "2026-08-14");
  assert.equal(created.odometerMiles, 142350);
  assert.equal(created.title, "Front brake pads and rotors");
  assert.equal(created.outcome, "fixed");
  assert.equal(created.summary, "Replaced pads and rotors on both sides.");
  assert.equal(created.followUp, "Re-torque the lug nuts after 50 miles.");
  assert.equal(created.symptomId, symptomId);
  assert.equal(created.checklistId, checklistId);

  // Snapshots are copied at creation, from the live records.
  assert.equal(created.symptomTitle, "Grinding noise when braking");
  assert.equal(created.checklistTitle, "Front brake job");

  assert.equal(created.sourceCount, 1);
  assert.equal(created.sources[0].documentId, documentId);
  assert.equal(created.sources[0].documentTitle, "brake-service");
  assert.equal(created.sources[0].pageNumber, 412);

  // The list view returns the same shape as the single read.
  const listed = listRepairHistory(vehicleId()).find((row) => row.id === created.id);
  assert.deepEqual(listed, created);
});

test("renaming a linked symptom does not rewrite the history snapshot", () => {
  const symptomId = insertSymptom("Original symptom title");
  const created = createRepairHistory(vehicleId(), baseFields({ symptomId }));

  assert.equal(created.symptomTitle, "Original symptom title");

  db.prepare("UPDATE symptoms SET title = ? WHERE id = ?").run("Renamed symptom", symptomId);

  const liveSymptomTitle = String(
    db.prepare("SELECT title FROM symptoms WHERE id = ?").get(symptomId).title
  );
  assert.equal(liveSymptomTitle, "Renamed symptom", "the live symptom really was renamed");

  const reread = getRepairHistory(vehicleId(), created.id);
  assert.equal(reread.symptomTitle, "Original symptom title");
  assert.equal(reread.symptomId, symptomId, "the live link is kept alongside the snapshot");
});

test("editing a linked checklist does not rewrite the history snapshot", () => {
  const checklistId = insertChecklist("Original checklist title");
  const created = createRepairHistory(vehicleId(), baseFields({ checklistId }));

  assert.equal(created.checklistTitle, "Original checklist title");

  db.prepare("UPDATE repair_checklists SET title = ?, status = ? WHERE id = ?").run(
    "Rewritten checklist title",
    "done",
    checklistId
  );

  const reread = getRepairHistory(vehicleId(), created.id);
  assert.equal(reread.checklistTitle, "Original checklist title");
  assert.equal(reread.checklistId, checklistId);
});

test("deleting a source document leaves the history record and its provenance intact", () => {
  const documentId = insertDocument("wiring-diagram");
  const created = createRepairHistory(
    vehicleId(),
    baseFields({ sources: [{ documentId, pageNumber: 7 }] })
  );

  db.prepare("DELETE FROM documents WHERE id = ?").run(documentId);

  const reread = getRepairHistory(vehicleId(), created.id);

  assert.ok(reread, "the repair record must survive the document delete");
  assert.equal(reread.sourceCount, 1, "the provenance row must survive too");
  assert.equal(reread.sources[0].documentId, null, "the live link is cleared");
  assert.equal(
    reread.sources[0].documentTitle,
    "wiring-diagram",
    "the snapshot title still names the evidence"
  );
  assert.equal(reread.sources[0].pageNumber, 7, "the cited page still survives");
});

test("deleting a linked symptom clears the link but keeps the snapshot", () => {
  const symptomId = insertSymptom("Symptom that will be deleted");
  const created = createRepairHistory(vehicleId(), baseFields({ symptomId }));

  db.prepare("DELETE FROM symptoms WHERE id = ?").run(symptomId);

  const reread = getRepairHistory(vehicleId(), created.id);
  assert.ok(reread, "the repair record must survive the symptom delete");
  assert.equal(reread.symptomId, null);
  assert.equal(reread.symptomTitle, "Symptom that will be deleted");
});

test("deleting a history record cascades its provenance rows away", () => {
  const documentId = insertDocument("cascade-source");
  const created = createRepairHistory(
    vehicleId(),
    baseFields({ sources: [{ documentId, pageNumber: 3 }] })
  );

  assert.equal(sourceRowCount(created.id), 1);

  const removed = deleteRepairHistory(vehicleId(), created.id);

  assert.equal(removed, 1);
  assert.equal(getRepairHistory(vehicleId(), created.id), null);
  assert.equal(sourceRowCount(created.id), 0, "provenance rows must cascade with their parent");
});

test("editing scalar fields never refreshes a snapshot", () => {
  const symptomId = insertSymptom("Snapshot at creation time");
  const checklistId = insertChecklist("Checklist at creation time");
  const documentId = insertDocument("doc-at-creation-time");

  const created = createRepairHistory(
    vehicleId(),
    baseFields({ symptomId, checklistId, sources: [{ documentId, pageNumber: 11 }] })
  );

  // Everything the record points at is renamed after the fact.
  db.prepare("UPDATE symptoms SET title = ? WHERE id = ?").run("Symptom renamed later", symptomId);
  db.prepare("UPDATE repair_checklists SET title = ? WHERE id = ?").run(
    "Checklist renamed later",
    checklistId
  );
  db.prepare("UPDATE documents SET title = ? WHERE id = ?").run(
    "Document renamed later",
    documentId
  );

  // A plain field edit: no relationship keys supplied at all.
  const updated = updateRepairHistory(vehicleId(), created.id, {
    performedOn: created.performedOn,
    odometerMiles: created.odometerMiles,
    title: created.title,
    outcome: "partial",
    summary: "Noise came back after a week.",
    followUp: created.followUp,
  });

  assert.equal(updated.outcome, "partial");
  assert.equal(updated.summary, "Noise came back after a week.");

  assert.equal(updated.symptomTitle, "Snapshot at creation time");
  assert.equal(updated.checklistTitle, "Checklist at creation time");
  assert.equal(updated.sources[0].documentTitle, "doc-at-creation-time");
  assert.equal(updated.sources[0].pageNumber, 11);
});

test("explicitly changing a relationship captures the new snapshot", () => {
  const firstSymptomId = insertSymptom("First symptom");
  const secondSymptomId = insertSymptom("Second symptom");
  const firstChecklistId = insertChecklist("First checklist");
  const secondChecklistId = insertChecklist("Second checklist");
  const firstDocumentId = insertDocument("first-doc");
  const secondDocumentId = insertDocument("second-doc");

  const created = createRepairHistory(
    vehicleId(),
    baseFields({
      symptomId: firstSymptomId,
      checklistId: firstChecklistId,
      sources: [{ documentId: firstDocumentId, pageNumber: 1 }],
    })
  );

  const updated = updateRepairHistory(vehicleId(), created.id, {
    performedOn: created.performedOn,
    odometerMiles: created.odometerMiles,
    title: created.title,
    outcome: created.outcome,
    summary: created.summary,
    followUp: created.followUp,
    symptomChange: { symptomId: secondSymptomId },
    checklistChange: { checklistId: secondChecklistId },
    sources: [{ documentId: secondDocumentId, pageNumber: 22 }],
  });

  assert.equal(updated.symptomId, secondSymptomId);
  assert.equal(updated.symptomTitle, "Second symptom");
  assert.equal(updated.checklistId, secondChecklistId);
  assert.equal(updated.checklistTitle, "Second checklist");
  assert.equal(updated.sourceCount, 1, "sources are replaced, not appended");
  assert.equal(updated.sources[0].documentId, secondDocumentId);
  assert.equal(updated.sources[0].documentTitle, "second-doc");
  assert.equal(updated.sources[0].pageNumber, 22);
});

test("explicitly clearing a relationship clears its snapshot too", () => {
  const symptomId = insertSymptom("Wrongly attributed symptom");
  const created = createRepairHistory(vehicleId(), baseFields({ symptomId }));

  const updated = updateRepairHistory(vehicleId(), created.id, {
    performedOn: created.performedOn,
    odometerMiles: created.odometerMiles,
    title: created.title,
    outcome: created.outcome,
    summary: created.summary,
    followUp: created.followUp,
    symptomChange: { symptomId: null },
    sources: [],
  });

  // A cleared link is the owner correcting the record, which is different from
  // a symptom that was deleted -- so the snapshot goes with it. A title left
  // behind a null id would be indistinguishable from the deletion case.
  assert.equal(updated.symptomId, null);
  assert.equal(updated.symptomTitle, "");
  assert.equal(updated.sourceCount, 0);
});

test("a failed source insert rolls back the whole create", () => {
  const documentId = insertDocument("atomic-create-source");
  const before = historyRowCount();

  // A negative page number passes the service's own reads and is refused by the
  // schema CHECK mid-transaction -- after the parent row has already been
  // inserted. That is exactly the partial-write the transaction must prevent.
  assert.throws(() =>
    createRepairHistory(
      vehicleId(),
      baseFields({
        title: "Should never be committed",
        sources: [{ documentId, pageNumber: -5 }],
      })
    )
  );

  assert.equal(historyRowCount(), before, "the parent row must be rolled back with its failed child");

  const orphan = Number(
    db
      .prepare("SELECT COUNT(*) AS count FROM repair_history WHERE title = ?")
      .get("Should never be committed").count
  );
  assert.equal(orphan, 0);
});

test("a failed source insert rolls back the scalar half of an update too", () => {
  const documentId = insertDocument("atomic-update-source");
  const created = createRepairHistory(
    vehicleId(),
    baseFields({ summary: "Original summary", sources: [{ documentId, pageNumber: 4 }] })
  );

  assert.throws(() =>
    updateRepairHistory(vehicleId(), created.id, {
      performedOn: "2026-09-01",
      odometerMiles: 150000,
      title: "Rewritten title",
      outcome: "not_fixed",
      summary: "Rewritten summary",
      followUp: "",
      sources: [{ documentId, pageNumber: 0 }],
    })
  );

  const reread = getRepairHistory(vehicleId(), created.id);

  assert.equal(reread.summary, "Original summary", "the scalar update must roll back");
  assert.equal(reread.title, "Front brake pads and rotors");
  assert.equal(reread.performedOn, "2026-08-14");
  assert.equal(reread.sourceCount, 1, "the original provenance must survive the failed replace");
  assert.equal(reread.sources[0].pageNumber, 4);
});

test("an unknown linked record is refused rather than silently stored", () => {
  assert.throws(
    () => createRepairHistory(vehicleId(), baseFields({ symptomId: 999999 })),
    /Linked symptom does not exist/
  );

  assert.throws(
    () => createRepairHistory(vehicleId(), baseFields({ checklistId: 999999 })),
    /Linked checklist does not exist/
  );

  assert.throws(
    () =>
      createRepairHistory(
        vehicleId(),
        baseFields({ sources: [{ documentId: 999999, pageNumber: null }] })
      ),
    /Linked document 999999 does not exist/
  );
});

test("normalizePerformedOn accepts only real YYYY-MM-DD calendar dates", () => {
  assert.equal(normalizePerformedOn("2026-08-29"), "2026-08-29");
  assert.equal(normalizePerformedOn("  2024-02-29  "), "2024-02-29", "a real leap day");

  for (const invalid of [
    "2026-02-30",
    "2025-02-29",
    "08/29/2026",
    "2026-8-29",
    "2026-13-01",
    "2026-00-10",
    "2026-08-00",
    "2026-08-32",
    "August 29, 2026",
    "2026-08-29T10:00:00Z",
    "",
    null,
    42,
  ]) {
    assert.throws(
      () => normalizePerformedOn(invalid),
      /Repair date/,
      `${JSON.stringify(invalid)} must be rejected`
    );
  }
});

test("normalizeOdometerMiles accepts null and whole miles in range only", () => {
  assert.equal(normalizeOdometerMiles(null), null);
  assert.equal(normalizeOdometerMiles(undefined), null);
  assert.equal(normalizeOdometerMiles(0), 0, "zero is a reading, not a missing value");
  assert.equal(normalizeOdometerMiles(142350), 142350);
  assert.equal(normalizeOdometerMiles(MAX_ODOMETER_MILES), MAX_ODOMETER_MILES);

  for (const invalid of [-1, -142350, 142350.5, MAX_ODOMETER_MILES + 1, Number.NaN, Infinity]) {
    assert.throws(
      () => normalizeOdometerMiles(invalid),
      /Odometer reading/,
      `${invalid} must be rejected`
    );
  }

  // A numeric string is refused rather than coerced: Number("") is 0, so
  // coercion would turn a blank field into a reading of zero miles.
  assert.throws(() => normalizeOdometerMiles("142350"), /Odometer reading/);
  assert.throws(() => normalizeOdometerMiles(""), /Odometer reading/);
});

test("normalizeOutcome pins the allowed vocabulary", () => {
  assert.equal(normalizeOutcome(""), "unknown");
  assert.equal(normalizeOutcome("FIXED"), "fixed");
  assert.equal(normalizeOutcome("not_fixed"), "not_fixed");
  assert.equal(normalizeOutcome("partial"), "partial");
  assert.throws(() => normalizeOutcome("resolved"), /Outcome must be/);
});

test("normalizeSourceInputs deduplicates deterministically and validates entries", () => {
  const deduped = normalizeSourceInputs([
    { documentId: 5, pageNumber: 12 },
    { documentId: 5, pageNumber: 12 },
    { documentId: 5, pageNumber: 13 },
    { documentId: 5 },
    { documentId: 5, pageNumber: null },
    { documentId: 6, pageNumber: 12 },
  ]);

  assert.deepEqual(deduped, [
    { documentId: 5, pageNumber: 12 },
    { documentId: 5, pageNumber: 13 },
    { documentId: 5, pageNumber: null },
    { documentId: 6, pageNumber: 12 },
  ]);

  assert.deepEqual(normalizeSourceInputs(null), []);
  assert.deepEqual(normalizeSourceInputs(undefined), []);

  // A malformed sources payload is refused, never quietly treated as empty:
  // silently dropping evidence is the failure this feature exists to prevent.
  assert.throws(() => normalizeSourceInputs("doc-1"), /must be an array/);
  assert.throws(() => normalizeSourceInputs([null]), /must be an object/);
  assert.throws(() => normalizeSourceInputs([{ documentId: 0 }]), /positive number/);
  assert.throws(() => normalizeSourceInputs([{ documentId: 5, pageNumber: -1 }]), /pageNumber/);
});

test("duplicate source input creates exactly one provenance row", () => {
  const documentId = insertDocument("deduplicated-doc");
  const created = createRepairHistory(
    vehicleId(),
    baseFields({
      sources: normalizeSourceInputs([
        { documentId, pageNumber: 9 },
        { documentId, pageNumber: 9 },
      ]),
    })
  );

  assert.equal(created.sourceCount, 1);
  assert.equal(sourceRowCount(created.id), 1);
});

test("history is listed by the day the work happened, not by row activity", () => {
  db.exec("DELETE FROM repair_history");

  const older = createRepairHistory(
    vehicleId(),
    baseFields({ performedOn: "2020-01-15", title: "Older job" })
  );
  const newer = createRepairHistory(
    vehicleId(),
    baseFields({ performedOn: "2026-08-14", title: "Newer job" })
  );

  // Touch the OLDER record last. Ordering by activity would float it to the top.
  updateRepairHistory(vehicleId(), older.id, {
    performedOn: "2020-01-15",
    odometerMiles: null,
    title: "Older job",
    outcome: "fixed",
    summary: "Edited long afterwards.",
    followUp: "",
  });

  const listed = listRepairHistory(vehicleId());

  assert.equal(listed[0].id, newer.id, "the most recent work comes first");
  assert.equal(listed[1].id, older.id);
});
