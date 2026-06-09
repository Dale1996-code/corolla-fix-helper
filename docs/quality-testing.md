# Quality Testing The Chatbot

This is how you check that the Ask chatbot gives **correct, well-cited answers** — and
catch it if a future change quietly makes answers worse. There are two checks.

## 1. Retrieval check (cheap)

```powershell
npm run eval:retrieval
```

This proves the search step finds the right passage. It runs on its own temporary data and
needs no API key. Use it to confirm the hybrid (keyword + meaning) search still beats plain
keyword search.

## 2. Answer check (the real quality test)

```powershell
npm run eval:answers
```

This asks a list of real repair questions against **your actual embedded documents** and
checks each answer. Run it on the machine where you imported and embedded your PDFs, with
your `OPENAI_API_KEY` set (it costs a few cents per full run). For each question it checks:

- **Answer questions** (torque specs, capacities, procedures): does the answer contain the
  exact expected value, and does it cite the right document?
- **Refusal questions** (things not in your manuals): does it correctly say
  `not in documents` instead of inventing an answer? This is the most important safety check.
- **Follow-up questions**: does a vague follow-up ("what about the torque?") get rewritten to
  include what it refers to before searching?

It prints a scorecard and **fails if any verified case fails.**

## The test questions live in one file

Edit `server/src/evals/answerQualityCases.js`. Each question is either:

- `verified: true` — confirmed against your manual. These **gate** the result.
- `verified: false` — a **template**. It runs and reports, but does not fail the run. The
  values in templates are common published figures used as a starting point — **confirm them
  against your own documents before trusting them.**

### Adding your own verified question

1. Ask the question in the app and open the cited PDF page to confirm the number.
2. Add it to `answerQualityCases.js`:
   ```js
   {
     id: "rear-brake-caliper-torque",
     question: "What is the rear brake caliper bolt torque?",
     category: "torque",
     expect: "answered",
     mustIncludeAny: [/\b34\s*N/i, /\b25\s*ft/i], // the exact value from YOUR manual
     citationDocLike: /brake/i,                    // part of the source document name
     verified: true,
   },
   ```
3. Re-run `npm run eval:answers`.

Aim for ~15–20 verified cases covering the specs and procedures you care about most, plus a
few refusal cases. That set becomes your safety net for every future change.
