import assert from "node:assert/strict";
import test from "node:test";
import { hasPdfSignature, PDF_SIGNATURE_SEARCH_WINDOW } from "../src/utils/pdfSignature.js";

// The upload's byte check (audit 2A-09). It must refuse what a browser saves
// under a .pdf name when the download was really a page, and must keep every
// file pdf.js itself would open, which searches the same 1024-byte window.

test("a file that starts with the PDF header passes", () => {
  assert.equal(hasPdfSignature(Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "latin1")), true);
});

test("a header after a short preamble inside the window passes", () => {
  const preamble = Buffer.alloc(PDF_SIGNATURE_SEARCH_WINDOW - 5, 0x20);
  assert.equal(hasPdfSignature(Buffer.concat([preamble, Buffer.from("%PDF-")])), true);
  assert.equal(hasPdfSignature(Buffer.from(String.fromCharCode(0xfeff) + "%PDF-1.4\n")), true);
});

test("a header that starts past the window fails", () => {
  const preamble = Buffer.alloc(PDF_SIGNATURE_SEARCH_WINDOW - 4, 0x20);
  // Only "%PDF" fits in the window; the "-" falls outside it.
  assert.equal(hasPdfSignature(Buffer.concat([preamble, Buffer.from("%PDF-1.4")])), false);
});

test("saved web pages, error bodies, and empty files fail", () => {
  for (const text of [
    "<!DOCTYPE html><html><body>Sign in to continue</body></html>",
    '{"error":"Not authorized"}',
    "%PDF", // a prefix, not the header
    "",
  ]) {
    assert.equal(hasPdfSignature(Buffer.from(text)), false, JSON.stringify(text));
  }
});

test("a view into a larger buffer reads only its own bytes", () => {
  const backing = Buffer.from("%PDF-1.4 then <html>");
  assert.equal(hasPdfSignature(backing.subarray(14)), false);
  assert.equal(hasPdfSignature(new Uint8Array(backing.buffer, backing.byteOffset, 8)), true);
});

test("anything that is not bytes fails closed", () => {
  for (const value of [undefined, null, "%PDF-1.4", 42, {}]) {
    assert.equal(hasPdfSignature(value), false, String(value));
  }
});
