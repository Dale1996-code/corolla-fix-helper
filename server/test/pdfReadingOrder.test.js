import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Reading-order regression guard.
//
// Milestone 4 briefly replaced pdfService's native pdf.js item order with a
// column-segmenting reorderer. A read-only dry run against the real corpus
// showed that this CORRUPTED tables: it grouped text into visual y-bands, which
// reads straight across multi-line table cells.
//
// The geometry below is copied from a real page in the corpus (document 1323,
// "Terminal and Connector Repair", page 1) -- a four-column parts table whose
// Part number and Notes cells wrap to two lines, with a vertically-centred
// Part name cell between them:
//
//   x=140 y=473  "09991-00500"          Part number, line 1
//   x=140 y=456  "09991-00510"          Part number, line 2
//   x=229 y=464  "SST"                  Part name, centred between the two
//   x=376 y=473  "To remove the 0.64"   Notes, line 1
//   x=376 y=456  "connector terminal"   Notes, line 2
//
// pdf.js emits these in reading order, so the plain join is CORRECT. A y-band
// regrouping merges y=473/464/456 into one row and produces
// "09991-00500 To remove the 0.64 SST 09991-00510 connector terminal", which
// silently associates a part number with the wrong description.
//
// The experiment was rejected. This test pins the native order so it cannot be
// reintroduced without failing.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-fix-helper-reading-order-"));
process.env.DATABASE_FILE = path.join(tempRoot, "reading-order.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");
// Keep the extractor on the plain text path; OCR is irrelevant here.
process.env.OCR_ENABLED = "false";

const { extractPdfData } = await import("../src/services/pdfService.js");

after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function escapePdfText(text) {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

/**
 * Build a one-page PDF whose text runs are placed at explicit coordinates, in a
 * given emission order. This is what lets the test reproduce real table
 * geometry rather than a single line of text.
 *
 * @param {Array<{ x: number, y: number, text: string }>} runs
 */
function createPositionedPdfBuffer(runs) {
  const commands = runs
    .map(
      (run) =>
        `BT\n/F1 10 Tf\n1 0 0 1 ${run.x} ${run.y} Tm\n(${escapePdfText(run.text)}) Tj\nET`
    )
    .join("\n");

  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Count 1 /Kids [3 0 R] >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${Buffer.byteLength(commands, "utf8")} >>\nstream\n${commands}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];

  const chunks = ["%PDF-1.4\n"];
  const offsets = [0];
  let offset = Buffer.byteLength(chunks[0], "utf8");

  for (const object of objects) {
    offsets.push(offset);
    chunks.push(object);
    offset += Buffer.byteLength(object, "utf8");
  }

  const xrefOffset = offset;
  chunks.push(`xref\n0 ${objects.length + 1}\n`);
  chunks.push("0000000000 65535 f \n");

  for (let objectId = 1; objectId <= objects.length; objectId += 1) {
    chunks.push(`${String(offsets[objectId]).padStart(10, "0")} 00000 n \n`);
  }

  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return Buffer.from(chunks.join(""), "utf8");
}

// Real geometry from document 1323, page 1.
const TABLE_ROW_RUNS = [
  { x: 140, y: 473, text: "09991-00500" },
  { x: 140, y: 456, text: "09991-00510" },
  { x: 229, y: 464, text: "SST" },
  { x: 376, y: 473, text: "To remove the 0.64" },
  { x: 376, y: 456, text: "connector terminal" },
];

test("a multi-line table row keeps its native, cell-wise reading order", async () => {
  const result = await extractPdfData(createPositionedPdfBuffer(TABLE_ROW_RUNS));

  assert.equal(
    result.extractedText.replace(/\s+/g, " ").trim(),
    "09991-00500 09991-00510 SST To remove the 0.64 connector terminal"
  );
});

test("the rejected y-band regrouping output must never reappear", async () => {
  const result = await extractPdfData(createPositionedPdfBuffer(TABLE_ROW_RUNS));
  const text = result.extractedText.replace(/\s+/g, " ").trim();

  // This is exactly what the column-segmenting experiment produced on the real
  // page. It associates part number 09991-00500 with the wrong note.
  assert.notEqual(
    text,
    "09991-00500 To remove the 0.64 SST 09991-00510 connector terminal"
  );

  // Stated as a property, not just an exact-string check: the two lines of a
  // single cell must stay adjacent.
  assert.match(text, /09991-00500 09991-00510/);
  assert.match(text, /To remove the 0\.64 connector terminal/);
});

test("page text is emitted in pdf.js item order for a simple two-block page", async () => {
  // A left block and a right block, emitted left-then-right by the producer.
  // Native order is preserved verbatim; nothing reorders by coordinate.
  const result = await extractPdfData(
    createPositionedPdfBuffer([
      { x: 50, y: 700, text: "Left block line one" },
      { x: 50, y: 686, text: "Left block line two" },
      { x: 330, y: 700, text: "Right block line one" },
      { x: 330, y: 686, text: "Right block line two" },
    ])
  );

  assert.equal(
    result.extractedText.replace(/\s+/g, " ").trim(),
    "Left block line one Left block line two Right block line one Right block line two"
  );
});

test("extraction still reports page-level data for the chunker", async () => {
  const result = await extractPdfData(createPositionedPdfBuffer(TABLE_ROW_RUNS));

  assert.equal(result.pageCount, 1);
  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0].pageNumber, 1);
  assert.match(result.pages[0].text, /09991-00500 09991-00510/);
});
