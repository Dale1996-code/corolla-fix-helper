import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "corolla-fix-helper-attachment-service-")
);

process.env.DATABASE_FILE = path.join(tempRoot, "attachments.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

const { db } = await import("../src/database.js");
const { initializeDatabase } = await import("../src/initDatabase.js");
const { config } = await import("../src/config.js");
const {
  ALLOWED_IMAGE_MIME_TYPES,
  ATTACHMENT_ENTITY_TYPES,
  createAttachment,
  deleteAttachment,
  deleteAttachmentsForEntity,
  getAttachmentsImageDir,
  listAllAttachments,
  listAttachments,
} = await import("../src/services/attachmentService.js");

initializeDatabase();

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeImage(overrides = {}) {
  return {
    entityType: "symptom",
    entityId: 1,
    originalFilename: "rough-idle.png",
    mimeType: "image/png",
    buffer: PNG_BYTES,
    caption: "What I saw",
    ...overrides,
  };
}

test("the allow-lists match the requested image types and entities", () => {
  assert.deepEqual(
    [...ALLOWED_IMAGE_MIME_TYPES].sort(),
    ["image/jpeg", "image/png", "image/webp"]
  );
  assert.deepEqual(
    [...ATTACHMENT_ENTITY_TYPES].sort(),
    ["note", "procedure", "symptom"]
  );
});

test("getAttachmentsImageDir lives under the uploads dir", () => {
  assert.equal(
    getAttachmentsImageDir(),
    path.join(config.uploadsDir, "attachments", "images")
  );
});

test("createAttachment writes the file and lists it back", async () => {
  const created = await createAttachment(makeImage({ entityId: 10 }));

  assert.ok(created.id > 0);
  assert.equal(created.entityType, "symptom");
  assert.equal(created.entityId, 10);
  assert.equal(created.mimeType, "image/png");
  assert.equal(created.originalFilename, "rough-idle.png");
  assert.equal(created.caption, "What I saw");

  const onDisk = path.join(getAttachmentsImageDir(), created.storedFilename);
  assert.ok(fs.existsSync(onDisk), "stored image file should exist on disk");

  const listed = listAttachments("symptom", 10);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, created.id);
});

test("listAttachments is scoped to one entity", async () => {
  await createAttachment(makeImage({ entityType: "procedure", entityId: 20 }));
  await createAttachment(makeImage({ entityType: "note", entityId: 20 }));

  const procedureAttachments = listAttachments("procedure", 20);
  assert.equal(procedureAttachments.length, 1);
  assert.equal(procedureAttachments[0].entityType, "procedure");
});

test("deleteAttachment removes the row and the file", async () => {
  const created = await createAttachment(makeImage({ entityId: 30 }));
  const onDisk = path.join(getAttachmentsImageDir(), created.storedFilename);
  assert.ok(fs.existsSync(onDisk));

  const removed = await deleteAttachment(created.id);

  assert.equal(removed.id, created.id);
  assert.ok(!fs.existsSync(onDisk), "file should be gone after delete");
  assert.equal(listAttachments("symptom", 30).length, 0);
});

test("deleteAttachment returns null for an unknown id", async () => {
  assert.equal(await deleteAttachment(999999), null);
});

test("deleteAttachmentsForEntity clears every row and file for the entity", async () => {
  await createAttachment(makeImage({ entityType: "note", entityId: 40 }));
  const second = await createAttachment(
    makeImage({ entityType: "note", entityId: 40 })
  );
  const secondOnDisk = path.join(
    getAttachmentsImageDir(),
    second.storedFilename
  );

  const removedCount = await deleteAttachmentsForEntity("note", 40);

  assert.equal(removedCount, 2);
  assert.ok(!fs.existsSync(secondOnDisk));
  assert.equal(listAttachments("note", 40).length, 0);
});

test("listAllAttachments returns every stored image across entities, newest-first", async () => {
  const first = await createAttachment(
    makeImage({ entityType: "symptom", entityId: 500 })
  );
  const second = await createAttachment(
    makeImage({ entityType: "note", entityId: 501 })
  );

  const all = listAllAttachments();
  const ids = all.map((attachment) => attachment.id);

  assert.ok(ids.includes(first.id));
  assert.ok(ids.includes(second.id));
  // Newest-first: the later-created row sorts ahead of the earlier one.
  assert.ok(ids.indexOf(second.id) < ids.indexOf(first.id));

  const seenSecond = all.find((attachment) => attachment.id === second.id);
  assert.equal(seenSecond.entityType, "note");
  assert.equal(seenSecond.entityId, 501);
  assert.equal(seenSecond.mimeType, "image/png");
  assert.equal(seenSecond.originalFilename, "rough-idle.png");
});

test("createAttachment rejects an unknown entity type", async () => {
  await assert.rejects(
    () => createAttachment(makeImage({ entityType: "vehicle", entityId: 1 })),
    /entity type/i
  );
});

test("createAttachment rejects a non-image mime type", async () => {
  await assert.rejects(
    () =>
      createAttachment(
        makeImage({ mimeType: "application/pdf", originalFilename: "manual.pdf" })
      ),
    /image/i
  );
});

test("deleteAttachmentsForEntity rejects an unknown entity type", async () => {
  await assert.rejects(
    () => deleteAttachmentsForEntity("vehicle", 1),
    /entity type/i
  );
});
