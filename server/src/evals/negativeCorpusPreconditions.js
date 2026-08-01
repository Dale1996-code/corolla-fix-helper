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

  const matches = [];

  for (const row of rows) {
    const text = String(row.chunk_text || "").replace(/\s+/g, " ");

    for (const rule of FORCED_INDUCTION_EVIDENCE) {
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
 * All negative-case preconditions, keyed by eval case id.
 * @type {Record<string, (database: any) => { stale: boolean, matches: any[] }>}
 */
export const NEGATIVE_CASE_PRECONDITIONS = {
  "refuse-turbo-boost-pressure": checkTurboRefusalPrecondition,
};
