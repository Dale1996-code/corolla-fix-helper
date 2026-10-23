# N5 P0 + P1 — Owner Vehicle Profile and Applicability Tagger: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record the owner's vehicle variant details (P0), and build the deterministic, read-only
tagger that says which engine or plant each passage of the manuals is scoped to (P1). P1 is proven on
the real corpus without changing anything Ask or the planner does.

**Architecture:**
- **P0** adds five nullable columns to the single `vehicles` row through migration
  `006_vehicle_applicability_profile`, validates them in a new leaf module, and exposes them through
  `GET`/`PUT /api/settings` and the Settings page.
- **P1** adds two leaf modules, `chunkGeometry.js` and `applicabilityScope.js`. They import no
  database and no model. Two read-only scripts use them: a corpus report, and a blind check against a
  hand-labeled sample. Retrieval, verification and the planner are untouched until P2–P4.

**Tech Stack:** Node 24 (`node:sqlite`, `node:test`), Express, React 19 + Vitest, plain JS with JSDoc
types under `checkJs`. No new dependencies.

**Spec:** [`docs/n5-applicability-design.md`](n5-applicability-design.md) — §6 architecture, §7 phases,
§8 tests, §9 decisions. Read it before starting.

**Delivery:**
- P0 = Tasks 1–4, one branch, one PR.
- P1 = Tasks 5–10 on a branch cut from P0. P1 needs only Task 1's type.
- Task 11 is the gate for each PR.

## Global Constraints

- Node `>=24 <25`; no new npm dependencies.
- **Leaf modules** (`vehicleApplicabilityProfile.js`, `chunkGeometry.js`, `applicabilityScope.js`)
  import nothing at runtime except other leaf modules. A JSDoc `import("…")` type reference is allowed.
- **Migrations:**
  - The new migration is named exactly `006_vehicle_applicability_profile`.
  - Never edit 001–005.
  - If another branch has landed a `006_*` first, rename this one to the next free number at rebase time.
- **No seeding.** The profile columns start `NULL`. Only the owner sets them, in Settings (decision 1).
- **Unknown is never compatible.** A `NULL` profile value gives `unresolved` for a scoped axis, never
  `applies`.
- **The account header is never a marker:** `/Corolla\s+L4[-\s]?1\.8L\s*\(\s*2ZR-FE\s*\)/`, with any
  whitespace.
- **Public repo:**
  - Committed tests and fixtures use short synthetic manual-style strings, never real manual text.
  - Real labels and candidates live only under the gitignored `server/data/applicability-labels/`.
- **Scripts are read-only:**
  - They open the database with `new DatabaseSync(path, { readOnly: true })`.
  - They write only to `server/data/diagnostics/` or `server/data/applicability-labels/`.
  - Run them against a `VACUUM INTO` snapshot passed as `DATABASE_FILE`, never the live database.
