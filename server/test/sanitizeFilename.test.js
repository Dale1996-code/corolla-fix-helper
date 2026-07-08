// Unit tests for upload-filename handling.
//
// sanitizeFilename is a security boundary: every uploaded PDF's name flows
// through it before it becomes part of a stored path, so it must neutralize
// path traversal, directory separators, NUL/control bytes, and Windows
// reserved device names. These tests pin that behavior. A couple of assertions
// are deliberately written as PROPERTIES (no separator survives) rather than
// exact strings, because `node:path` splits on "\\" only on Windows — the
// security guarantee must hold on both Windows CI and POSIX CI.

import assert from "node:assert/strict";
import test from "node:test";
import {
  createStoredFilename,
  deriveTitleFromFilename,
  sanitizeFilename,
} from "../src/utils/sanitizeFilename.js";

const NUL = String.fromCharCode(0);
const UNIT_SEPARATOR = String.fromCharCode(31); // last control code in the stripped range

// --- sanitizeFilename: path traversal -------------------------------------

test("sanitizeFilename reduces a forward-slash traversal path to its final segment", () => {
  // "/" is a separator on both Windows and POSIX, so this collapse is stable.
  assert.equal(sanitizeFilename("../../etc/passwd.pdf"), "passwd.pdf");
  assert.equal(sanitizeFilename("/var/www/uploads/report.pdf"), "report.pdf");
});

test("sanitizeFilename strips backslash separators so no traversal survives", () => {
  // Windows path.basename splits on "\\"; POSIX does not, but the regex then
  // replaces the backslashes. Assert the guarantee, not a platform-specific string.
  for (const input of ["..\\..\\windows\\system32\\evil.pdf", "C:\\Users\\x\\secret.pdf"]) {
    const result = sanitizeFilename(input);
    assert.ok(!result.includes("\\"), `expected no backslash in ${JSON.stringify(result)}`);
    assert.ok(!result.includes("/"), `expected no forward slash in ${JSON.stringify(result)}`);
    assert.ok(result.endsWith(".pdf"));
  }
});

// --- sanitizeFilename: unsafe characters ----------------------------------

test("sanitizeFilename replaces filesystem-unsafe characters with dashes", () => {
  assert.equal(sanitizeFilename('a<b>c:d"e|f?g*h.pdf'), "a-b-c-d-e-f-g-h.pdf");
});

test("sanitizeFilename strips NUL and other ASCII control characters", () => {
  assert.equal(sanitizeFilename(`evil${NUL}name.pdf`), "evil-name.pdf");
  assert.equal(sanitizeFilename(`tab${UNIT_SEPARATOR}name.pdf`), "tab-name.pdf");
});

test("sanitizeFilename collapses whitespace runs to a single dash", () => {
  assert.equal(sanitizeFilename("my    spaced   report.pdf"), "my-spaced-report.pdf");
});

test("sanitizeFilename trims leading dashes, dots, and spaces from the base name", () => {
  assert.equal(sanitizeFilename("---hello.pdf"), "hello.pdf");
  assert.equal(sanitizeFilename("  . -leading.pdf"), "leading.pdf");
});

test("sanitizeFilename falls back to 'document' when nothing safe remains", () => {
  // A name made entirely of unsafe characters must not yield an empty base name.
  assert.equal(sanitizeFilename("<<<>>>.pdf"), "document.pdf");
  assert.equal(sanitizeFilename(""), "document");
  assert.equal(sanitizeFilename(undefined), "document");
});

// --- sanitizeFilename: Windows reserved device names ----------------------

test("sanitizeFilename defuses Windows reserved device names, case-insensitively", () => {
  assert.equal(sanitizeFilename("CON.pdf"), "CON-file.pdf");
  assert.equal(sanitizeFilename("con.pdf"), "con-file.pdf");
  assert.equal(sanitizeFilename("LPT9.pdf"), "LPT9-file.pdf");
  // A name that merely contains a reserved word is left alone.
  assert.equal(sanitizeFilename("CONTRACT.pdf"), "CONTRACT.pdf");
});

// --- sanitizeFilename: extension handling ---------------------------------

test("sanitizeFilename preserves an already-lower-case extension", () => {
  assert.equal(sanitizeFilename("report.pdf"), "report.pdf");
});

test("sanitizeFilename doubles an upper-case extension (known quirk, pinned)", () => {
  // KNOWN QUIRK — characterization, not an endorsement. The extension is
  // lower-cased into its own variable, but `path.basename` is asked to strip
  // the *lower-cased* suffix from the ORIGINAL (still upper-case) name, which it
  // cannot match case-sensitively. So the original extension is kept AND a
  // lower-cased copy is appended — for any upper-case extension, regardless of
  // base-name case. Harmless (still a safe ".pdf") but surprising; if this is
  // ever fixed, update these assertions deliberately.
  assert.equal(sanitizeFilename("report.PDF"), "report.PDF.pdf");
  assert.equal(sanitizeFilename("REPORT.PDF"), "REPORT.PDF.pdf");
});

// --- createStoredFilename --------------------------------------------------

test("createStoredFilename appends a timestamp + random suffix to a sanitized base", () => {
  const stored = createStoredFilename("my report.pdf");
  assert.match(stored, /^my-report-\d+-[a-z0-9]{6}\.pdf$/);
});

test("createStoredFilename sanitizes the base before adding the suffix", () => {
  const stored = createStoredFilename("../../etc/passwd.pdf");
  assert.ok(stored.startsWith("passwd-"));
  assert.ok(!stored.includes("/"));
  assert.ok(!stored.includes("\\"));
  assert.ok(stored.endsWith(".pdf"));
});

test("createStoredFilename yields a distinct name on each call", () => {
  const a = createStoredFilename("report.pdf");
  const b = createStoredFilename("report.pdf");
  assert.notEqual(a, b);
});

// --- deriveTitleFromFilename ----------------------------------------------

test("deriveTitleFromFilename turns separators into a spaced title", () => {
  assert.equal(deriveTitleFromFilename("engine_repair-guide.pdf"), "engine repair guide");
  assert.equal(deriveTitleFromFilename("  spaced   out .PDF"), "spaced out");
  assert.equal(deriveTitleFromFilename("Brake Job.pdf"), "Brake Job");
});

test("deriveTitleFromFilename falls back for empty and separator-only names", () => {
  // Empty input short-circuits to the "document" base name...
  assert.equal(deriveTitleFromFilename(""), "document");
  assert.equal(deriveTitleFromFilename(undefined), "document");
  // ...while a name that collapses to nothing after replacing separators uses
  // the explicit "Untitled Document" fallback.
  assert.equal(deriveTitleFromFilename("___.pdf"), "Untitled Document");
});
