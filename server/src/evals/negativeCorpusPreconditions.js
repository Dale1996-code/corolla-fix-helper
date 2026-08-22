// Drift detection for verified NEGATIVE (must-refuse) eval cases.
//
// A refusal case is only meaningful while the corpus genuinely lacks the fact.
// `refuse-turbo-boost-pressure` was verified against a corpus with zero
// forced-induction pressure specs -- but the corpus is mutable: importing a
// turbocharged-engine manual, or a generic forced-induction supplement, would
// make the "correct" answer stop being a refusal. The case would then keep
// passing for the wrong reason, quietly, forever.
//
// This scans for evidence that the premise no longer holds and asks a human to
// re-verify rather than letting a stale expectation stay green. It reads the
// live database, so it runs only in the live eval (scripts/evalAnswers.js),
// never in the unit suite.

/**
 * Apply one rule table to a set of chunk rows.
 *
 * Shared by every check below so a new negative case declares patterns and
 * nothing else. At most one match is recorded per row: the point is to name the
 * documents a human should look at, not to count occurrences.
 *
 * @param {Array<{ page_number: number, chunk_text: string, title: string }>} rows
 * @param {Array<{ id: string, pattern: RegExp }>} rules
 */
function scanForEvidence(rows, rules) {
  const matches = [];

  for (const row of rows) {
    const text = String(row.chunk_text || "").replace(/\s+/g, " ");

    for (const rule of rules) {
      const found = text.match(rule.pattern);

      if (!found) {
        continue;
      }

      const at = text.indexOf(found[0]);
      matches.push({
        ruleId: rule.id,
        documentTitle: row.title,
        pageNumber: row.page_number,
        excerpt: text.slice(Math.max(0, at - 60), at + 120),
      });
      break;
    }
  }

  return { stale: matches.length > 0, matches };
}

/**
 * Evidence patterns that would mean the corpus now contains a real
 * forced-induction pressure specification.
 *
 * Deliberately narrow. The corpus legitimately contains the WORDS "turbo",
 * "supercharger", "intercooler", and "boost" in SAE/Toyota abbreviation
 * glossaries, and "booster" in the vacuum brake booster -- those were confirmed
 * as distractors during verification and must not trigger a false alarm. What
 * matters is a turbo/boost term appearing next to an actual pressure figure.
 */
const FORCED_INDUCTION_EVIDENCE = [
  { id: "boost_pressure_phrase", pattern: /\bboost\s+pressure\b/i },
  { id: "wastegate", pattern: /\bwaste\s?gate\b/i },
  {
    id: "boost_with_pressure_unit",
    pattern: /\b(boost|turbo\w*)\b[^.]{0,80}?\d+(\.\d+)?\s*(kpa|psi|bar|kgf\/cm)/i,
  },
  {
    id: "pressure_unit_with_boost",
    pattern: /\d+(\.\d+)?\s*(kpa|psi|bar|kgf\/cm)[^.]{0,80}?\b(boost|turbo\w*)\b/i,
  },
];

/**
 * Scan the corpus for evidence that a verified refusal case is stale.
 *
 * @param {{ prepare: Function }} database
 * @returns {{ stale: boolean, matches: Array<{ ruleId: string, documentTitle: string, pageNumber: number, excerpt: string }> }}
 */
export function checkTurboRefusalPrecondition(database) {
  const rows = database
    .prepare(
      `select c.page_number, c.chunk_text, d.title
         from document_chunks c
         join documents d on d.id = c.document_id
        where c.chunk_text like '%boost%'
           or c.chunk_text like '%turbo%'
           or c.chunk_text like '%Boost%'
           or c.chunk_text like '%Turbo%'`
    )
    .all();

  return scanForEvidence(rows, FORCED_INDUCTION_EVIDENCE);
}

/**
 * Evidence patterns that would mean the corpus now describes a timing BELT.
 *
 * `refuse-timing-belt-interval` was verified against a corpus in which
 * /timing[\s-]*belt/i and /cam[\s-]*belt/i each match 0 of 20,447 chunks,
 * because the 2ZR-FE turns its camshafts with a chain. That premise dies the
 * moment a manual for a belt-driven engine is imported.
 *
 * Unlike the turbo rules, these cannot lean on an unusual vocabulary: the
 * corpus is full of "timing" (809 chunks), "belt" (589), and real replacement
 * intervals for the V-ribbed drive belt. So the rules match the two words
 * TOGETHER as a part name. Matching either word alone would fire on every
 * drive-belt page in the library, and a check that always fires is noise.
 */
const TIMING_BELT_EVIDENCE = [
  { id: "timing_belt_phrase", pattern: /\btiming[\s-]*belt\b/i },
  { id: "cam_belt_phrase", pattern: /\bcam[\s-]*belt\b/i },
  { id: "toothed_belt_phrase", pattern: /\btoothed[\s-]*belt\b/i },
];

/**
 * Scan the corpus for evidence that the timing-belt refusal case is stale.
 *
 * @param {{ prepare: Function }} database
 * @returns {{ stale: boolean, matches: Array<{ ruleId: string, documentTitle: string, pageNumber: number, excerpt: string }> }}
 */
export function checkTimingBeltRefusalPrecondition(database) {
  const rows = database
    .prepare(
      `select c.page_number, c.chunk_text, d.title
         from document_chunks c
         join documents d on d.id = c.document_id
        where c.chunk_text like '%belt%'
           or c.chunk_text like '%Belt%'
           or c.chunk_text like '%BELT%'`
    )
    .all();

  return scanForEvidence(rows, TIMING_BELT_EVIDENCE);
}

/**
 * All negative-case preconditions, keyed by eval case id.
 *
 * Only VERIFIED refusal cases need an entry: a template case does not gate the
 * run, so a stale premise costs nothing until someone promotes it. The three
 * fictional refusals (flux capacitor, Boeing 747, warp core) deliberately have
 * none -- no plausible import makes them answerable, and a check that can never
 * fire is maintenance for nothing.
 *
 * @type {Record<string, (database: any) => { stale: boolean, matches: any[] }>}
 */
export const NEGATIVE_CASE_PRECONDITIONS = {
  "refuse-turbo-boost-pressure": checkTurboRefusalPrecondition,
  "refuse-timing-belt-interval": checkTimingBeltRefusalPrecondition,
};
