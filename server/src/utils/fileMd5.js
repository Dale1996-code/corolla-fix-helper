import { createHash } from "node:crypto";

// The value stored in `documents.file_md5`: the lowercase hex MD5 of a file's
// exact bytes. Every writer of that column (web upload, bulk import, and the
// migration 007 backfill) computes it here, because the unique index on the
// column only catches a duplicate when all of them spell the hash the same way.
// MD5 is a duplicate key for local repair PDFs, not a security feature.
export function md5Hex(bytes) {
  return createHash("md5").update(bytes).digest("hex");
}
