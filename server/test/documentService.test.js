import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { config } from "../src/config.js";
import { resolveStoredFilePath } from "../src/services/documentService.js";

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
