import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import request from "supertest";

// The owner's vehicle variant details through the Settings API (N5 P0). The
// tests run in order and share one scratch database: each builds on the state
// the previous one saved, which is how the owner uses the page.

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "corolla-settings-profile-"));

process.env.DATABASE_FILE = path.join(tempRoot, "test.db");
process.env.UPLOADS_DIR = path.join(tempRoot, "uploads");

const { db } = await import("../src/database.js");
const { createApp } = await import("../src/app.js");

const app = createApp();

after(() => {
  if (typeof db.close === "function") {
    db.close();
  }

  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const UNKNOWN = {
  engineCode: null,
  buildPlant: null,
  transmissionCode: null,
  hasVsc: null,
  hasSmartKey: null,
};

test("GET /api/settings reports unknown variant details on a fresh install", async () => {
  const response = await request(app).get("/api/settings");

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.vehicle.applicability, UNKNOWN);
  assert.equal(response.body.vehicle.engine, "1.8L");
});

test("PUT saves normalized variant details and GET returns them", async () => {
  const expected = {
    engineCode: "2ZR-FE",
    buildPlant: "NUMMI",
    transmissionCode: "U341E",
    hasVsc: false,
    hasSmartKey: null,
  };

  const response = await request(app)
    .put("/api/settings/vehicle")
    .send({
      year: 2009,
      make: "Toyota",
      model: "Corolla",
      trim: "LE",
      engine: "1.8L",
      applicability: {
        engineCode: "2zr-fe",
        buildPlant: "NUMMI",
        transmissionCode: "u341e",
        hasVsc: false,
        hasSmartKey: null,
      },
    });

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body.vehicle.applicability, expected);
  assert.deepEqual((await request(app).get("/api/settings")).body.vehicle.applicability, expected);
});

test("PUT without applicability leaves saved variant details alone", async () => {
  const response = await request(app)
    .put("/api/settings/vehicle")
    .send({ year: 2009, make: "Toyota", model: "Corolla" });

  assert.equal(response.status, 200, JSON.stringify(response.body));
  const saved = (await request(app).get("/api/settings")).body.vehicle.applicability;
  assert.equal(saved.engineCode, "2ZR-FE");
  assert.equal(saved.buildPlant, "NUMMI");
});

test("PUT with applicability replaces all five: a field left out becomes unknown", async () => {
  const response = await request(app)
    .put("/api/settings/vehicle")
    .send({ year: 2009, make: "Toyota", model: "Corolla", applicability: { buildPlant: "NUMMI" } });

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body.vehicle.applicability, { ...UNKNOWN, buildPlant: "NUMMI" });
});

test("PUT with an invalid plant is a 400 and writes nothing", async () => {
  const response = await request(app)
    .put("/api/settings/vehicle")
    .send({
      year: 2011,
      make: "Toyota",
      model: "Corolla",
      applicability: { buildPlant: "Fremont" },
    });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /Build plant must be TMC, NUMMI, TMMC, or unknown/);

  const after = (await request(app).get("/api/settings")).body.vehicle;
  assert.equal(after.year, 2009, "the year must not change when the details are refused");
  assert.equal(after.applicability.buildPlant, "NUMMI");
});

test("PUT with an engine size in the engine-code field is a 400 with a sentence", async () => {
  const response = await request(app)
    .put("/api/settings/vehicle")
    .send({ year: 2009, make: "Toyota", model: "Corolla", applicability: { engineCode: "1.8L" } });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /Engine code must look like 2ZR-FE/);
});
