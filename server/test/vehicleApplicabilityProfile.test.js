import assert from "node:assert/strict";
import test from "node:test";

// Pure validation logic: no database, no network, no API key.
import {
  BUILD_PLANTS,
  EMPTY_APPLICABILITY_PROFILE,
  normalizeApplicabilityProfile,
  profileFromVehicleRow,
  profileToColumns,
} from "../src/services/vehicleApplicabilityProfile.js";

test("engine code is trimmed, upper-cased and hyphenated", () => {
  assert.equal(normalizeApplicabilityProfile({ engineCode: " 2zr fe " }).engineCode, "2ZR-FE");
  assert.equal(normalizeApplicabilityProfile({ engineCode: "2ZR- FE" }).engineCode, "2ZR-FE");
  assert.equal(normalizeApplicabilityProfile({ engineCode: "2az-fe" }).engineCode, "2AZ-FE");
});

test("empty, missing and 'unknown' values are null", () => {
  assert.deepEqual(normalizeApplicabilityProfile({}), EMPTY_APPLICABILITY_PROFILE);
  assert.deepEqual(
    normalizeApplicabilityProfile({
      engineCode: "",
      buildPlant: "",
      transmissionCode: "   ",
      hasVsc: "unknown",
      hasSmartKey: null,
    }),
    EMPTY_APPLICABILITY_PROFILE
  );
});

test("the empty profile is frozen so no caller can turn unknown into a value", () => {
  assert.ok(Object.isFrozen(EMPTY_APPLICABILITY_PROFILE));
  assert.deepEqual(BUILD_PLANTS, ["TMC", "NUMMI", "TMMC"]);
});

test("tri-state options accept booleans and yes/no", () => {
  const profile = normalizeApplicabilityProfile({ hasVsc: "yes", hasSmartKey: false });
  assert.equal(profile.hasVsc, true);
  assert.equal(profile.hasSmartKey, false);
  assert.equal(normalizeApplicabilityProfile({ hasVsc: "No" }).hasVsc, false);
  assert.equal(normalizeApplicabilityProfile({ hasSmartKey: true }).hasSmartKey, true);
});

test("build plant is upper-cased and checked against the known plants", () => {
  assert.equal(normalizeApplicabilityProfile({ buildPlant: "nummi" }).buildPlant, "NUMMI");
  assert.equal(normalizeApplicabilityProfile({ buildPlant: " TMC " }).buildPlant, "TMC");
});

test("transmission code normalizes", () => {
  assert.equal(normalizeApplicabilityProfile({ transmissionCode: " u341e " }).transmissionCode, "U341E");
  assert.equal(normalizeApplicabilityProfile({ transmissionCode: "C59" }).transmissionCode, "C59");
});

test("nonsense is refused with a sentence", () => {
  assert.throws(
    () => normalizeApplicabilityProfile({ engineCode: "1.8L" }),
    /Engine code must look like 2ZR-FE/
  );
  assert.throws(
    () => normalizeApplicabilityProfile({ buildPlant: "Fremont" }),
    /Build plant must be TMC, NUMMI, TMMC, or unknown/
  );
  assert.throws(
    () => normalizeApplicabilityProfile({ transmissionCode: "automatic" }),
    /Transmission code must look like U341E or C59/
  );
  assert.throws(
    () => normalizeApplicabilityProfile({ hasVsc: "maybe" }),
    /VSC must be yes, no, or unknown/
  );
  assert.throws(
    () => normalizeApplicabilityProfile({ hasSmartKey: 1 }),
    /Smart Key must be yes, no, or unknown/
  );
  assert.throws(() => normalizeApplicabilityProfile("2ZR-FE"), /Variant details must be an object/);
  assert.throws(() => normalizeApplicabilityProfile(null), /Variant details must be an object/);
  assert.throws(() => normalizeApplicabilityProfile(["2ZR-FE"]), /Variant details must be an object/);
});

test("row and column mapping round-trips", () => {
  const profile = {
    engineCode: "2ZR-FE",
    buildPlant: "NUMMI",
    transmissionCode: null,
    hasVsc: false,
    hasSmartKey: null,
  };

  assert.deepEqual(profileToColumns(profile), {
    engine_code: "2ZR-FE",
    build_plant: "NUMMI",
    transmission_code: null,
    has_vsc: 0,
    has_smart_key: null,
  });
  assert.deepEqual(profileFromVehicleRow(profileToColumns(profile)), profile);
  assert.deepEqual(profileFromVehicleRow({}), EMPTY_APPLICABILITY_PROFILE);
});

test("a row read before migration 006 has no columns and reads as unknown", () => {
  assert.deepEqual(
    profileFromVehicleRow({ id: 1, year: 2009, make: "Toyota", model: "Corolla", engine: "1.8L" }),
    EMPTY_APPLICABILITY_PROFILE
  );
});
