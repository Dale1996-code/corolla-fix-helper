// Ask evidence contract (Milestone 2), behind config.askEvidenceContract.
//
// The problem this exists for: without it, the model returns one undifferentiated
// prose blob, every retrieved chunk becomes a citation, and nothing checks that
// the prose is actually supported by those citations. A confident sentence
// containing an invented torque value renders exactly like a sourced one.
//
// The contract instead asks for ATOMIC CLAIMS, each carrying a verbatim
// evidenceQuote and a prompt-local source id (S1, S2, ...). The server then:
//   1. validates the shape (hand-written; no new dependency),
//   2. maps each source id back to the chunk it was built from,
//   3. verifies the quote really is a substring of that chunk,
//   4. runs a numeric ANOMALY DETECTOR over every channel,
//   5. derives answered / partial / not_found itself.
//
// Prompt-local ids, never database row ids: chunk ids are recreated on
// re-extraction (documentChunkService rebuilds them), so a row id in a model
// reply would be meaningless the moment a document is re-extracted.
//
// A leaf module: it imports nothing.

/** Max claims/guidance/gaps we will accept, so a runaway reply stays bounded. */
const MAX_ITEMS = 40;
const MAX_TEXT_LENGTH = 2000;

/**
 * JSON schema sent as `text.format`. Kept deliberately small: more structure
 * means more ways for the model to fail the schema and cost a retry.
 */
export const EVIDENCE_RESPONSE_SCHEMA = {
  type: "json_schema",
  name: "grounded_repair_answer",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["documentSupported", "generalGuidance", "gaps"],
    properties: {
      documentSupported: {
        type: "array",
        description:
          "Claims taken from the provided sources. Each needs a verbatim quote.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["claim", "sourceId", "evidenceQuote"],
          properties: {
            claim: { type: "string" },
            sourceId: { type: "string", description: "One of the S1..Sn labels." },
            evidenceQuote: {
              type: "string",
              description: "Text copied EXACTLY from that source, supporting the claim.",
            },
          },
        },
      },
      generalGuidance: {
        type: "array",
        description: "General mechanical knowledge NOT taken from the sources.",
        items: { type: "string" },
      },
      gaps: {
        type: "array",
        description: "What the sources do not answer.",
        items: { type: "string" },
      },
    },
  },
};

/** Stable prompt-local label for the nth retrieved chunk. */
export function sourceLabel(index) {
  return `S${index + 1}`;
}

/**
 * Build the source block. Labels are positional and prompt-local; the mapping
 * back to real chunks never leaves the server.
 */
export function buildEvidenceContext(chunks) {
  return chunks
    .map(
      (chunk, index) =>
        `[${sourceLabel(index)}] ${chunk.documentTitle} (${chunk.originalFilename}) page ${
          chunk.pageNumber
        }: ${chunk.chunkText}`
    )
    .join("\n\n");
}

export function buildEvidencePromptLines({ question, originalQuestion, hasImage }) {
  const lines = [
    "You answer Toyota Corolla repair questions from the provided sources only.",
    "Return JSON matching the schema. Do not write prose outside the schema.",
    "",
    "documentSupported: one entry per ATOMIC claim you take from the sources.",
    "  - claim: one short, self-contained statement. Split multi-part facts apart.",
    "  - sourceId: the S-label of the source it came from.",
    "  - evidenceQuote: text copied EXACTLY, character for character, from that",
    "    source. It must contain the specific value or instruction the claim makes.",
    "    Never paraphrase a quote. Never combine text from two sources into one quote.",
    "generalGuidance: general mechanical advice NOT found in the sources. Never put",
    "  a torque figure, capacity, pressure, clearance, or other specification here.",
    "gaps: what the sources do not cover, so the owner knows what to look up.",
    "",
    "If the sources do not support an answer, return empty documentSupported and",
    "explain the gap. Never invent a specification, step, tool, or warning.",
  ];

  if (hasImage) {
    lines.push(
      "",
      "An image is attached. You may describe it in generalGuidance to acknowledge",
      "what the owner is showing, but it is NEVER a source for a specification,",
      "procedure, or torque value -- those must come from the sources and be quoted."
    );
  }

  lines.push(
    "",
    `Original user question: ${originalQuestion || question}`,
    `Question: ${question}`
  );

  return lines;
}

