// Answer-quality test cases for the Ask chatbot.
//
// HOW THIS WORKS
//   `npm run eval:answers` asks each question below against your REAL embedded
//   database and checks the answer. It is your regression safety net: run it after
//   any change to confirm the chatbot still gives correct, well-cited answers.
//
// TWO KINDS OF CASES
//   verified: true   -> counts toward pass/fail. The run FAILS if any verified case fails.
//   verified: false  -> a TEMPLATE. It runs and reports, but does not fail the build.
//                       Fill in the expected value from YOUR manual, confirm it, then
//                       flip it to verified: true.
//
// FIELDS
//   id              short unique name
//   question        what to ask
//   category        "torque" | "capacity" | "procedure" | "refusal" | "behavior"
//   expect          "answered" or "refused"
//   mustIncludeAny  answer must contain at least ONE of these (string = contains, /regex/ = matches)
//   mustIncludeAll  answer must contain ALL of these (optional)
//   citationDocLike answer must cite a document whose title/filename matches this (optional)
//   mustCite        require at least one citation (default true for answered cases)
//   followUp        a second question in the same conversation (tests multi-turn memory).
//                   standaloneIncludes checks the rewritten follow-up query.
//
// HOW TO ADD A VERIFIED CASE
//   1. Ask the question in the app. 2. Confirm the number against the cited PDF page.
//   3. Copy the question here, set mustIncludeAny to the exact value (e.g. /37\s*N/i),
//      set citationDocLike to part of the source name, set verified: true.

export const answerQualityCases = [
  // ---- VERIFIED: confirmed against the real documents ----
  {
    id: "oil-drain-plug-torque",
    question: "What is the oil drain plug torque spec?",
    category: "torque",
    expect: "answered",
    // Confirmed live: 37 N·m (377 kgf-cm, 27 ft-lbf), cited "Oil and Oil Filter Replacement", page 1.
    mustIncludeAny: [/\b37\s*N/i, /\b27\s*ft/i],
    citationDocLike: /oil/i,
    verified: true,
  },

  // ---- VERIFIED: must-refuse cases (no document should answer these) ----
  // These guard the most important safety behavior: the chatbot must say
  // "not in documents" instead of inventing a spec.
  {
    id: "refuse-flux-capacitor",
    question: "What is the torque spec for the flux capacitor?",
    category: "refusal",
    expect: "refused",
    verified: true,
  },
  {
    id: "refuse-boeing-tire",
    question: "What is the recommended tire pressure for a Boeing 747?",
    category: "refusal",
    expect: "refused",
    verified: true,
  },
  {
    id: "refuse-warp-core",
    question: "How do I align the warp core on this Corolla?",
    category: "refusal",
    expect: "refused",
    verified: true,
  },

  // ---- TEMPLATES: confirm the expected value against YOUR manual, then set verified: true ----
  // The values below are common published 2009 Corolla 1.8L (2ZR-FE) figures used only as a
  // starting point. Do NOT trust them until you confirm them against your own documents.
  {
    id: "wheel-lug-nut-torque",
    question: "What is the wheel lug nut torque spec?",
    category: "torque",
    expect: "answered",
    mustIncludeAny: [/\b76\s*ft/i, /\b103\s*N/i], // CONFIRM against your manual
    verified: false,
  },
  {
    id: "engine-oil-capacity",
    question: "What is the engine oil capacity with a filter change?",
    category: "capacity",
    expect: "answered",
    mustIncludeAny: [/4\.4\s*(qt|quart)/i, /4\.2\s*(l|liter|litre)/i], // CONFIRM against your manual
    verified: false,
  },
  {
    id: "spark-plug-gap",
    question: "What is the spark plug gap?",
    category: "capacity",
    expect: "answered",
    mustIncludeAny: [/1\.[01]\s*mm/i, /0\.04[0-9]?\s*in/i], // CONFIRM against your manual
    verified: false,
  },
  {
    id: "front-brake-pad-procedure",
    question: "How do I replace the front brake pads?",
    category: "procedure",
    expect: "answered",
    mustIncludeAny: [/caliper/i, /pad/i], // a real procedure should mention these
    verified: false,
  },

  // ---- TEMPLATE: multi-turn follow-up (tests that pronouns get rewritten) ----
  {
    id: "water-pump-then-torque",
    question: "How do I replace the water pump?",
    category: "behavior",
    expect: "answered",
    mustIncludeAny: [/water pump/i],
    followUp: {
      question: "What about the torque?",
      // The pronoun-free rewrite should re-introduce "water pump":
      standaloneIncludes: /water pump/i,
      mustIncludeAny: [/N\b|N·m|Nm|ft/i],
    },
    verified: false,
  },
];
