# Corolla Fix Helper Roadmap

This roadmap separates current code from future ideas. A checked item here should mean the current repo supports it, not just that it was planned.

## Current V1 Baseline

The current app supports:

- Local SQLite database storage
- Local uploaded PDF storage
- Dashboard
- Documents, including PDF upload, metadata editing, favorites, document delete cleanup, PDF open links, and single-document extraction re-run
- Search across documents, symptoms, procedures, and notes using separate Search page sections
- "Ask your documents" Q&A using uploaded PDF chunks, hybrid keyword+embedding retrieval, OpenAI answer generation, and citations
- Repair Planner, a document-grounded streaming agent that turns a repair brief into a prioritized plan, readiness score, owner checklist, and handoff drafts (`POST /api/repair-plan`, Server-Sent Events)
- Symptoms linked to documents
- Procedures linked to documents
- Direct symptom-to-procedure links, managed from either detail view, plus AI-assisted "Suggest fixes" that ranks existing procedures for a symptom and stays grounded in uploaded document chunks (with a deterministic keyword/system fallback that needs no API key)
- Notes linked to one document, symptom, or procedure
- Image attachments (JPEG, PNG, WebP) on symptoms, procedures, and notes, with per-entity upload, view, and delete, and cleanup when the owning record is deleted
- Settings for vehicle profile, document defaults, runtime information, and backup export
- Restore from an exported backup with archive validation, a pre-restore snapshot, atomic swap, and rollback on failure (`npm run restore`), plus a `npm run backup:drill` round-trip check
- Root build and test commands
- Production serving of the built frontend from the Express backend
- Docker image build path for a Google Compute Engine VM

## Current Limits

These are not implemented in the current app:

- User accounts or login
- Cloud sync
- Multi-vehicle support
- General AI chat outside uploaded documents
- Current verified deployment from this branch

## Best Next Work

Recommended next steps:

1. Add a small production smoke test that checks the built app and main routes.
2. Harden the Google Compute Engine deployment path with access control and HTTPS before sharing a public URL.
3. Keep docs updated whenever a feature changes, especially deployment and storage behavior.

Done: the backup/restore loop is now closed — restore from an exported backup
(`npm run restore`), a backup + restore drill with fake data
(`npm run backup:drill`), and a restore guide (`docs/backup-restore.md`).

## Current RAG Status And Next AI Work

RAG means retrieval-augmented generation: the app retrieves matching document text first, then asks an AI model to answer using only that context.

The first document Q&A version is now partially implemented:

- The Search page has an "Ask your documents" panel.
- Uploaded and re-extracted PDFs are split into `document_chunks`.
- `POST /api/ask` accepts a question and returns an answer status, answer text, and citations.
- Ask can optionally include one already-saved image attachment by `attachmentId` (Vision Ask) so the model can see a photo of the symptom or part. Retrieval still runs on the text question only, images never enter `document_chunks`, documents stay PDF-only, and every spec, torque value, capacity, tool, step, and warning still comes only from retrieved PDF chunks. The vision request uses `OPENAI_VISION_MODEL`, which defaults to the answer model.
- Retrieval fuses keyword ranking with in-memory cosine search over SQLite-stored embedding BLOBs.
- An optional LLM reranker can reorder the fused candidates before the final result slice. It is **off by default** (`RERANK_ENABLED=false`), bounded by `RERANK_CANDIDATE_LIMIT`, and falls back to the existing hybrid order whenever it is disabled, has no API key, or returns anything malformed — so it never breaks a working Ask request.
- The answer service uses OpenAI when `OPENAI_API_KEY` is configured.
- The app returns clear no-key and not-enough-information states.
- Backend and frontend tests cover the main Ask states, including the reranker's parse/fallback paths.
- `npm run eval:retrieval` proves hybrid retrieval fixes keyword wrong-page cases against a 12-item eval set with 2,500 distractor documents.
- `npm run eval:rerank` A/B-compares fusion-only against reranked retrieval (real key optional; a no-key run shows the reranker is a safe no-op).
- `server/src/evals/answerQualityCases.js` now spans the major systems (engine, brakes, cooling, electrical, suspension, transmission, fuel, HVAC) plus a Vision Ask refusal guard. The new cases are `verified: false` templates until confirmed against the real manuals, so they report but do not gate CI.

A second AI feature, the Repair Planner, is also implemented:

- The Repair Planner page streams a multi-step, tool-calling agent run as it works.
- `POST /api/repair-plan` responds with Server-Sent Events (`status`, `tool_call`, `text_delta`, `done`).
- Deterministic tools assemble a prioritized plan, readiness score, owner checklist, handoff drafts, and follow-up questions.
- It stays grounded in uploaded documents through the same retriever as Ask, so it is not general AI chat.
- Like Ask, the model client and retriever are injectable, so backend tests run without an API key.

A third, smaller AI-assisted feature now suggests existing procedures for a symptom:

- `GET /api/symptoms/:id/suggested-procedures` ranks stored procedures for a symptom and links them to retrieved document chunks.
- It reuses the Ask retriever and stays grounded in uploaded PDFs; it never invents a procedure and only suggests links to procedures that already exist.
- Without `OPENAI_API_KEY` it degrades to a deterministic keyword/system overlap ranking, so it still returns useful suggestions. With a key, the model ranks the candidates and every suggestion must cite a retrieved chunk, otherwise it falls back to the deterministic ranking.
- The symptom and procedure detail views can also link the two directly in either direction.

Future AI work should stay small and evidence-based:

- Confirm the new system-coverage answer templates against the real manuals and flip the good ones to `verified: true`.
- Measure the reranker on real manuals with a key (`npm run eval:rerank`) before considering turning `RERANK_ENABLED` on by default.
- A cheaper first-stage tuning pass (term proximity, RRF weights, exact-phrase weighting) was deliberately left alone for now: the hybrid fusion order is pinned by the exact-match retrieval eval, so any change there needs its own eval evidence first.
- Add real-manual eval cases as the local PDF library grows.
- Add an admin or maintenance path for rebuilding chunks if the schema changes.
- Keep real API keys outside Git and document only placeholder env values.
