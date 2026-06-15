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
- Notes linked to one document, symptom, or procedure
- Settings for vehicle profile, document defaults, runtime information, and backup export
- Root build and test commands
- Production serving of the built frontend from the Express backend
- Docker image build path for a Google Compute Engine VM

## Current Limits

These are not implemented in the current app:

- User accounts or login
- Cloud sync
- Multi-vehicle support
- Direct symptom-to-procedure links
- Automatic restore from backup export
- General AI chat outside uploaded documents
- Current verified deployment from this branch

## Best Next Work

Recommended next steps:

1. Run a backup and restore drill with fake data.
2. Add a small production smoke test that checks the built app and main routes.
3. Harden the Google Compute Engine deployment path with access control and HTTPS before sharing a public URL.
4. Add a simple restore guide or restore script for exported backups.
5. Keep docs updated whenever a feature changes, especially deployment and storage behavior.

## Current RAG Status And Next AI Work

RAG means retrieval-augmented generation: the app retrieves matching document text first, then asks an AI model to answer using only that context.

The first document Q&A version is now partially implemented:

- The Search page has an "Ask your documents" panel.
- Uploaded and re-extracted PDFs are split into `document_chunks`.
- `POST /api/ask` accepts a question and returns an answer status, answer text, and citations.
- Retrieval fuses keyword ranking with in-memory cosine search over SQLite-stored embedding BLOBs.
- The answer service uses OpenAI when `OPENAI_API_KEY` is configured.
- The app returns clear no-key and not-enough-information states.
- Backend and frontend tests cover the main Ask states.
- `npm run eval:retrieval` proves hybrid retrieval fixes keyword wrong-page cases against a 12-item eval set with 2,500 distractor documents.

A second AI feature, the Repair Planner, is also implemented:

- The Repair Planner page streams a multi-step, tool-calling agent run as it works.
- `POST /api/repair-plan` responds with Server-Sent Events (`status`, `tool_call`, `text_delta`, `done`).
- Deterministic tools assemble a prioritized plan, readiness score, owner checklist, handoff drafts, and follow-up questions.
- It stays grounded in uploaded documents through the same retriever as Ask, so it is not general AI chat.
- Like Ask, the model client and retriever are injectable, so backend tests run without an API key.

Future AI work should stay small and evidence-based:

- Add real-manual eval cases as the local PDF library grows.
- Add an admin or maintenance path for rebuilding chunks if the schema changes.
- Keep real API keys outside Git and document only placeholder env values.