- **No OpenAI calls** anywhere in P0/P1. Tests need no key; `config.js` already ignores `.env` under
  `node --test` (#154).
- **Visible copy** follows CLAUDE.md:
  - "details", "saved", "Unknown".
  - Never "confirmed", "verified for your car", or "matches your car".
- **Gates** run in a worktree, never the main checkout. Run smoke from a path without `.claude` in it.
- **Commits:**
  - Commit locally, one per task.
  - Push, PR, and `@coderabbitai` each need the owner's explicit OK.
  - `docs/n5-applicability-design.md` and this plan are uncommitted. Add them in Task 1's commit only
    with the owner's OK.

## Decisions this plan assumes

The owner approved the design. The §9 answers did not come through, so the recommended defaults are
used where a task depends on one:
- **#5:** new columns on `vehicles` (Task 2).
- **#7:** the agent labels the sample blind, and the owner skims at most 20 of the hardest rows (Task 10).
- **#9:** the engine axis is classified by default; plant markers are detected and reported but not
  enforced (Tasks 6–9).
- **#2, #3, #4, #6, #8:** these apply to P3/P4 and change nothing here.
- **#1:** the values are entered by the owner after Task 4 and are not needed to build anything.

## Review Focus

1. **OCR-mangled engine codes** ("2AZ- FE", "2ZRFE", "2ZA-FE" — all seen in the corpus) must become a
   known engine or `unknown_code`, which is unresolved, and never an owner `applies`. Pinned in Task 6.
2. **The account header with odd whitespace** (double spaces, a space inside the parentheses, split
   across chunk 0's word wrap) must still be blanked. Pinned in Task 6.
3. **Owner left the engine code blank:** every engine-scoped figure is `unresolved`. The report refuses
   with one clear sentence unless `--engine` is passed, rather than guessing. Nothing crashes. Pinned
   in Task 8 and Task 9.
4. **Settings input** in lowercase or with a space ("2zr fe", " u341e ") is normalized; nonsense
   ("1.8L" as an engine code, "Fremont" as a plant) gets a clear 400 and writes nothing. Pinned in
   Task 1 and Task 3.
5. **Documents with zero chunks or empty pages** (13 in the real library) appear in the report as class
   `none` and never throw. Pinned in Task 9.

---

## File Map

| File | Status | Responsibility |
| --- | --- | --- |
| `server/src/services/vehicleApplicabilityProfile.js` | Create (leaf) | Profile type, validation, row/column mapping |
| `server/src/initDatabase.js` | Modify | Migration 006 |
| `server/src/services/vehicleService.js` | Modify | `getVehicle()` selects the five columns |
| `server/src/routes/settings.js` | Modify (`mapVehicleRow` :54, `PUT /vehicle` :375) | Read and write `vehicle.applicability` |
| `client/src/pages/SettingsPage.jsx` | Modify | "Variant details" fields |
| `server/src/services/chunkGeometry.js` | Create (leaf) | Chunk window constants, word normalization, page reconstruction |
| `server/src/services/documentChunkService.js` | Modify (:9–23) | Import the constants (no behavior change) |
| `server/src/services/applicabilityScope.js` | Create (leaf) | Markers → segments → entry scopes → verdict |
| `server/src/scripts/diagnoseApplicability.js` | Create | Read-only corpus report |
| `server/src/scripts/checkApplicabilityLabels.js` | Create | Blind label sampling and scoring |
| `package.json`, `server/package.json`, `.gitignore`, `CLAUDE.md`, `DATA_MODEL.md`, `docs/api.md`, `docs/evals/ask-rag-iteration-log.md` | Modify | Scripts, ignore rule, docs |

---

## P0 — Owner vehicle profile

### Task 1: Profile validator

**Files:**
- Create: `server/src/services/vehicleApplicabilityProfile.js`
- Test: `server/test/vehicleApplicabilityProfile.test.js`

**Interfaces — Produces:**
- `@typedef {{ engineCode: string|null, buildPlant: "TMC"|"NUMMI"|"TMMC"|null, transmissionCode: string|null, hasVsc: boolean|null, hasSmartKey: boolean|null }} ApplicabilityProfile`
- `BUILD_PLANTS = ["TMC", "NUMMI", "TMMC"]`
- `EMPTY_APPLICABILITY_PROFILE` (all five `null`, frozen)
- `normalizeApplicabilityProfile(input: unknown): ApplicabilityProfile` — throws `Error` with a user-facing message
- `profileFromVehicleRow(row: { engine_code?, build_plant?, transmission_code?, has_vsc?, has_smart_key? }): ApplicabilityProfile` — `1`→`true`, `0`→`false`, `NULL`→`null`
- `profileToColumns(p: ApplicabilityProfile): { engine_code, build_plant, transmission_code, has_vsc, has_smart_key }` — `true`→`1`, `false`→`0`

- [ ] **Step 1: Write the failing tests** (`node:test`; pure module, no DB setup)

```js
test("engine code is trimmed, upper-cased and hyphenated", () => {
  assert.equal(normalizeApplicabilityProfile({ engineCode: " 2zr fe " }).engineCode, "2ZR-FE");
  assert.equal(normalizeApplicabilityProfile({ engineCode: "2ZR- FE" }).engineCode, "2ZR-FE");
});
test("empty, missing and 'unknown' values are null", () => {
  assert.deepEqual(normalizeApplicabilityProfile({}), EMPTY_APPLICABILITY_PROFILE);
  assert.deepEqual(
    normalizeApplicabilityProfile({ engineCode: "", buildPlant: "", hasVsc: "unknown", hasSmartKey: null }),
    EMPTY_APPLICABILITY_PROFILE
  );
});
test("tri-state options accept booleans and yes/no", () => {
  const p = normalizeApplicabilityProfile({ hasVsc: "yes", hasSmartKey: false });
  assert.equal(p.hasVsc, true);
  assert.equal(p.hasSmartKey, false);
});
test("transmission code normalizes", () => {
  assert.equal(normalizeApplicabilityProfile({ transmissionCode: " u341e " }).transmissionCode, "U341E");
  assert.equal(normalizeApplicabilityProfile({ transmissionCode: "C59" }).transmissionCode, "C59");
});
test("nonsense is refused with a sentence", () => {
  assert.throws(() => normalizeApplicabilityProfile({ engineCode: "1.8L" }), /Engine code must look like 2ZR-FE/);
  assert.throws(() => normalizeApplicabilityProfile({ buildPlant: "Fremont" }), /Build plant must be TMC, NUMMI, TMMC, or unknown/);
  assert.throws(() => normalizeApplicabilityProfile({ transmissionCode: "automatic" }), /Transmission code must look like U341E or C59/);
  assert.throws(() => normalizeApplicabilityProfile({ hasVsc: "maybe" }), /VSC must be yes, no, or unknown/);
  assert.throws(() => normalizeApplicabilityProfile("2ZR-FE"), /Variant details must be an object/);
});
test("row and column mapping round-trips", () => {
  const p = { engineCode: "2ZR-FE", buildPlant: "NUMMI", transmissionCode: null, hasVsc: false, hasSmartKey: null };
  assert.deepEqual(profileFromVehicleRow(profileToColumns(p)), p);
  assert.deepEqual(profileFromVehicleRow({}), EMPTY_APPLICABILITY_PROFILE);
});
```

- [ ] **Step 2: Run, expect FAIL** — `cd server && node --test test/vehicleApplicabilityProfile.test.js` → module not found.
- [ ] **Step 3: Implement**
  - Engine code: uppercase, collapse `\s*-\s*|\s+` between the parts, then require `^[1-9][A-Z]{2}-[A-Z]{2,3}$`.
  - Transmission: require `^[A-Z]\d{2,3}[A-Z]?$`.
  - Plant: membership in `BUILD_PLANTS`.
  - Tri-states: `true`/`"yes"` → `true`, `false`/`"no"` → `false`, and `null`/`undefined`/`""`/`"unknown"` → `null`.
  - The Smart Key message reads "Smart Key must be yes, no, or unknown."
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `feat(n5): vehicle applicability profile validator (P0)`

### Task 2: Migration 006 and `getVehicle()`

**Files:**
- Modify: `server/src/initDatabase.js` (new function before `seedVehicle()` :522; register after line 793)
- Modify: `server/src/services/vehicleService.js` (`getVehicle()` SELECT)
- Modify: `DATA_MODEL.md` (`vehicles` section :23, migration list near :445)
- Test: `server/test/initDatabaseMigration.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: the `vehicles` columns `engine_code TEXT`, `build_plant TEXT`, `transmission_code TEXT`,
  `has_vsc INTEGER`, `has_smart_key INTEGER`. `getVehicle()` returns them as snake_case raw values.

- [ ] **Step 1: Write the failing test** in `initDatabaseMigration.test.js`

```js
test("migration 006 adds the variant details as unknown and leaves the vehicle alone", () => {
  initializeDatabase();
  const row = db.prepare("SELECT * FROM vehicles ORDER BY id LIMIT 1").get();
  for (const col of ["engine_code", "build_plant", "transmission_code", "has_vsc", "has_smart_key"]) {
    assert.ok(col in row, `${col} missing`);
    assert.equal(row[col], null);
  }
  assert.equal(row.engine, "1.8L");
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE name = '006_vehicle_applicability_profile'").get());
  assert.doesNotThrow(() => initializeDatabase()); // idempotent
  assert.throws(() => db.prepare("UPDATE vehicles SET build_plant = 'XYZ'").run(), /CHECK constraint failed/);
  assert.throws(() => db.prepare("UPDATE vehicles SET has_vsc = 2").run(), /CHECK constraint failed/);
});
```

- [ ] **Step 2: Run, expect FAIL** — `cd server && node --test test/initDatabaseMigration.test.js`.
- [ ] **Step 3: Implement `addVehicleApplicabilityProfile()`**
  - Use the existing `ensureColumn` with these definitions:
    - `engine_code TEXT`
    - `build_plant TEXT CHECK (build_plant IS NULL OR build_plant IN ('TMC','NUMMI','TMMC'))`
    - `transmission_code TEXT`
    - `has_vsc INTEGER CHECK (has_vsc IS NULL OR has_vsc IN (0,1))`
    - `has_smart_key INTEGER CHECK (has_smart_key IS NULL OR has_smart_key IN (0,1))`
  - Register `runMigration("006_vehicle_applicability_profile", addVehicleApplicabilityProfile)`.
  - Add the five columns to `getVehicle()`'s SELECT.
  - Write a one-paragraph comment above the function: why the values are nullable and never seeded,
    with a pointer to the design doc §6.1.
- [ ] **Step 4: Run, expect PASS**; also run `node --test test/initDatabase.test.js`.
- [ ] **Step 5: Docs** — document the five columns and `006` in `DATA_MODEL.md`, in the same tone as
  the `004` entry: additive, nullable, and why there is no seeding.
- [ ] **Step 6: Commit** — `feat(n5): migration 006 adds vehicle variant details (P0)`

### Task 3: Settings API

**Files:**
- Modify: `server/src/routes/settings.js` (`mapVehicleRow` :54, `PUT /vehicle` :375)
- Modify: `docs/api.md` (GET example :835, PUT section :873)
- Test: create `server/test/settingsVehicleProfile.test.js`. Copy the temp-`DATABASE_FILE` /
  `UPLOADS_DIR` + `createApp` + supertest setup from `server/test/settingsAiStatus.test.js`.

**Interfaces:**
- Consumes: Task 1 (`normalizeApplicabilityProfile`, `profileFromVehicleRow`, `profileToColumns`) and Task 2's columns.
- Produces: `vehicle.applicability: ApplicabilityProfile` on `GET /api/settings` and on the
  `PUT /api/settings/vehicle` response. **`PUT` semantics:**
  - When the body has an `applicability` key, all five values are replaced; a field missing from the
    object becomes `null`.
  - When it has no `applicability` key, the five columns are left untouched.

- [ ] **Step 1: Write the failing tests**

```js
test("GET /api/settings reports unknown variant details on a fresh install", async () => {
  const res = await request(app).get("/api/settings");
  assert.deepEqual(res.body.vehicle.applicability, {
    engineCode: null, buildPlant: null, transmissionCode: null, hasVsc: null, hasSmartKey: null,
  });
});
test("PUT saves normalized variant details and GET returns them", async () => {
  const res = await request(app).put("/api/settings/vehicle").send({
    year: 2009, make: "Toyota", model: "Corolla", trim: "LE", engine: "1.8L",
    applicability: { engineCode: "2zr-fe", buildPlant: "NUMMI", transmissionCode: "u341e", hasVsc: false, hasSmartKey: null },
  });
  const expected = { engineCode: "2ZR-FE", buildPlant: "NUMMI", transmissionCode: "U341E", hasVsc: false, hasSmartKey: null };
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.vehicle.applicability, expected);
  assert.deepEqual((await request(app).get("/api/settings")).body.vehicle.applicability, expected);
});
test("PUT without applicability leaves saved variant details alone", async () => {
  // after the previous test
  await request(app).put("/api/settings/vehicle").send({ year: 2009, make: "Toyota", model: "Corolla" });
  assert.equal((await request(app).get("/api/settings")).body.vehicle.applicability.buildPlant, "NUMMI");
});
test("PUT with an invalid plant is a 400 and writes nothing", async () => {
  const res = await request(app).put("/api/settings/vehicle").send({
    year: 2011, make: "Toyota", model: "Corolla", applicability: { buildPlant: "Fremont" },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Build plant must be TMC, NUMMI, TMMC, or unknown/);
  const after = (await request(app).get("/api/settings")).body.vehicle;
  assert.equal(after.year, 2009);
  assert.equal(after.applicability.buildPlant, "NUMMI");
});
```

- [ ] **Step 2: Run, expect FAIL** — `cd server && node --test test/settingsVehicleProfile.test.js`.
- [ ] **Step 3: Implement**
  - `mapVehicleRow` adds `applicability: profileFromVehicleRow(row)`.
  - In `PUT /vehicle`, call `normalizeApplicabilityProfile(request.body.applicability)` *before* the
    `UPDATE`, only when `"applicability" in request.body`.
  - Then run one `UPDATE` that sets the five columns from `profileToColumns` alongside the existing ones.
  - The existing `catch` already turns a thrown message into a 400.
- [ ] **Step 4: Run, expect PASS**; also run `node --test test/app.test.js test/requestGuard.test.js`.
- [ ] **Step 5: Docs** — `docs/api.md` GET example and PUT section, covering the `applicability` object,
  the replace-all-or-leave-alone rule, and the four error sentences.
- [ ] **Step 6: Commit** — `feat(n5): settings API reads and writes vehicle variant details (P0)`

### Task 4: Settings page fields

**Files:**
- Modify: `client/src/pages/SettingsPage.jsx` (`emptyVehicleForm` :7, load mapping ~:367, save
  mapping ~:450, fields after the Engine field ~:591)
- Test: `client/src/pages/SettingsAndSymptoms.test.jsx`

**Interfaces:**
- Consumes: Task 3's `vehicle.applicability`.
- Produces: the `PUT` body always includes `applicability`.

**Fixed copy:**
- Subheading **"Variant details"**.
- Help text: "The manuals print some specifications per engine, build plant, or option. These details
  let the app tell which ones are yours. Leave anything you're not sure of as Unknown — unknown is
  treated as unconfirmed, never as a match."
- Fields:

| Field | Control | Values |
| --- | --- | --- |
| Engine code | `TextField`, placeholder `2ZR-FE` | free text |
| Build plant | `SelectField`, `emptyOption="Unknown"` | `TMC` "Japan (TMC)", `NUMMI` "USA (NUMMI)", `TMMC` "Canada (TMMC)" |
| Transmission code | `TextField`, placeholder `U341E or C59` | free text |
| VSC (stability control) | `SelectField`, `emptyOption="Unknown"` | `yes` "Yes", `no` "No" |
| Smart Key | `SelectField`, `emptyOption="Unknown"` | `yes` "Yes", `no` "No" |

**Mapping:**
- Form state holds strings.
- Load maps `true`→`"yes"`, `false`→`"no"`, and `null`/missing→`""`.
- Save maps `""`→`null`, `"yes"`→`true`, and `"no"`→`false`.
- Text fields send their trimmed value, or `null` when empty.

- [ ] **Step 1: Write the failing tests**
  - (a) Loading `applicability: { engineCode: "2ZR-FE", buildPlant: null, transmissionCode: null, hasVsc: true, hasSmartKey: null }`
    shows these field values:

    | Field | Shows |
    | --- | --- |
    | Engine code | "2ZR-FE" |
    | Build plant | "" (Unknown) |
    | VSC | "yes" |

  - Choosing Build plant "USA (NUMMI)" and pressing **Save vehicle profile** sends a PUT body with
    `applicability` deep-equal to
    `{ engineCode: "2ZR-FE", buildPlant: "NUMMI", transmissionCode: null, hasVsc: true, hasSmartKey: null }`.
  - (b) A settings payload with no `applicability` key renders every variant field as Unknown or empty,
    without throwing.
- [ ] **Step 2: Run, expect FAIL** — `cd client && npx vitest run src/pages/SettingsAndSymptoms.test.jsx`.
- [ ] **Step 3: Implement** the fields and mapping above.
- [ ] **Step 4: Run, expect PASS**; also `npx vitest run src/pages/SettingsPage.test.jsx`.
- [ ] **Step 5: Commit** — `feat(n5): Settings page variant details (P0)`

---

## P1 — Applicability tagger (read-only)

### Task 5: Chunk geometry leaf

**Files:**
- Create: `server/src/services/chunkGeometry.js`
- Modify: `server/src/services/documentChunkService.js` (:9–23: import the constants and
  `normalizeChunkWords`, delete the local copies)
- Test: `server/test/chunkGeometry.test.js`. It needs the temp-DB setup, because it also imports
  `documentChunkService.js`.

**Interfaces — Produces:**
- `CHUNK_WORD_SIZE = 200`, `CHUNK_WORD_OVERLAP = 40`, `CHUNK_WORD_STEP = 160`
- `normalizeChunkWords(text: unknown): string[]` (the body moved unchanged from `normalizeWords`)
- `reconstructPageWords(chunkTexts: string[]): string[]` — chunk 0's words, then each later chunk's words from index `CHUNK_WORD_OVERLAP`
- `chunkStartWordIndex(chunkIndex: number): number` → `chunkIndex * CHUNK_WORD_STEP`

- [ ] **Step 1: Write the failing tests**
  - For a 470-word synthetic text `w1 … w470`, take `chunks = chunkPageText(text)`. Then:
    - `reconstructPageWords(chunks).join(" ") === normalizeChunkWords(text).join(" ")`
    - chunk `i` starts with word `chunkStartWordIndex(i) + 1`
    - `chunks.length === 3`
  - A one-word page reconstructs to itself.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the module, and switch `documentChunkService.js` over to it.
- [ ] **Step 4: Run, expect PASS**; also `node --test test/documentChunkAtomicRebuild.test.js` and
  every other suite that imports `documentChunkService.js` (find them with grep), all unchanged.
- [ ] **Step 5: Commit** — `refactor(n5): chunk geometry leaf shared with the tagger (P1)`

### Task 6: Scope markers

**Files:**
- Create: `server/src/services/applicabilityScope.js`
- Test: `server/test/applicabilityScope.test.js`

**Interfaces — Produces:**
- `APPLICABILITY_SCOPE_VERSION = "scope-v1"`
- `KNOWN_ENGINE_CODES = ["2ZR-FE", "2AZ-FE", "1NZ-FE", "1NR-FE", "1AR-FE", "2AR-FE", "1UR-FE", "3UR-FE"]` (measured in the corpus)
- `PLANT_VALUES = ["TMC", "NUMMI", "TMMC", "TMMT"]` (TMMT is real in the corpus and is never an owner plant)
- `blankAccountHeader(text: string): string` — same length, header characters replaced by spaces, so offsets survive
- `@typedef {"article_title"|"diagram_title"|"inline_for"|"row_label"|"link"|"legend"|"column_header"|"unknown_code"} MarkerKind`
- `@typedef {{ axis: "engine"|"plant", kind: MarkerKind, value: string|null, exclude: boolean, start: number, end: number }} ScopeMarker` — `value` is `null` for `legend`, `column_header` and `unknown_code`
- `findScopeMarkers(text: string): ScopeMarker[]` — sorted by `start`; header already blanked internally

**Detection rules** (pinned; first match wins per occurrence):

- **Engine token:** `/\b([1-9][A-Z]{2})\s?-?\s?(FE|FXE|FAE|FSE|FKS|GE|GZE)\b/`, normalized to `XXX-YY`.
  A token not in `KNOWN_ENGINE_CODES` is kind `unknown_code`.
- **Plant token:**
  - `/\b(?:for\s+)?(TMC|TMMT|NUMMI|TMMC)\s+Made\b/i` → `{ value, exclude: false }`.
  - `/\bExcept\s+TMC\s+Made\b/i` → `{ value: "TMC", exclude: true }`.
  - In filenames and titles the underscore form `TMC_Made` counts too.

**Engine marker kinds:**

| Kind | When |
| --- | --- |
| `article_title` | The token is inside the article span. The span starts at `/\bVehicle\s*>/` and ends at the first `Locations:`, ` NOTICE`, ` CAUTION`, ` HINT`, or 250 characters, whichever comes first. The token must also be parenthesized, `(2AZ-FE)`. |
| `diagram_title` | The token is inside a `<…>` group of at most 80 characters, such as `<2AZ-FE , Except TMC Made>`. |
| `inline_for` | `/\(\s*for\s+TOKEN\s*\)/i` |
| `legend` | Preceded by `/\*\s*\d+\s*:\s*$/` |
| `link` | Followed by `/^\s*\[/`, or inside a `[ … ]` group |
| `column_header` | Two different engine tokens separated by at most 3 characters containing no digit. Both are marked. |
| `row_label` | Anything else |

**Plant marker kinds:** the same contexts. A plant token inside `<…>` is `diagram_title`, one inside
parentheses is `inline_for`, and anything else is `row_label`.

- [ ] **Step 1: Write the failing tests** — one per rule, asserting the exact `{axis, kind, value, exclude}`
  list, on synthetic strings such as:
  - `"2009 Toyota Corolla L4-1.8L (2ZR-FE) Vehicle > Locations > Position Of Parts (2AZ-FE) Locations: …"`
    → exactly one marker, `engine/article_title/2AZ-FE`. The header yields none.
  - `"COMPRESSOR (for 2AZ-FE) Bolt x Engine 25 N*m COMPRESSOR (for 2ZR-FE) Bolt x Engine 25 N*m"`
    → `inline_for` 2AZ-FE, then `inline_for` 2ZR-FE.
  - `"Engine Control <2AZ-FE , Except TMC Made> (IG)"`
    → `engine/diagram_title/2AZ-FE` plus `plant/diagram_title/TMC/exclude:true`.
  - `"See Procedure 2ZR-FE [ 2ZR-FE ENGINE MECHANICAL: DRIVE BELT+ ]"` → only `link` markers.
  - `"* 2: 2AZ-FE * 3: 2ZR-FE"` → two `legend` markers.
  - `"Item 2ZR-FE 2AZ-FE Height 92 96"` → two `column_header` markers.
  - `"for TMC Made 2ZR-FE 92 mm except TMC Made 2ZR-FE 92 mm 2AZ-FE 96 mm"`
    → plant/engine `row_label` markers in that order.
  - **Review Focus 1:**
    - `"(for 2AZ- FE)"` → `inline_for` 2AZ-FE.
    - `"2ZRFE"` → `row_label` 2ZR-FE.
    - `"(for 2ZA-FE)"` → `unknown_code`.
    - `"2ND-GEAR 4WD-FOUR"` → no markers.
  - **Review Focus 2:**
    - `blankAccountHeader("Corolla  L4-1.8L ( 2ZR-FE ) x")` keeps its length and contains no "2ZR".
    - The same header with a nonbreaking space (U+00A0, built with `String.fromCharCode(0xa0)` so the
      edit tool cannot mangle it) is blanked too.
- [ ] **Step 2: Run, expect FAIL** — `cd server && node --test test/applicabilityScope.test.js`.
- [ ] **Step 3: Implement `blankAccountHeader` and `findScopeMarkers`.** Detect all tokens first, then
  classify each by its context.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `feat(n5): applicability scope markers (P1)`

### Task 7: Segments and entry scopes

**Files:**
- Modify: `server/src/services/applicabilityScope.js`
- Test: `server/test/applicabilityScope.test.js`

**Interfaces:**
- Consumes: Task 5 (`normalizeChunkWords`, `chunkStartWordIndex`) and Task 6.
- Produces:
  - `@typedef {null | { value: string, exclude: boolean, kind: MarkerKind } | { unresolved: true, kind: MarkerKind }} AxisScope`
  - `@typedef {{ engine: AxisScope, plant: AxisScope }} Scope`; `EMPTY_SCOPE = { engine: null, plant: null }`
  - `resolveSegments(text: string, options?: { carryIn?: Scope }): { segments: Array<{ start: number, end: number, scope: Scope }>, carryOut: Scope }`
  - `scopeAt(segments, offset: number): Scope`
  - `computeDocumentScopes(pages: Array<{ pageNumber: number, text: string }>): Array<{ pageNumber: number, text: string, segments: Array<{ start: number, end: number, scope: Scope }>, chunks: Array<{ chunkIndex: number, entryScope: Scope, ownMarkers: ScopeMarker[] }> }>`
    — each page's `text` is normalized with `normalizeChunkWords(...).join(" ")`, so word offsets match the stored chunks.

**Extent rules** (pinned):

| Kind | Scope lasts until | Crosses to the next page? |
| --- | --- | --- |
| `article_title` | The next article span | Yes |
| `diagram_title` | The next `diagram_title` or article span | Yes |
| `inline_for` / `row_label` | The next `inline_for`/`row_label`/`diagram_title`/`article_title` on the same axis, a numbered-step boundary `/(?:^|\s)\d{1,3}\.\s+[A-Z]{2,}/`, or page end | No |
| `legend` / `column_header` / `unknown_code` | Unresolved from the marker to page end | No |
| `link` | Never opens a segment | — |

- **Precedence at an offset:** unresolved > `inline_for`/`row_label` > `diagram_title` > `article_title`
  > carried-in > `null`.
- **`carryOut`** keeps only the article and diagram parts of the scope.
- **`entryScope` of chunk *i*** is the scope at the character offset of word `chunkStartWordIndex(i)`.

- [ ] **Step 1: Write the failing tests** (synthetic):
  - Inline 2AZ scope ends at `(for 2ZR-FE)`. A figure after the first marker is 2AZ-FE; one after the
    second is 2ZR-FE.
  - A numbered step `"6. INSTALL"` ends an inline scope; the figure after it has `engine: null`.
  - An inline scope does not reach page 2, but an article scope does. Page 2 of an article titled
    `(2AZ-FE)` with no markers has entry scope `engine/2AZ-FE/article_title`.
  - A legend or column header makes the rest of the page `{ unresolved: true }`, and page 2 does not
    inherit it.
  - A 450-word page with `(for 2AZ-FE)` at word 10 and no other markers: chunk 2's `entryScope.engine.value === "2AZ-FE"`.
  - A page holding only the account header: every chunk's `entryScope` deep-equals `EMPTY_SCOPE`.
  - Empty `pages` and a page with `text: ""` return without throwing.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** One left-to-right sweep over the sorted markers, keeping one open scope per
  precedence level.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `feat(n5): applicability segments and chunk entry scopes (P1)`

### Task 8: Classify a scope against the profile

**Files:**
- Modify: `server/src/services/applicabilityScope.js`
- Test: `server/test/applicabilityScope.test.js`

**Interfaces:**
- Consumes: Task 1's `ApplicabilityProfile` (type only) and Task 7's `Scope`.
- Produces:
  - `@typedef {"applies"|"other_variant"|"unresolved"|"not_stated"} ApplicabilityVerdict`
  - `classifyScope(scope: Scope, profile: ApplicabilityProfile, options?: { axes?: Array<"engine"|"plant"> }): { verdict: ApplicabilityVerdict, byAxis: Partial<Record<"engine"|"plant", ApplicabilityVerdict>> }`
  - Default `axes: ["engine"]` (decision #9). `engine` reads `profile.engineCode`; `plant` reads `profile.buildPlant`.

**Rules per axis:**

| Axis scope | Owner value | Verdict |
| --- | --- | --- |
| `null` | — | `not_stated` |
| unresolved | — | `unresolved` |
| scoped | owner value `null` | `unresolved` |
| `exclude: true` | owner value equals it | `other_variant` |
| `exclude: true` | owner value differs | `applies` |
| `exclude: false` | owner value equals it | `applies` |
| `exclude: false` | owner value differs | `other_variant` |

**Combining axes:** any `other_variant` → `other_variant`; else any `unresolved` → `unresolved`; else
any `applies` → `applies`; else `not_stated`.

- [ ] **Step 1: Write the failing tests** (table-driven, profile `{ engineCode: "2ZR-FE", buildPlant: "NUMMI", … }`):

| Scope | Options | Expected verdict |
| --- | --- | --- |
| engine 2AZ-FE | default | `other_variant` |
| engine 2ZR-FE | default | `applies` |
| `EMPTY_SCOPE` | default | `not_stated` |
| engine unresolved | default | `unresolved` |
| engine 2ZR-FE, profile `engineCode: null` (**Review Focus 3**) | default | `unresolved` |
| plant `TMC` + `exclude: true` | `axes: ["engine", "plant"]` | `applies` |
| plant `TMC` + `exclude: true`, profile plant `TMC` | `axes: ["engine", "plant"]` | `other_variant` |
| plant scoped only | default | `not_stated` (plant ignored) |
| engine 2AZ-FE + plant unresolved | `axes: ["engine", "plant"]` | `other_variant` |

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS**; also `npm run typecheck` from the repo root.
- [ ] **Step 5: Commit** — `feat(n5): classify a scope against the vehicle profile (P1)`

### Task 9: `diagnose:applicability` report

**Files:**
- Create: `server/src/scripts/diagnoseApplicability.js` (structure copied from `diagnoseZeroChunkDocuments.js`: `parseArguments`, an exported builder, `formatConsoleReport`, `buildCsvReport`, `writeReports`, and the `import.meta.url === pathToFileURL(process.argv[1]).href` CLI guard)
- Modify: `server/package.json`, adding `"diagnose:applicability": "node src/scripts/diagnoseApplicability.js"`
- Modify: root `package.json`, adding `"diagnose:applicability": "npm --prefix server run diagnose:applicability --"`
- Modify: `CLAUDE.md` Commands, one bullet beside `diagnose:zero-chunks`. It says the command is
  read-only, writes JSON and CSV to `server/data/diagnostics/`, and changes nothing Ask does.
- Test: `server/test/diagnoseApplicability.test.js`

**Interfaces:**
- Consumes: Tasks 5–8.
- Produces:
  - `parseArguments(argv: string[]): { outputDir?: string, limit?: number, engine?: string }`
  - `buildApplicabilityReport(db: DatabaseSync, options: { ownerEngine: string, limit?: number }): ApplicabilityReport`
    — it takes the handle, so the CLI and the test both pass a `{ readOnly: true }` connection.
    "Owner" in every class name means `ownerEngine`.
  - **Where the CLI gets `ownerEngine`:** `--engine` (normalized by Task 1's rules), else
    `vehicles.engine_code`. If both are empty, it prints "Set the engine code in Settings → Variant
    details, or pass --engine 2ZR-FE." and exits `1`, writing nothing.

**`ApplicabilityReport` keys** (exact names; classes use the **engine** axis with the header blanked):

| Key | Contents |
| --- | --- |
| `totals` | `{ documents, pages, chunks }` |
| `accountHeader` | `{ documents, pages, headerOnlyDocuments }`. Header-only means the raw text names 2ZR-FE, but no 2ZR-FE marker remains once the header is blanked. |
| `documentClasses` | `{ none, owner_only, mixed, other_only }`. Built from `KNOWN_ENGINE_CODES` markers of every kind, including links. |
| `unknownCodeDocuments` | count |
| `pageClasses` | `{ none, owner_only, mixed, other_only }` |
| `pagesWithBothInlineBlocks` | count |
| `specChunks` | `{ mixed, otherOnly }`, using the spec pattern `/\d\s*(N\*m\|N·m\|Nm\|kgf\*cm\|ft\.\*lbf\|in\.\*lbf\|mm\|kPa\|V\b\|Ω\|°C\|L\b)/` |
| `entryScope` | `{ chunksWithoutOwnMarker, inheritingOther, inheritingOwner, unresolvedAtEntry }` |
| `markerKinds` | `{ "<kind>:<owner\|other>": count }` |
| `documents` | `[{ id, filename, pages, chunks, documentClass, headerOnly, pagesOwner, pagesOther, pagesMixed, unresolvedPages }]` |

Pages are rebuilt from the stored chunks with `reconstructPageWords`, ordered by `page_number` and
`chunk_index`. The report never reads PDFs.

- [ ] **Step 1: Write the failing test.**
  - Create a temp DB (`DATABASE_FILE`/`UPLOADS_DIR` in `os.tmpdir()`), run `initializeDatabase()`, and
    insert four synthetic documents with chunks via SQL:
    - (a) page 1 = account header + `"COMPRESSOR (for 2AZ-FE) … 25 N*m … COMPRESSOR (for 2ZR-FE) … 25 N*m"`
    - (b) page 1 = an article titled `(2AZ-FE)` with a spec; page 2 = a 30-word spec text with no markers
    - (c) one chunk with no markers
    - (d) a document row with **zero chunks** (**Review Focus 5**)
  - `parseArguments(["--engine", "2zr-fe"]).engine === "2ZR-FE"`.
  - Calling the CLI entry with no `--engine` while `vehicles.engine_code` is `NULL` sets
    `process.exitCode = 1` and writes no file to the output dir (**Review Focus 3**). Export the CLI body
    as `runCli(argv)` to test it.
  - Reopen the file with `{ readOnly: true }` and call
    `buildApplicabilityReport(db, { ownerEngine: "2ZR-FE" })`. Assert:
    - `documentClasses` deep-equals `{ none: 2, owner_only: 0, mixed: 1, other_only: 1 }`
    - `accountHeader.headerOnlyDocuments === 0` (doc a has a real 2ZR-FE marker)
    - `pagesWithBothInlineBlocks === 1`
    - `entryScope.inheritingOther >= 1` (doc b page 2)
    - doc d is listed with class `none` and `chunks: 0`
    - `buildCsvReport` has one header line plus 4 rows
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Classify each document from its pages' own markers. Count `entryScope` from
  `computeDocumentScopes`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Run on the real corpus (read-only).**
  - Make a fresh `VACUUM INTO` snapshot of the live database into the session scratchpad, opening the
    source with `{ readOnly: true }`.
  - Then run `DATABASE_FILE=<snapshot> npm run diagnose:applicability -- --engine 2ZR-FE --output-dir <scratchpad>`.
  - Compare with the design doc §2.3–2.4 (header-only 780, `other_only` 17, `mixed` 82, `none` 1,027;
    pages 1,982/293/106/12,863; both-inline pages 186).
  - Explain every difference in the PR body. The expected source of differences is the tighter token
    rule: OCR misreads now count as `unknown_code`.
- [ ] **Step 6: Commit** — `feat(n5): read-only diagnose:applicability report (P1)`

### Task 10: Blind label set and the P1 acceptance check

**Files:**
- Create: `server/src/scripts/checkApplicabilityLabels.js`
- Modify: `.gitignore`, adding `server/data/applicability-labels/`
- Modify: `server/package.json`, adding `"check:applicability-labels": "node src/scripts/checkApplicabilityLabels.js"`
- Test: `server/test/checkApplicabilityLabels.test.js` (pure scoring only)
- Modify: `docs/evals/ask-rag-iteration-log.md` (new entry) and the status line of `docs/n5-applicability-design.md`

**Interfaces:**
- Consumes: Tasks 5–9.
- Produces:
  - `scoreLabels(rows: Array<{ expected: "2ZR-FE"|"2AZ-FE"|"both"|"none"|"unclear", verdict: ApplicabilityVerdict }>): { total, scored, unclear, falseApplies, ownerRows, falseOther, falseOtherRate, matrix }`
    — `falseApplies` counts rows with `expected === "2AZ-FE"` and `verdict === "applies"`.
    `ownerRows` counts rows with `expected` of `"2ZR-FE"` or `"both"`, and `falseOther` counts those
    whose verdict is `"other_variant"`.
  - CLI modes:
    - `--sample` writes `server/data/applicability-labels/candidates.jsonl`.
    - `--labels <file>` scores a labeled file and exits `1` when `falseApplies > 0` or
      `falseOtherRate > 0.05`.

**Sampling** (deterministic, read-only; one row per unit-bearing figure, at most 3 per chunk). The rows
come from:
- every chunk with an other-engine marker that also carries a spec;
- 40 header-only spec chunks;
- 30 spec chunks with no own marker inside engine-titled documents.

Each candidate source is ordered by chunk id and taken every *n*th. **Row:**
`{ documentId, pageNumber, chunkIndex, figure, occurrence, contextBefore (≤120 chars), contextAfter (≤60 chars), expected: null, note: "" }`.
**The tagger's verdict is never written to the candidates file**, so labeling stays blind.

- [ ] **Step 1: Write the failing test** for `scoreLabels`:
  - Rows `2AZ-FE/applies`, `2ZR-FE/applies`, `2ZR-FE/other_variant`, `both/applies`, `unclear/applies`
    give `falseApplies 1`, `ownerRows 3`, `falseOther 1`, `unclear 1`, and `falseOtherRate` of 1/3.
  - An empty array gives all zeros and `falseOtherRate 0`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `scoreLabels`, `--sample` and `--labels`.**
  - `--labels` reads each row's chunk from the read-only snapshot and runs `computeDocumentScopes` for
    its document.
  - It locates the `occurrence`-th match of `figure` in the reconstructed page text from the chunk's
    start word, and calls `classifyScope(scopeAt(…), { engineCode: "2ZR-FE", …nulls })`.
  - The labels are written relative to the owner's 2ZR-FE, so the profile here is fixed on purpose and
    does not read Settings.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Label blind (manual).**
  - Generate candidates on the snapshot.
  - Label at least 150 rows by reading the context. Where the context does not settle it, render the
    page with `pdftoppm` from the app's stored PDF, read-only, and decide from the page itself.
  - Use `unclear` honestly. **Do not run `--labels` until labeling is finished.**
  - Give the owner at most 20 of the hardest rows to skim (decision #7). Show them as a short table of
    figure, context and your label, never as a QA procedure.
- [ ] **Step 6: Run the check.** `DATABASE_FILE=<snapshot> npm --prefix server run check:applicability-labels -- --labels server/data/applicability-labels/labels.jsonl`
  - **Acceptance:** `falseApplies === 0` and `falseOtherRate <= 0.05`.
  - If either fails, fix the rule in Tasks 6–7 and add a synthetic regression test for that shape.
    Never edit labels to pass.
- [ ] **Step 7: Record the results.**
  - Add an entry "N5 P1 — applicability tagger, offline (2026-…)" to `ask-rag-iteration-log.md`, with:
    - the revision;
    - the report counts beside the design's;
    - the label matrix;
    - what changed in the rules, if anything.
  - Update the design doc's status line to say P1 is measured.
  - No real manual text goes into either file.
- [ ] **Step 8: Commit** — `feat(n5): blind applicability label check and P1 measurement (P1)`

### Task 11: Gate (run once per PR)

- [ ] `npm ci` in the root, `server` and `client` (the worktree may have no `node_modules`).
- [ ] `npm run lint` → 0 problems; `npm run typecheck` → 0 errors.
- [ ] `npm run test` → both suites pass; the todo count is unchanged from main.
- [ ] `npm run build`, then `npm run smoke` **from a path without `.claude` in it** → 13/13.
- [ ] P0 PR only — QA in the dev app, run by the agent:
  - Settings shows **Variant details**, saves, reloads, and shows the saved values.
  - An invalid plant shows the error banner.
  - Point the dev server at a scratch `DATABASE_FILE`/`UPLOADS_DIR`, never the real data, and leave no
    orphaned dev processes.
- [ ] `git status` is clean apart from the intended files. Nothing under `server/data/` is staged.
- [ ] Report to the owner, and ask before pushing or opening the PR.
