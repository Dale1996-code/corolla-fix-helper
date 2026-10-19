import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import request from "supertest";

// Known data-integrity defects from the 2026-10-18 audit, as todo tests. Each
// pairs a plain test that pins the setup with a todo that asserts the behavior
// the app should have, so the todo can only be failing for the defect itself.
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
  { todo: "1B-05" },
  async () => {
    const noteId = await createSymptomWithLinkedNote("Squealing rear brakes");
    // Only the body changes; the dangling link is what the route re-validates.
    const edit = await request(app).put(`/api/notes/${noteId}`).send({ content: "Edited body only." });

    assert.equal(edit.status, 200, `edit after the parent was deleted -> ${edit.status} ${JSON.stringify(edit.body)}`);
  }
);

test("setup: a web upload of the sample PDF succeeds", async () => {
  const response = await uploadSample();

  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.ok(response.body.document?.id, "the upload returned no document id");
});

test(
  "a web upload records file_md5, so the same PDF cannot enter twice",
  { todo: "1B-03" },
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