// ---------------------------------------------------------------------------
// Hand-written validator. No runtime schema dependency: the repo deliberately
// avoids heavy dependencies, and this is one small fixed shape.
// ---------------------------------------------------------------------------

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(readString)
    .filter(Boolean)
    .slice(0, MAX_ITEMS)
    .map((text) => text.slice(0, MAX_TEXT_LENGTH));
}

/**
 * Validate the parsed model reply.
 *
 * @param {any} payload
 * @returns {{ ok: boolean, reason?: string, value?: {
 *   documentSupported: Array<{claim: string, sourceId: string, evidenceQuote: string}>,
 *   generalGuidance: string[],
 *   gaps: string[],
 * } }}
 */
export function validateEvidencePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "not_an_object" };
  }

  if (!Array.isArray(payload.documentSupported)) {
    return { ok: false, reason: "documentSupported_not_an_array" };
  }

  const documentSupported = [];

  for (const raw of payload.documentSupported.slice(0, MAX_ITEMS)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, reason: "claim_not_an_object" };
    }

    const claim = readString(raw.claim);
    const sourceId = readString(raw.sourceId);
    const evidenceQuote = readString(raw.evidenceQuote);

    if (!claim || !sourceId || !evidenceQuote) {
      return { ok: false, reason: "claim_missing_fields" };
    }

    documentSupported.push({
      claim: claim.slice(0, MAX_TEXT_LENGTH),
      sourceId,
      evidenceQuote: evidenceQuote.slice(0, MAX_TEXT_LENGTH),
    });
  }

  return {
    ok: true,
    value: {
      documentSupported,
      generalGuidance: readStringArray(payload.generalGuidance),
      gaps: readStringArray(payload.gaps),
    },
  };
}

// ---------------------------------------------------------------------------
// Evidence verification
// ---------------------------------------------------------------------------

