// Single-vehicle workspace: every feature scopes its rows to "the" vehicle,
// which is always the first (and only) row in `vehicles`. This service owns
// that read so the "first row is the vehicle" assumption lives in one place —
// if multi-vehicle support ever lands, this is the read path to change.
//
// The one deliberate exception is `initDatabase.js`, whose seeding queries look
// for an existing vehicle in order to decide whether to CREATE one. That is a
// different question (does a row exist yet?) than "give me the vehicle," so it
// stays inline; a missing vehicle there is normal, not an error.

import { db } from "../database.js";

/**
 * Return the workspace's vehicle row (id + profile columns).
 *
 * Throws when no vehicle row exists yet (the database was not initialized
 * through `initDatabase.js`), so callers can rely on a valid record.
 */
export function getVehicle() {
  const vehicle = db
    .prepare(`
      SELECT
        id,
        year,
        make,
        model,
        trim,
        engine
      FROM vehicles
      ORDER BY id ASC
      LIMIT 1
    `)
    .get();

  if (!vehicle) {
    throw new Error("No vehicle record exists yet.");
  }

  return vehicle;
}

/** Return just the id of the workspace's vehicle. Throws when none exists. */
export function getVehicleId() {
  return getVehicle().id;
}
