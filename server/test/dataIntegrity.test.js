import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import request from "supertest";

// Data-integrity defects from the 2026-10-18 audit (Stage 4-D2). They began as
// todo tests: each pairs a plain test that pins the setup with a test that
// asserts the behavior the app should have, so that test could only fail for
// the defect itself. 1B-05 and 1B-03 are fixed, so neither carries `todo` now;
// the tests after each pair pin the edges of its fix.
const testDir = path.dirname(fileURLToPath(import.meta.url));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-data-integrity-"));

process.env.DATABASE_FILE = path.join(tempRoot, "data-integrity.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OPENAI_API_KEY = "";
process.env.NETWORK_MODE = "0";
process.env.OCR_ENABLED = "false";

fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

const { createApp } = await import("../src/app.js");
const { db } = await import("../src/database.js");

const app = createApp({ clientDistDir: path.join(tempRoot, "no-dist") });
const SAMPLE_PDF = fs.readFileSync(path.join(testDir, "fixtures", "sample-maintenance-schedule.pdf"));

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

async function createSymptomWithLinkedNote(title) {
  const symptom = await request(app).post("/api/symptoms").send({ title });
  assert.equal(symptom.status, 201, JSON.stringify(symptom.body));

  const note = await request(app).post("/api/notes").send({
    title: `${title} notes`,
    content: "Pads worn to the indicator.",
    relatedEntityType: "symptom",
    relatedEntityId: symptom.body.symptom.id,
  });
  assert.equal(note.status, 201, JSON.stringify(note.body));

  const removed = await request(app).delete(`/api/symptoms/${symptom.body.symptom.id}`);
  assert.ok(removed.status < 300, `deleting the symptom returned ${removed.status}`);

  return note.body.note.id;
}

const uploadSample = () =>
  request(app)
    .post("/api/documents/upload")
    .field("title", "Maintenance Schedule")
    .field("system", "Engine")
    .field("documentType", "manual")
    .attach("pdfFile", SAMPLE_PDF, {
      filename: "sample-maintenance-schedule.pdf",
      contentType: "application/pdf",
    });

test("setup: a note linked to a symptom survives the symptom's deletion", async () => {
  const noteId = await createSymptomWithLinkedNote("Grinding front brakes");
  const list = await request(app).get("/api/notes");

  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.ok(
    list.body.notes.some((note) => note.id === noteId),
    "the note vanished with its symptom"
  );
});

test(
  "deleting a symptom leaves its linked note editable",
  async () => {
    const noteId = await createSymptomWithLinkedNote("Squealing rear brakes");
    // Only the body changes; the dangling link is what the route re-validates.
    const edit = await request(app).put(`/api/notes/${noteId}`).send({ content: "Edited body only." });

    assert.equal(edit.status, 200, `edit after the parent was deleted -> ${edit.status} ${JSON.stringify(edit.body)}`);
  }
);

const getNoteById = async (noteId) =>
  (await request(app).get("/api/notes")).body.notes.find((note) => note.id === noteId);

test("1B-05: deleting a symptom unlinks its note and keeps the note's text", async () => {
  const noteId = await createSymptomWithLinkedNote("Shuddering under braking");
  const note = await getNoteById(noteId);

  assert.equal(note.relatedEntityType, "none");
  assert.equal(note.relatedEntityId, null);
  assert.equal(note.content, "Pads worn to the indicator.");
});

test("1B-05: deleting a procedure unlinks its note, which stays editable", async () => {
  const procedure = await request(app).post("/api/procedures").send({ title: "Replace rear pads" });
  assert.equal(procedure.status, 201, JSON.stringify(procedure.body));

  const note = await request(app).post("/api/notes").send({
    title: "Rear pad job",
    content: "Bought pads.",
    relatedEntityType: "procedure",
    relatedEntityId: procedure.body.procedure.id,
  });
  assert.equal(note.status, 201, JSON.stringify(note.body));

  const removed = await request(app).delete(`/api/procedures/${procedure.body.procedure.id}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal((await getNoteById(note.body.note.id)).relatedEntityType, "none");

  const edit = await request(app).put(`/api/notes/${note.body.note.id}`).send({ content: "Pads fitted." });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
});

test("1B-05: an edit clears a link that was already dangling before the fix", async () => {
  const symptom = await request(app).post("/api/symptoms").send({ title: "Pulls left" });
  const note = await request(app).post("/api/notes").send({
    title: "Alignment",
    content: "Pulls left at 60 mph.",
    relatedEntityType: "symptom",
    relatedEntityId: symptom.body.symptom.id,
  });
  // A database written before 1B-05: the symptom row went, the link stayed.
  db.prepare("DELETE FROM symptoms WHERE id = ?").run(symptom.body.symptom.id);

  // The client sends the note's existing link back with every edit.
  const edit = await request(app).put(`/api/notes/${note.body.note.id}`).send({
    content: "Pulls left at 60 mph; tires rotated.",
    relatedEntityType: "symptom",
    relatedEntityId: symptom.body.symptom.id,
  });

  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.equal(edit.body.note.relatedEntityType, "none");
  assert.equal(edit.body.note.relatedEntityId, null);
  assert.equal(edit.body.note.content, "Pulls left at 60 mph; tires rotated.");
});

test("1B-05: a NEW link to a record that does not exist is still a 400", async () => {
  const note = await request(app).post("/api/notes").send({ title: "Unlinked", content: "x" });
  const edit = await request(app).put(`/api/notes/${note.body.note.id}`).send({
    relatedEntityType: "symptom",
    relatedEntityId: 999999,
  });

  assert.equal(edit.status, 400, JSON.stringify(edit.body));
  assert.equal(edit.body.error, "Linked symptom does not exist.");
  assert.equal((await getNoteById(note.body.note.id)).relatedEntityType, "none");
});

test("setup: a web upload of the sample PDF succeeds", async () => {
  const response = await uploadSample();

  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.ok(response.body.document?.id, "the upload returned no document id");
});

test(
  "a web upload records file_md5, so the same PDF cannot enter twice",
  async () => {
    // The setup test above already uploaded these exact bytes once.
    const existing = db
      .prepare("SELECT id, file_md5 FROM documents WHERE original_filename = ? ORDER BY id")
      .all("sample-maintenance-schedule.pdf");
    assert.ok(existing.length >= 1, "the setup upload is missing");
    assert.ok(existing[0].file_md5, "web upload stored no file_md5");

    const duplicate = await uploadSample();
    assert.equal(duplicate.status, 409, `duplicate upload -> ${duplicate.status}`);
  }
);

const uploadBytes = (bytes, filename) =>
  request(app)
    .post("/api/documents/upload")
    .field("title", filename)
    .field("system", "Engine")
    .field("documentType", "manual")
    .attach("pdfFile", bytes, { filename, contentType: "application/pdf" });

test("1B-03: the 409 names the existing document and stores nothing", async () => {
  const existing = db
    .prepare("SELECT id, title FROM documents WHERE original_filename = ? ORDER BY id LIMIT 1")
    .get("sample-maintenance-schedule.pdf");
  const countBefore = db.prepare("SELECT COUNT(*) AS c FROM documents").get().c;
  const filesBefore = fs.readdirSync(process.env.UPLOADS_DIR).sort();

  // A different filename does not make the same bytes a different PDF.
  const duplicate = await uploadBytes(SAMPLE_PDF, "renamed-copy.pdf");

  assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
  assert.equal(duplicate.body.error, `This PDF is already uploaded as "${existing.title}".`);
  assert.deepEqual(duplicate.body.existingDocument, { id: existing.id, title: existing.title });
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM documents").get().c, countBefore);
  assert.deepEqual(fs.readdirSync(process.env.UPLOADS_DIR).sort(), filesBefore);
});

test("1B-03: two simultaneous uploads of new bytes store exactly one document", async () => {
  // Bytes no other test uploads: the sample with a trailing comment.
  const fresh = Buffer.concat([SAMPLE_PDF, Buffer.from("\n% simultaneous-upload variant\n")]);
  const countBefore = db.prepare("SELECT COUNT(*) AS c FROM documents").get().c;

  // Both can pass the up-front check while the other is still extracting; the
  // unique index on file_md5 must then turn the loser into the same 409.
  const responses = await Promise.all([
    uploadBytes(fresh, "first-tab.pdf"),
    uploadBytes(fresh, "second-tab.pdf"),
  ]);

  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM documents").get().c, countBefore + 1);
});

test("1B-03: a PDF whose bytes differ still uploads, whatever its name", async () => {
  const different = Buffer.concat([SAMPLE_PDF, Buffer.from("\n% a different revision\n")]);
  const response = await uploadBytes(different, "sample-maintenance-schedule.pdf");

  assert.equal(response.status, 201, JSON.stringify(response.body));
});