/** Normalize for substring comparison: whitespace, quotes, and case only. */
function normalizeForMatch(text) {
  return String(text || "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Is the quote genuinely present in the source chunk?
 *
 * Whitespace- and case-insensitive, because PDF extraction produces erratic
 * spacing, but otherwise strict: no paraphrase passes. This is checkable
 * server-side with no model cooperation, which is what makes it worth more than
 * a chunk id (a chunk id proves retrieval, not support).
 */
export function quoteAppearsInChunk(quote, chunkText) {
  const needle = normalizeForMatch(quote);
  const haystack = normalizeForMatch(chunkText);

  if (!needle || !haystack) {
    return false;
  }

  return haystack.includes(needle);
}

// ---------------------------------------------------------------------------
// Numeric anomaly detector
// ---------------------------------------------------------------------------
//
// Named honestly: presence-matching cannot prove a number belongs to the right
// fastener or procedure stage. It can only prove the number is NOT in the cited
// evidence, which is the dangerous direction.
//
// Scoped, NOT a blanket ban on digits. Only unit-bearing technical
// specifications are gated. Step numbers, counts of bolts, page references, and
// ordinals pass untouched -- gating those would mangle ordinary procedure prose
// and push the model toward vaguer, less useful text.

const UNIT_PATTERN =
  "n\\s*[·.\\-]?\\s*m|nm|newton\\s*met(?:er|re)s?|" +
  "ft\\s*[-·.]?\\s*lbf?|lb\\s*[-·.]?\\s*ft|foot\\s*pounds?|" +
  "in\\s*[-·.]?\\s*lbf?|inch\\s*pounds?|" +
  "kgf\\s*[-·.\\/]?\\s*cm|kgf\\s*[-·.\\/]?\\s*m|kg\\s*[-·.]?\\s*cm|" +
  "kpa|mpa|psi|bar|" +
  "millimet(?:er|re)s?|mm|centimet(?:er|re)s?|cm|micron?s?|" +
  "lit(?:er|re)s?|ml|millilit(?:er|re)s?|qt|quarts?|pints?|gal(?:lons?)?|fl\\s*oz|" +
  "ohms?|kilohms?|k\\s*ohms?|Ω|" +
  "volts?|millivolts?|amps?|amperes?|milliamps?|" +
  "°\\s*[cf]|deg(?:rees)?\\s*[cf]\\b|" +
  "rpm|hz|kilohertz|khz";

/** number + unit, e.g. "37 Nm", "27 ft-lbf", "0.8 mm", "13.5 volts" */
const SPEC_NUMBER_REGEX = new RegExp(
  `(\\d+(?:[.,]\\d+)?)\\s*(?:${UNIT_PATTERN})\\b`,
  "gi"
);

/** Viscosity grades: 5W-30, 0W20. A grade is a spec even without a unit. */
const VISCOSITY_REGEX = /\b\d+\s*w\s*[-–]?\s*\d+\b/gi;

/**
 * Numeric specifications asserted by a piece of text.
 *
 * @param {string} text
 * @returns {Array<{ value: number, raw: string, unit: string }>}
 */
export function extractSpecNumbers(text) {
  const source = String(text || "");
  const found = [];

  for (const match of source.matchAll(SPEC_NUMBER_REGEX)) {
    const value = Number(String(match[1]).replace(",", "."));

    if (Number.isFinite(value)) {
      found.push({ value, raw: match[0].trim(), unit: match[0].replace(match[1], "").trim() });
    }
  }

  for (const match of source.matchAll(VISCOSITY_REGEX)) {
    found.push({ value: NaN, raw: match[0].trim(), unit: "viscosity" });
  }

  return found;
}

// Unit families, each with a canonical unit. A manual prints a torque table as
// "37 (377, 27)" -- N·m, kgf-cm, ft-lbf -- so an answer stating the ft-lbf
// figure IS supported by a chunk stating the N·m figure, and flagging that would
// punish a correct conversion.
//
// Conversion is deliberately WITHIN a family only. Applying every factor to
// every number produces false groundings: 377 kgf-cm times the kPa->psi factor
// is 54.7, which would have "grounded" an invented 54 N·m against a chunk that
// says 37 N·m.
const UNIT_FAMILIES = [
  {
    family: "torque",
    units: [
      { match: /^(n\s*[·.-]?\s*m|nm|newton\s*met(er|re)s?)$/i, factor: 1 },
      { match: /^(ft\s*[-·.]?\s*lbf?|lb\s*[-·.]?\s*ft|foot\s*pounds?)$/i, factor: 1.355818 },
      { match: /^(in\s*[-·.]?\s*lbf?|inch\s*pounds?)$/i, factor: 0.1129848 },
      { match: /^(kgf\s*[-·./]?\s*cm|kg\s*[-·.]?\s*cm)$/i, factor: 0.0980665 },
      { match: /^(kgf\s*[-·./]?\s*m)$/i, factor: 9.80665 },
    ],
  },
  {
    family: "pressure",
    units: [
      { match: /^kpa$/i, factor: 1 },
      { match: /^mpa$/i, factor: 1000 },
      { match: /^psi$/i, factor: 6.894757 },
      { match: /^bar$/i, factor: 100 },
    ],
  },
  {
    family: "volume",
    units: [
      { match: /^(lit(er|re)s?|l)$/i, factor: 1 },
      { match: /^(millilit(er|re)s?|ml)$/i, factor: 0.001 },
      { match: /^(qt|quarts?)$/i, factor: 0.9463529 },
      { match: /^pints?$/i, factor: 0.4731765 },
      { match: /^(gal|gallons?)$/i, factor: 3.785412 },
      { match: /^fl\s*oz$/i, factor: 0.0295735 },
    ],
  },
  {
    family: "length",
    units: [
      { match: /^(millimet(er|re)s?|mm)$/i, factor: 1 },
      { match: /^(centimet(er|re)s?|cm)$/i, factor: 10 },
      { match: /^(microns?)$/i, factor: 0.001 },
    ],
  },
];

/**
 * Canonicalize a value+unit into its family, or null when the unit is outside
 * the families we convert (volts, ohms, rpm, temperature). Those still get the
 * literal-presence check, just no conversion -- temperature in particular has an
 * offset, so a naive factor would be wrong.
 */
function canonicalize(value, unit) {
  const cleaned = String(unit || "").trim();

  for (const entry of UNIT_FAMILIES) {
    for (const candidate of entry.units) {
      if (candidate.match.test(cleaned)) {
        return { family: entry.family, canonical: value * candidate.factor };
      }
    }
  }

  return null;
}

function withinTolerance(left, right) {
  return Math.abs(left - right) <= Math.max(0.51, Math.abs(right) * 0.02);
}

/**
 * Is the claimed spec present in the evidence -- literally, or as a conversion
 * within the same unit family?
 */
function specIsPresent(spec, evidenceNumbers, evidenceSpecs) {
  if (!Number.isFinite(spec.value)) {
    return false;
  }

  // 1. The numeral appears somewhere in the evidence.
  if (evidenceNumbers.some((candidate) => withinTolerance(candidate, spec.value))) {
    return true;
  }

  // 2. Or an evidence spec in the SAME family converts to it.
  const claimCanonical = canonicalize(spec.value, spec.unit);

  if (!claimCanonical) {
    return false;
  }

  for (const evidenceSpec of evidenceSpecs) {
    const evidenceCanonical = canonicalize(evidenceSpec.value, evidenceSpec.unit);

    if (
      evidenceCanonical &&
      evidenceCanonical.family === claimCanonical.family &&
      withinTolerance(evidenceCanonical.canonical, claimCanonical.canonical)
    ) {
      return true;
    }
  }

  return false;
}

/** All numbers appearing anywhere in the evidence text, unit or not. */
function allNumbersIn(text) {
  return [...String(text || "").matchAll(/\d+(?:[.,]\d+)?/g)]
    .map((match) => Number(String(match[0]).replace(",", ".")))
    .filter(Number.isFinite);
}

/**
 * Check one claim's numeric specifications against its evidence.
 *
 * @returns {{ grounded: boolean, unsupported: string[] }}
 */
export function checkClaimNumbers(claimText, evidenceText) {
  const specs = extractSpecNumbers(claimText);

  if (!specs.length) {
    return { grounded: true, unsupported: [] };
  }

  const evidenceNumbers = allNumbersIn(evidenceText);
  const evidenceSpecs = extractSpecNumbers(evidenceText);
  const normalizedEvidence = normalizeForMatch(evidenceText);
  const unsupported = [];

  for (const spec of specs) {
    if (spec.unit === "viscosity") {
      // Compared textually: "5W-30" must literally appear.
      const grade = normalizeForMatch(spec.raw).replace(/[\s–]/g, "");
      const evidenceCollapsed = normalizedEvidence.replace(/[\s–]/g, "");

      if (!evidenceCollapsed.includes(grade)) {
        unsupported.push(spec.raw);
      }

      continue;
    }

    if (!specIsPresent(spec, evidenceNumbers, evidenceSpecs)) {
      unsupported.push(spec.raw);
    }
  }

  return { grounded: unsupported.length === 0, unsupported };
}

/**
 * Replace unit-bearing specifications with a placeholder.
 *
 * A gap explains what could NOT be verified, so it must not reprint the very
 * number that failed verification -- doing so would put an ungrounded torque
 * value back on screen, just under a different heading. The topic survives so
 * the gap stays useful; the value is kept server-side in `rejected`.
 */
export function redactSpecNumbers(text) {
  return String(text || "")
    .replace(SPEC_NUMBER_REGEX, "[unverified value]")
    .replace(VISCOSITY_REGEX, "[unverified value]");
}

/**
 * Verify every claim and gate every channel.
 *
 * Fails CLOSED for unsupported technical numeric claims: they are removed from
 * the actionable answer and converted into explicit gaps, rather than rendered
 * with a warning decoration next to a number that may be invented.
 *
 * @param {{ documentSupported: any[], generalGuidance: string[], gaps: string[] }} validated
 * @param {any[]} chunks - retrieval order; index maps to S1..Sn
 */
export function verifyEvidence(validated, chunks) {
  const byLabel = new Map(chunks.map((chunk, index) => [sourceLabel(index), { chunk, index }]));
  const supported = [];
  const gaps = [...validated.gaps];
  const rejected = [];

  for (const claim of validated.documentSupported) {
    const mapped = byLabel.get(claim.sourceId.toUpperCase());

    if (!mapped) {
      rejected.push({ claim: claim.claim, reason: "unknown_source" });
      gaps.push(`Unverified (source not recognized): ${redactSpecNumbers(claim.claim)}`);
      continue;
    }

    if (!quoteAppearsInChunk(claim.evidenceQuote, mapped.chunk.chunkText)) {
      rejected.push({ claim: claim.claim, reason: "quote_not_in_source" });
      gaps.push(
        `Unverified (quote not found in the cited page): ${redactSpecNumbers(claim.claim)}`
      );
      continue;
    }

    // The quote is real; now the numbers in the CLAIM must be present in it.
    const numeric = checkClaimNumbers(claim.claim, claim.evidenceQuote);

    if (!numeric.grounded) {
      rejected.push({
        claim: claim.claim,
        reason: "numeric_anomaly",
        unsupported: numeric.unsupported,
      });
      // The failing value is deliberately NOT reprinted here.
      gaps.push(
        `Unverified specification (not found in the cited text): ${redactSpecNumbers(
          claim.claim
        )}`
      );
      continue;
    }

    supported.push({
      claim: claim.claim,
      evidenceQuote: claim.evidenceQuote,
      documentId: mapped.chunk.documentId,
      documentTitle: mapped.chunk.documentTitle,
      originalFilename: mapped.chunk.originalFilename,
      pageNumber: mapped.chunk.pageNumber,
      chunkIndex: mapped.chunk.chunkIndex,
    });
  }

  // General guidance is not sourced, so ANY technical specification in it is
  // unsupported by definition -- it fails closed regardless of how confident it
  // reads. Step numbers and counts are untouched (no unit, no match).
  const generalGuidance = [];

  for (const guidance of validated.generalGuidance) {
    const specs = extractSpecNumbers(guidance);

    if (specs.length) {
      rejected.push({
        claim: guidance,
        reason: "unsourced_specification",
        unsupported: specs.map((spec) => spec.raw),
      });
      gaps.push(
        `Removed unsourced specification: ${redactSpecNumbers(
          guidance
        )} Check the manual before relying on this.`
      );
      continue;
    }

    generalGuidance.push(guidance);
  }

  return { documentSupported: supported, generalGuidance, gaps, rejected };
}

/**
 * Status derived by the SERVER from what actually verified -- never taken from
 * a model-supplied field, which could contradict its own claims.
 */
export function deriveEvidenceStatus({ documentSupported, gaps }) {
  if (!documentSupported.length) {
    return "not_found";
  }

  return gaps.length ? "partial" : "answered";
}

/**
 * Flatten the verified evidence into the plain `answer` string, so existing
 * consumers of the response keep working unchanged.
 */
export function renderEvidenceAnswer({ documentSupported, generalGuidance, gaps }) {
  const sections = [];

  if (documentSupported.length) {
    sections.push(
      documentSupported
        .map(
          (item) =>
            `${item.claim} [${item.documentTitle || item.originalFilename}, page ${
              item.pageNumber
            }]`
        )
        .join("\n")
    );
  }

  if (generalGuidance.length) {
    sections.push(
      `General guidance — not from your documents:\n${generalGuidance
        .map((line) => `- ${line}`)
        .join("\n")}`
    );
  }

  if (gaps.length) {
    sections.push(`Not covered by your documents:\n${gaps.map((gap) => `- ${gap}`).join("\n")}`);
  }

  return sections.join("\n\n").trim();
}
