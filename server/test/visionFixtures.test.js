import assert from "node:assert/strict";
import test from "node:test";

import {
  MINIMUM_FIXTURE_EDGE_PIXELS,
  describePngFixture,
  loadVisionFixtureDataUri,
} from "../src/evals/visionFixtures.js";

// The exact blob that used to sit inline in answerQualityCases.js. A valid PNG
// by the letter of the format and still rejected by the provider, which is the
// whole reason this loader judges dimensions rather than trusting the signature.
const ONE_BY_ONE_PLACEHOLDER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

test("the committed dashboard fixture loads as a PNG data URI", () => {
  const uri = loadVisionFixtureDataUri("dashboard-cluster.png");

  assert.match(uri, /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
});

test("the committed dashboard fixture is a real image, not a placeholder", () => {
  const uri = loadVisionFixtureDataUri("dashboard-cluster.png");
  const bytes = Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64");
  const { width, height } = describePngFixture(bytes);

  assert.ok(
    width >= MINIMUM_FIXTURE_EDGE_PIXELS && height >= MINIMUM_FIXTURE_EDGE_PIXELS,
    `fixture is ${width}x${height}, below the ${MINIMUM_FIXTURE_EDGE_PIXELS}px floor`
  );
  // Guards the specific regression: a 1x1 fixture must never return here.
  assert.notDeepEqual({ width, height }, { width: 1, height: 1 });
});

test("the 1x1 placeholder that broke every live run is rejected", () => {
  assert.throws(
    () => describePngFixture(ONE_BY_ONE_PLACEHOLDER),
    /1x1 is a placeholder, not an image/
  );
});

test("a fixture below the edge floor is rejected as degenerate", () => {
  const tiny = Buffer.from(ONE_BY_ONE_PLACEHOLDER);
  tiny.writeUInt32BE(MINIMUM_FIXTURE_EDGE_PIXELS - 1, 16);
  tiny.writeUInt32BE(MINIMUM_FIXTURE_EDGE_PIXELS - 1, 20);

  assert.throws(() => describePngFixture(tiny), /is a placeholder, not an image/);
});

test("a fixture at the edge floor is accepted", () => {
  const atFloor = Buffer.from(ONE_BY_ONE_PLACEHOLDER);
  atFloor.writeUInt32BE(MINIMUM_FIXTURE_EDGE_PIXELS, 16);
  atFloor.writeUInt32BE(MINIMUM_FIXTURE_EDGE_PIXELS, 20);

  assert.deepEqual(describePngFixture(atFloor), {
    width: MINIMUM_FIXTURE_EDGE_PIXELS,
    height: MINIMUM_FIXTURE_EDGE_PIXELS,
  });
});

test("bytes that are not a PNG are rejected before they reach the provider", () => {
  assert.throws(() => describePngFixture(Buffer.alloc(4)), /too short to be a PNG/);
  assert.throws(
    () => describePngFixture(Buffer.alloc(64, 0x41)),
    /missing the PNG signature/
  );

  const badChunk = Buffer.from(ONE_BY_ONE_PLACEHOLDER);
  badChunk.write("IDAT", 12, "ascii");
  assert.throws(() => describePngFixture(badChunk), /first chunk is not IHDR/);
});

test("errors name the fixture so a fixture fault never reads as a product fault", () => {
  assert.throws(
    () => loadVisionFixtureDataUri("does-not-exist.png"),
    /does-not-exist\.png/
  );
  assert.throws(
    () => loadVisionFixtureDataUri("photo.jpg"),
    /only \.png is supported/
  );
});
