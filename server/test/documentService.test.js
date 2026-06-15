import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point at an isolated database/uploads dir before importing modules that open
// the SQLite connection, so this file does not contend with the default DB used
// by other test files running in parallel.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-doc-service-"));

process.env.DATABASE_FILE = path.join(tempRoot, "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

const { config } = await import("../src/config.js");
const { resolveStoredFilePath } = await import("../src/services/documentService.js");

test("resolveStoredFilePath prefers stored_filename and joins the uploads dir", () => {
  const resolved = resolveStoredFilePath({
    stored_filename: "abc.pdf",
    file_path: "server/uploads/abc.pdf",
  });

  assert.deepEqual(resolved, {
    safeFileName: "abc.pdf",
    absoluteFilePath: path.join(config.uploadsDir, "abc.pdf"),
  });
});

test("resolveStoredFilePath falls back to the basename of file_path", () => {
  const resolved = resolveStoredFilePath({
    stored_filename: "",
    file_path: "server/uploads/nested/legacy.pdf",
  });

  assert.equal(resolved.safeFileName, "legacy.pdf");
});

test("resolveStoredFilePath strips directory traversal from stored values", () => {
  const resolved = resolveStoredFilePath({
    stored_filename: "../../etc/passwd",
    file_path: "",
  });

  assert.equal(resolved.safeFileName, "passwd");
  assert.equal(resolved.absoluteFilePath, path.join(config.uploadsDir, "passwd"));
});

test("resolveStoredFilePath returns null when no filename reference exists", () => {
  assert.equal(resolveStoredFilePath({ stored_filename: "", file_path: "" }), null);
});
