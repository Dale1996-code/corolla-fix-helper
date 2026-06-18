import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import request from "supertest";

const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "corolla-fix-helper-attachments-route-")
);

process.env.DATABASE_FILE = path.join(tempRoot, "attachments.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
process.env.OPENAI_API_KEY = "";
process.env.OCR_ENABLED = "false";

const { createApp } = await import("../src/app.js");
const { db } = await import("../src/database.js");
const { getAttachmentsImageDir } = await import(
  "../src/services/attachmentService.js"
);

const app = createApp();

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function createSymptom(title) {
  const response = await request(app)
    .post("/api/symptoms")
    .send({ title })
    .expect(201);

  return response.body.symptom.id;
}

async function attachImageToSymptom(symptomId, filename = "evidence.png") {
  return request(app)
    .post("/api/attachments")
    .field("entityType", "symptom")
    .field("entityId", String(symptomId))
    .field("caption", "Engine bay")
    .attach("image", PNG_BYTES, { filename, contentType: "image/png" });
}

test("POST /api/attachments stores an image and GET lists it", async () => {
  const symptomId = await createSymptom("Rough idle");

  const createResponse = await attachImageToSymptom(symptomId);
  assert.equal(createResponse.status, 201);

  const attachment = createResponse.body.attachment;
  assert.ok(attachment.id > 0);
  assert.equal(attachment.entityType, "symptom");
  assert.equal(attachment.entityId, symptomId);
  assert.equal(attachment.caption, "Engine bay");

  const onDisk = path.join(getAttachmentsImageDir(), attachment.storedFilename);
  assert.ok(fs.existsSync(onDisk));

  const listResponse = await request(app)
    .get("/api/attachments")
    .query({ entityType: "symptom", entityId: symptomId })
    .expect(200);

  assert.equal(listResponse.body.attachments.length, 1);
  assert.equal(listResponse.body.attachments[0].id, attachment.id);
});

test("GET /api/attachments/:id/file serves the stored image bytes", async () => {
  const symptomId = await createSymptom("Brake squeal");
  const createResponse = await attachImageToSymptom(symptomId);
  const attachmentId = createResponse.body.attachment.id;

  const fileResponse = await request(app)
    .get(`/api/attachments/${attachmentId}/file`)
    .expect(200);

  assert.match(fileResponse.headers["content-type"], /image\/png/);
  assert.ok(Buffer.from(fileResponse.body).equals(PNG_BYTES));
});

test("DELETE /api/attachments/:id removes the row and the file", async () => {
  const symptomId = await createSymptom("Coolant smell");
  const createResponse = await attachImageToSymptom(symptomId);
  const attachment = createResponse.body.attachment;
  const onDisk = path.join(getAttachmentsImageDir(), attachment.storedFilename);
  assert.ok(fs.existsSync(onDisk));

  await request(app).delete(`/api/attachments/${attachment.id}`).expect(200);

  assert.ok(!fs.existsSync(onDisk));

  const listResponse = await request(app)
    .get("/api/attachments")
    .query({ entityType: "symptom", entityId: symptomId })
    .expect(200);
  assert.equal(listResponse.body.attachments.length, 0);
});

test("POST /api/attachments rejects a non-image upload", async () => {
  const symptomId = await createSymptom("Wobble");

  const response = await request(app)
    .post("/api/attachments")
    .field("entityType", "symptom")
    .field("entityId", String(symptomId))
    .attach("image", Buffer.from("not an image"), {
      filename: "notes.txt",
      contentType: "text/plain",
    });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /image/i);
});

test("POST /api/attachments rejects an unknown entity type", async () => {
  const response = await request(app)
    .post("/api/attachments")
    .field("entityType", "vehicle")
    .field("entityId", "1")
    .attach("image", PNG_BYTES, {
      filename: "evidence.png",
      contentType: "image/png",
    });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /entity type/i);
});

test("deleting a symptom removes its attachments and files", async () => {
  const symptomId = await createSymptom("Vibration");
  const createResponse = await attachImageToSymptom(symptomId);
  const onDisk = path.join(
    getAttachmentsImageDir(),
    createResponse.body.attachment.storedFilename
  );
  assert.ok(fs.existsSync(onDisk));

  await request(app).delete(`/api/symptoms/${symptomId}`).expect(200);

  assert.ok(!fs.existsSync(onDisk), "attachment file should be cleaned up");
  const remaining = db
    .prepare(
      "SELECT COUNT(*) AS n FROM attachments WHERE entity_type = 'symptom' AND entity_id = ?"
    )
    .get(symptomId).n;
  assert.equal(remaining, 0);
});

test("deleting a procedure removes its attachments", async () => {
  const procedureResponse = await request(app)
    .post("/api/procedures")
    .send({ title: "Bleed brakes" })
    .expect(201);
  const procedureId = procedureResponse.body.procedure.id;

  await request(app)
    .post("/api/attachments")
    .field("entityType", "procedure")
    .field("entityId", String(procedureId))
    .attach("image", PNG_BYTES, {
      filename: "step.png",
      contentType: "image/png",
    })
    .expect(201);

  await request(app).delete(`/api/procedures/${procedureId}`).expect(200);

  const remaining = db
    .prepare(
      "SELECT COUNT(*) AS n FROM attachments WHERE entity_type = 'procedure' AND entity_id = ?"
    )
    .get(procedureId).n;
  assert.equal(remaining, 0);
});

test("deleting a note removes its attachments", async () => {
  const noteResponse = await request(app)
    .post("/api/notes")
    .send({ title: "Torque spec", content: "80 Nm" })
    .expect(201);
  const noteId = noteResponse.body.note.id;

  await request(app)
    .post("/api/attachments")
    .field("entityType", "note")
    .field("entityId", String(noteId))
    .attach("image", PNG_BYTES, {
      filename: "spec.png",
      contentType: "image/png",
    })
    .expect(201);

  await request(app).delete(`/api/notes/${noteId}`).expect(200);

  const remaining = db
    .prepare(
      "SELECT COUNT(*) AS n FROM attachments WHERE entity_type = 'note' AND entity_id = ?"
    )
    .get(noteId).n;
  assert.equal(remaining, 0);
});
