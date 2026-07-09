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
//   id               short unique name
//   question         what to ask
//   category         "torque" | "capacity" | "procedure" | "refusal" | "behavior"
//   system           vehicle system label (Engine, Brakes, ...) for coverage (optional)
//   expect           "answered" or "refused"
//   mustIncludeAny   answer must contain at least ONE of these (string = contains, /regex/ = matches)
//   mustIncludeAll   answer must contain ALL of these (optional)
//   citationDocLike  answer must cite a document whose title/filename matches this (optional)
//   citationSupportsAny  at least one CITED SNIPPET must match one of these — proves the
//                    cited chunk text actually backs the asserted spec, not just the prose (optional)
//   mustCite         require at least one citation (default true for answered cases)
//   image            a data: URI sent with the question to exercise Vision Ask (optional)
//   followUp         a second question in the same conversation (tests multi-turn memory).
//                    standaloneIncludes checks the rewritten follow-up query.
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
    system: "Cooling",
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

  // ---- TEMPLATES: broader system coverage (verified:false until confirmed) ----
  // These spread the eval across the major vehicle systems so a retrieval/rerank
  // change that helps one system but hurts another is visible. Every value is a
  // common published 2009 Corolla 1.8L (2ZR-FE) figure used ONLY as a starting
  // point — confirm each against YOUR manual before flipping verified: true.
  {
    id: "rear-brake-caliper-torque",
    question: "What is the rear brake caliper mounting bolt torque?",
    category: "torque",
    system: "Brakes",
    expect: "answered",
    mustIncludeAny: [/\b34\s*N/i, /\b25\s*ft/i], // CONFIRM against your manual
    citationSupportsAny: [/\b34\s*N/i, /\b25\s*ft/i],
    citationDocLike: /brake/i,
    verified: false,
  },
  {
    id: "brake-fluid-type",
    question: "What brake fluid type does the car use?",
    category: "capacity",
    system: "Brakes",
    expect: "answered",
    mustIncludeAny: [/DOT\s*3/i, /DOT\s*4/i], // CONFIRM against your manual
    verified: false,
  },
  {
    id: "thermostat-opening-temperature",
    question: "At what temperature does the thermostat start to open?",
    category: "capacity",
    system: "Cooling",
    expect: "answered",
    mustIncludeAny: [/(80|82|176|180|183)\s*(°|deg|c\b|f\b)/i], // CONFIRM against your manual
    verified: false,
  },
  {
    id: "charging-system-voltage",
    question: "What charging voltage should the alternator produce at idle?",
    category: "capacity",
    system: "Electrical",
    expect: "answered",
    mustIncludeAny: [/1[34]\.[0-9]\s*(v|volt)/i], // CONFIRM against your manual
    verified: false,
  },
  {
    id: "front-strut-mount-torque",
    question: "What is the front strut-to-body mounting nut torque?",
    category: "torque",
    system: "Suspension",
    expect: "answered",
    mustIncludeAny: [/\b29\s*ft/i, /\b39\s*N/i], // CONFIRM against your manual
    verified: false,
  },
  {
    id: "front-lower-ball-joint-procedure",
    question: "How do I replace the front lower ball joint?",
    category: "procedure",
    system: "Suspension",
    expect: "answered",
    mustIncludeAny: [/ball joint/i], // a real procedure should mention this
    mustIncludeAll: [/control arm|knuckle|steering knuckle/i],
    verified: false,
  },
  {
    id: "auto-transaxle-fluid-type",
    question: "Which automatic transaxle fluid is required?",
    category: "capacity",
    system: "Transmission",
    expect: "answered",
    mustIncludeAny: [/ATF\s*WS/i, /Toyota\s*ATF/i], // CONFIRM against your manual
    citationSupportsAny: [/ATF\s*WS/i],
    verified: false,
  },
  {
    id: "fuel-pressure-spec",
    question: "What is the fuel system pressure specification?",
    category: "capacity",
    system: "Fuel",
    expect: "answered",
    mustIncludeAny: [/\b\d{2,3}\s*(kpa|psi)/i], // CONFIRM against your manual
    verified: false,
  },
  {
    id: "ac-refrigerant-type",
    question: "What air conditioning refrigerant does the system use?",
    category: "capacity",
    system: "HVAC",
    expect: "answered",
    mustIncludeAny: [/R-?134a/i], // CONFIRM against your manual
    verified: false,
  },
  {
    id: "cabin-air-filter-procedure",
    question: "How do I replace the cabin air filter?",
    category: "procedure",
    system: "HVAC",
    expect: "answered",
    mustIncludeAny: [/cabin/i, /filter/i], // a real procedure should mention these
    verified: false,
  },
  {
    id: "valve-cover-bolt-torque",
    question: "What is the cylinder head cover (valve cover) bolt torque?",
    category: "torque",
    system: "Engine",
    expect: "answered",
    mustIncludeAny: [/\b\d{1,2}\s*N/i, /\bft-?lb/i], // CONFIRM against your manual
    verified: false,
  },

  // ---- GOLDEN TOPICS: beginner repair questions we want the chatbot to handle ----
  // These pin the behavior the RAG-improvement plan cares about (trouble codes,
  // cooling, symptom triage, belts) so a retrieval/prompt change that helps one
  // and hurts another is visible. They stay verified:false until you run
  // `npm run eval:answers` on the machine with your real documents + API key,
  // confirm each expectation against the cited PDF page, then flip verified:true
  // (and add the id to VERIFIED_IDS in answerQualityCases.test.js).
  {
    id: "p0301-cylinder-1-misfire",
    question:
      "I have a P0301 code for a cylinder 1 misfire. What should I check first according to the manual?",
    category: "procedure",
    system: "Engine",
    expect: "answered",
    // A useful answer should point at the ignition/fuel items behind a misfire,
    // grounded in the manual — not invent a diagnosis.
    mustIncludeAny: [/misfire/i, /cylinder/i, /(ignition )?coil/i, /spark plug/i],
    verified: false,
  },
  {
    id: "coolant-drain-and-refill",
    question: "How do I drain and refill the engine coolant?",
    category: "procedure",
    system: "Cooling",
    expect: "answered",
    mustIncludeAny: [/coolant/i, /radiator/i, /drain/i],
    verified: false,
  },
  {
    id: "startup-squeal-belt-triage",
    question:
      "My Corolla squeals for a few seconds right after I start it. What should I check?",
    category: "behavior",
    system: "Engine",
    expect: "answered",
    // Should surface belt / accessory-drive evidence from the documents rather
    // than guessing at a cause.
    mustIncludeAny: [/belt/i, /tensioner/i, /pulley/i],
    verified: false,
  },
  {
    id: "drive-belt-replacement",
    question: "How do I replace the alternator drive belt?",
    category: "procedure",
    system: "Electrical",
    expect: "answered",
    mustIncludeAny: [/belt/i],
    mustIncludeAll: [/tensioner|routing|deflection|idler/i],
    verified: false,
  },
  {
    id: "refuse-turbo-boost-pressure",
    question: "What is the turbocharger boost pressure specification?",
    category: "refusal",
    system: "Engine",
    // The 2009 Corolla LE 1.8L (2ZR-FE) is naturally aspirated, so the manual
    // has no turbo boost spec: the chatbot must refuse instead of inventing one.
    expect: "refused",
    verified: false,
  },
  {
    id: "oil-drain-plug-torque-citation-support",
    question: "What is the oil drain plug torque, and which document states it?",
    category: "torque",
    system: "Engine",
    expect: "answered",
    // Same confirmed fact as oil-drain-plug-torque (37 N·m / 27 ft-lbf, cited
    // "Oil and Oil Filter Replacement", page 1), but this case additionally
    // requires the CITED SNIPPET to contain the value — proving the citation
    // actually backs the number, not just that the prose mentioned it. Flip to
    // verified:true once you confirm the cited snippet includes the figure.
    mustIncludeAny: [/\b37\s*N/i, /\b27\s*ft/i],
    citationDocLike: /oil/i,
    citationSupportsAny: [/\b37\s*N/i, /\b27\s*ft/i, /\b377\s*kgf/i],
    verified: false,
  },

  // ---- TEMPLATE: Vision Ask guard (Phase 2). verified:false. ----
  // The model may describe the attached photo, but it must STILL refuse a spec
  // the uploaded PDF chunks do not support — an image is never a source for a
  // torque/capacity/procedure value. A 1x1 placeholder PNG stands in for a real
  // photo; the refusal is driven by the not-found gate, not the image content.
  {
    id: "vision-refuses-unsupported-spec",
    question:
      "Here is a photo of my dashboard. What is the exact torque spec for the part shown in this picture?",
    category: "refusal",
    system: "Electrical",
    expect: "refused",
    image:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    verified: false,
  },
];
