import fs from "node:fs";
import path from "node:path";

// Detecting SOURCE-DERIVED material in invented fixtures: text copied or
// closely derived from the owner's repair manuals, which must never reach this
// public repository.
//
// This is deliberately narrower than "mentions a Toyota". Vehicle metadata (a
// make, a model, an engine code, a plant name) is legitimate in a request, a
// scenario, or a vehicle label, and a check that rejected it would just teach
// people to disable the check. What marks manual text is:
//
//   1. PROVENANCE: the manual vendor's name, and the bracketed date tag that its
//      document titles carry. Neither appears in text anyone invents.
//   2. A VERBATIM PROSE RUN: eight consecutive tokens, at least six of them
//      words, shared with a file that already quotes the manuals. The repo
//      cannot hold the manuals to compare against, but it does hold files that
//      quote real passages. Some name the vendor and some do not (the Ask eval
//      cases quote passages and never say whose), so the comparison pool is
//      every server .js file except the planner-eval files being checked: a
//      strict superset of "files that name the vendor", with no list to edit.
//
// A run that is mostly figures and units ("1.0 to 1.1 mm (0.0394 to 0.0433 in)")
// is NOT prose: short golden figures are public by decision, so a table row's
// numbers alone never count as a copied passage.
//
// The check is applied to CORPUS text only (chunk text, document title, filename).
// It cannot prove a fixture is invented; it catches the two ways a real passage
// most plausibly gets in: its provenance, and a copy-paste of a passage the repo
// already quotes.

export const PROVENANCE_MARKERS = [/ALLDATA/i, /\[\s*\d{1,2}\s+\d{4}\s*\]/];

export const RUN_LENGTH = 8;
export const MIN_PROSE_WORDS = 6;

/** @param {string} text @returns {string[]} */
export function findProvenanceMarkers(text) {
  return PROVENANCE_MARKERS.map((marker) => marker.exec(String(text))?.[0]).filter((found) => found !== undefined);
}

/**
 * Words and whole numbers, lowercased. A decimal stays one token ("1.0"), so a
 * figure is not mistaken for several words.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function wordsOf(text) {
  return String(text).toLowerCase().match(/[a-z]+|\d+(?:\.\d+)?/g) ?? [];
}

/**
 * Every window of `length` tokens that is prose: at least MIN_PROSE_WORDS of
 * them are words rather than numbers.
 *
 * @param {string[]} words
 * @param {number} length
 */
function* runsOf(words, length) {
  for (let start = 0; start + length <= words.length; start += 1) {
    const run = words.slice(start, start + length);

    if (run.filter((token) => /^[a-z]+$/.test(token)).length >= MIN_PROSE_WORDS) {
      yield run.join(" ");
    }
  }
}

/**
 * @param {string[]} texts
 * @param {number} [length]
 * @returns {Set<string>}
 */
export function buildRunSet(texts, length = RUN_LENGTH) {
  const runs = new Set();

  for (const text of texts) {
    for (const run of runsOf(wordsOf(text), length)) {
      runs.add(run);
    }
  }

  return runs;
}

/**
 * @param {string} text
 * @param {Set<string>} runSet
 * @param {number} [length]
 * @returns {string[]}
 */
export function findSharedRuns(text, runSet, length = RUN_LENGTH) {
  return [...new Set([...runsOf(wordsOf(text), length)].filter((run) => runSet.has(run)))];
}

const SKIPPED_DIRECTORIES = new Set(["node_modules", "data", "uploads"]);

/**
 * Every .js file under `roots`, except those matching `exclude`. This is the
 * pool a fixture's prose is compared against: any of them might already quote a
 * manual passage, whether or not it names the vendor.
 *
 * @param {string[]} roots
 * @param {{ exclude?: RegExp }} [options]
 * @returns {string[]}
 */
export function discoverComparisonFiles(roots, { exclude } = {}) {
  /** @type {string[]} */
  const found = [];

  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(full);
      } else if (entry.name.endsWith(".js") && !(exclude && exclude.test(full.split(path.sep).join("/")))) {
        found.push(full);
      }
    }
  };

  roots.forEach(walk);
  return found.sort();
}

/**
 * Findings for one piece of corpus text. Empty means nothing in it looks
 * source-derived.
 *
 * @param {string} text
 * @param {Set<string>} runSet
 */
export function findSourceDerivedMaterial(text, runSet) {
  return {
    provenance: findProvenanceMarkers(text),
    sharedRuns: findSharedRuns(text, runSet),
  };
}
