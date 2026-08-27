// Image fixtures for the Vision Ask eval cases.
//
// WHY THIS MODULE EXISTS
//   `vision-refuses-unsupported-spec` used to carry a 1x1 placeholder PNG inline.
//   Every live run died on a provider HTTP 400 -- "the image data you provided
//   does not represent a valid image" -- before the behavior under test ever ran.
//   That behavior is the not-found gate refusing a specification the retrieved
//   chunks do not support, with a photo attached. A case that is red for a
//   fixture reason teaches everyone to ignore red, so the fixture is now a real
//   committed image and this loader refuses to hand back a degenerate one.
//
// WHAT A VISION FIXTURE MAY CONTAIN
//   Nothing that could be read as a repair specification: no text, no digits, no
//   torque or capacity figures. The image is context for the question, never a
//   source -- repair facts must still come from cited PDF chunks. Keeping numbers
//   out of the picture is what makes a passing run meaningful: the refusal cannot
//   be explained away by there being nothing legible to launder.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The smallest header that can carry a signature plus a complete IHDR chunk.
const PNG_HEADER_BYTES = 33;

// A floor for "obviously degenerate", not a claim about the provider's real
// minimum (which is undocumented and can move). 1x1 is what actually broke; any
// image at that scale is a placeholder rather than a photo.
export const MINIMUM_FIXTURE_EDGE_PIXELS = 32;

/**
 * Validate PNG bytes and read the dimensions out of the IHDR header.
 *
 * Pure -- it takes bytes and touches no filesystem -- so the placeholder that
 * caused the original failure can be fed straight to it in a test.
 *
 * @param {Buffer} bytes raw file contents
 * @param {string} [label] name used in error messages
 * @returns {{ width: number, height: number }}
 */
export function describePngFixture(bytes, label = "vision fixture") {
  if (!Buffer.isBuffer(bytes) || bytes.length < PNG_HEADER_BYTES) {
    throw new Error(`${label}: too short to be a PNG`);
  }

  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`${label}: missing the PNG signature`);
  }

  // Bytes 8-11 are the IHDR length and 12-15 its type; width and height follow.
  if (bytes.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error(`${label}: first chunk is not IHDR`);
  }

  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);

  if (width < MINIMUM_FIXTURE_EDGE_PIXELS || height < MINIMUM_FIXTURE_EDGE_PIXELS) {
    throw new Error(
      `${label}: ${width}x${height} is a placeholder, not an image. A vision fixture must be ` +
        `at least ${MINIMUM_FIXTURE_EDGE_PIXELS}px on each edge -- a degenerate image is ` +
        `rejected by the provider before the behavior under test can run.`
    );
  }

  return { width, height };
}

/**
 * Read a committed image fixture and return it as the `data:` URI that
 * `askQuestionUsingDocuments({ image })` expects.
 *
 * Throws instead of returning a broken URI on purpose: a fixture problem has to
 * surface as a fixture problem, never as a failing product expectation.
 *
 * PNG only. Adding another format means adding a validator for it -- an
 * unvalidated fixture would reintroduce exactly the failure this module exists
 * to prevent.
 *
 * @param {string} filename file inside `server/src/evals/fixtures/`
 * @returns {string}
 */
export function loadVisionFixtureDataUri(filename) {
  if (!filename.toLowerCase().endsWith(".png")) {
    throw new Error(
      `vision fixture ${filename}: only .png is supported. Convert the image, or add a ` +
        `validator for the new format alongside describePngFixture().`
    );
  }

  const filePath = path.join(FIXTURE_DIR, filename);
  const bytes = fs.readFileSync(filePath);

  describePngFixture(bytes, `vision fixture ${filename}`);

  return `data:image/png;base64,${bytes.toString("base64")}`;
}
