# Environment Variables

Environment variables are settings the app reads when it starts. They let you change paths and ports without editing code.

Use placeholder values in examples. Do not commit real secrets.

## Local Env File

For the current npm scripts, the backend runs from the `server/` folder. That means a local backend env file should be:

```text
server/.env
```

Check before creating it:

```powershell
Test-Path server\.env
```

If it does not exist, copy the placeholder example:

```powershell
Copy-Item .env.example server\.env
```

Do not overwrite an existing `server\.env` unless you have checked what is inside it.

## Current Variables

Every value below is the default the app uses when the variable is unset, except
`NODE_ENV`, which the app's own code never reads (see its entry below).

```env
NODE_ENV=production
PORT=4000
CLIENT_PORT=5173
DATABASE_FILE=./data/corolla-fix-helper.db
UPLOADS_DIR=./uploads
MAX_UPLOAD_SIZE_MB=20
NETWORK_MODE=0
ALLOWED_HOSTS=
OPENAI_API_KEY=
OPENAI_ANSWER_MODEL=gpt-5.5-2026-04-23
OPENAI_REASONING_EFFORT=low
OPENAI_MAX_OUTPUT_TOKENS=2048
OPENAI_STREAM_IDLE_TIMEOUT_MS=30000
AI_DAILY_CALL_LIMIT=500
# Model used only when an Ask request includes a saved image attachment.
# Leave blank to reuse OPENAI_ANSWER_MODEL.
OPENAI_VISION_MODEL=
# Dev-only Ask visibility. When true, Ask attaches a log-safe metrics object
# (durations, counts, sizes, numeric IDs — never document text) to the service
# result and the /api/ask response, and `npm run eval:answers` prints per-case
# timings. Off by default so the response shape is unchanged in normal use.
ASK_DEBUG_METRICS=false
ASK_EVIDENCE_CONTRACT=true
ASK_RELEVANCE_FLOOR=false
RERANK_ENABLED=false
RERANK_CANDIDATE_LIMIT=20
RETRIEVAL_MAX_CHUNKS_PER_SOURCE=3
OPENAI_RERANK_MODEL=
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_EMBEDDING_DIMENSIONS=512
OPENAI_EMBEDDING_BATCH_SIZE=64
OCR_ENABLED=true
OCR_MIN_TEXT_CHARACTERS=20
OCR_DPI=300
OCR_LANGUAGE=eng
OCR_TESSERACT_COMMAND=tesseract
OCR_PDFTOPPM_COMMAND=pdftoppm
SEED_DEMO=
AGENT_TRACE=
```

What each one means:

- `NODE_ENV` is read by Express, not by the app: nothing in `server/src` reads it. Express takes it once at startup, and when it is anything other than `production`, Express's own fallback error page prints the error's stack trace. Since audit Stage 3 the app's JSON error handler answers every error before that fallback can, except one that happens after a response has started (a stream or a download), where Express closes the connection and sends no body. So `production` is defense in depth, and it changes nothing else in this app. The example file sets it because the Windows launcher (`start-corolla-helper.ps1`) copies `.env.example` to `server/.env` and then runs `npm start`; the Docker image sets `production` too. Unset, Express treats it as `development`.
- `PORT` is the backend port.
- `CLIENT_PORT` is the frontend dev server port. The Settings page reports it.
- `DATABASE_FILE` is the SQLite database file path.
- `UPLOADS_DIR` is where uploaded PDFs are stored.
- `MAX_UPLOAD_SIZE_MB` is the largest PDF upload size in megabytes.
- `NETWORK_MODE` decides who can reach the app. The default `0` binds to `127.0.0.1`, so only this computer can. `1` listens on every interface so a phone on your Wi-Fi or Tailscale can reach it; the app still has no login. See [mobile-access.md](mobile-access.md).
- `ALLOWED_HOSTS` lists extra names for this computer, comma-separated, for example `my-pc.local, garage-pc.home.arpa`. The app answers only to a `Host` it knows is this machine (protection against DNS rebinding): `localhost`, `127.0.0.1` and `[::1]` always, and with `NETWORK_MODE=1` also this computer's LAN and Tailscale addresses and its Tailscale MagicDNS name. Any other name gets `421` with a message naming this variable. Add a name here when you reach the app by one it cannot discover itself: an mDNS name, a router or hosts-file alias, the MagicDNS name when the `tailscale` CLI is not on `PATH`, or a VM's public address. Only hostnames are compared; a port or `http://` prefix in an entry is ignored. **Read only when `NETWORK_MODE=1`**: with `NETWORK_MODE=0` the app answers to the loopback names alone, so "only this computer" holds even when a local proxy such as `tailscale serve` relays other devices to it.
- There is no `CORS_ORIGIN` any more. The app grants no origin cross-origin access: the client calls relative `/api` URLs, and in dev the Vite proxy makes them same-origin. An old `CORS_ORIGIN` line in `server/.env` is ignored and can be deleted.
- `OPENAI_API_KEY` is the OpenAI API key used by the Ask AI feature. Settings → **AI** reports only whether it is set; the key itself is never sent to the browser.
- `OPENAI_ANSWER_MODEL` is the OpenAI model name used for generated answers. The default is the pinned snapshot `gpt-5.5-2026-04-23`. The older name `OPENAI_MODEL` is still read as a fallback when `OPENAI_ANSWER_MODEL` is unset.
- `OPENAI_REASONING_EFFORT` is the `reasoning.effort` sent to reasoning-family models (`gpt-5*`, `o1`–`o9`), which reject `temperature`; other models get `temperature: 0` instead and never see this value. The default is `low`. It applies to every Responses call: Ask's answer and question rewrite, the reranker, procedure suggestions, and every Repair Planner turn. The provider accepts `none`, `low`, `medium`, `high`, `xhigh`, and `max`, and rejects `minimal`. The app does not check the value itself, so one the provider rejects fails every reasoning-model call. Reasoning tokens are billed against `OPENAI_MAX_OUTPUT_TOKENS`, so a higher effort can use up that budget and truncate the reply, which then fails closed. Read once, when `server/src/services/openAiModelCapabilities.js` loads.
- `OPENAI_MAX_OUTPUT_TOKENS` is the `max_output_tokens` every model call sends, as accidental-spend insurance. The default is `2048`; a value that is not a positive whole number falls back to it.
- `OPENAI_STREAM_IDLE_TIMEOUT_MS` is how long the Repair Planner's streaming model call may go without receiving any bytes before it is aborted with a clear error. The default is `30000` (30 seconds); a value that is not a positive whole number falls back to it. The non-streaming calls have their own fixed 30-second timeouts and do not read it.
- `OPENAI_VISION_MODEL` is the OpenAI model used only when Ask includes one already-saved image attachment. Leave it blank to reuse `OPENAI_ANSWER_MODEL`.
- `AI_DAILY_CALL_LIMIT` is a coarse daily ceiling on OpenAI requests, as accidental-spend insurance. The default is `500`; `0` disables the ceiling. The daily counter behind it is what Settings → **AI** shows as "AI calls today": it counts individual **provider requests** — Responses API calls and embedding requests alike — not questions asked. One Ask can send a question embedding, a rewrite, a rerank, and an answer; a Repair Planner run sends one per agent turn plus up to one embedding per document search. A call the ceiling refuses is never sent and is not counted: Ask answers it with HTTP 429, and the Repair Planner, whose stream is already open, with an `error` frame carrying the daily-limit message.
  - **Embeddings count (owner decision D4).** `npm run embed:backfill` counts one request per batch of `OPENAI_EMBEDDING_BATCH_SIZE` chunks, against its own process's counter. At the default batch size of 64, re-embedding the whole 20,447-chunk corpus is about 320 requests, inside the default ceiling. With a smaller batch size, or a larger corpus, the backfill can stop at the ceiling with the daily-limit message; every finished batch is already committed, so run it again (a new process starts a new count) or raise the limit for that run. Counting continues even when the ceiling is disabled. The count resets at **local** midnight and when the server restarts, because the counter is held in memory rather than in SQLite.
- `ASK_DEBUG_METRICS` enables development-only Ask visibility when set to `true`. It adds a log-safe metrics object to `/api/ask` responses and answer-eval output. The object contains durations, counts, sizes, and numeric identifiers, never document text. It also reports `rejected[]`, the sanitized reasons the evidence verifier removed a claim, guidance line, or gap — enough to tell a false rejection from a genuine "not in the documents", and never the rejected text or the unsupported specification values themselves. See `docs/api.md` for the exact fields. The default is `false`.
- `ASK_EVIDENCE_CONTRACT` enables Ask's verified, structured evidence response. The default is `true`: document-supported claims need a real source, a verbatim quote, every claimed number printed in that quote in the same unit, and a matching subject wherever the subject guard can parse one (torque, capacity, pressure, clearance, thickness, voltage, resistance, engine speed, and temperature wording). Set it to `false` only when an older integration cannot yet consume the additive `evidence` fields. The compatibility response is deliberately `status: "unverified"`, returns `citations: []`, and exposes retrieved passages only as `retrievedContext`, so neither the API nor UI presents unchecked prose as document-backed. It is the one setting under which model prose is shown as the answer itself; with the contract on, model-written text still appears, labelled, as general guidance and gaps.
- `ASK_RELEVANCE_FLOOR` enforces Ask's per-chunk relevance floor when `true`. The default is `false`, and false is **shadow mode**, not "off": the floor still computes which chunks it would drop and reports that through the `ASK_DEBUG_METRICS` channel, but changes no answer. It judges only chunks with a real semantic score whose own text matches none of the question's terms, so a newly uploaded, not-yet-embedded document is never dropped. Its threshold (`0.2`) has never been calibrated on real question/answer pairs, so run `npm run eval:relevance-floor` before turning it on.
- `RERANK_ENABLED` turns the optional Ask reranker on or off. The default is `false`. When `true`, Ask retrieval over-fetches a wider candidate pool and asks the model to reorder it before the final result slice. It needs an API key; with no key, a malformed reply, or any error it silently falls back to the existing hybrid order.
- `RERANK_CANDIDATE_LIMIT` is how many fused candidates the reranker is allowed to reorder. The default is `20`.
- `RETRIEVAL_MAX_CHUNKS_PER_SOURCE` is the most chunks one logical source may contribute to a single retrieval result set. The default is `3`. A *source* is a content group, not a document id: documents whose extracted text is identical share one budget, so duplicating a PDF cannot buy extra slots. The step runs after ranking and after any reranking, so it only selects — it never reorders, never demotes the top result, and never favours or penalizes a kind of document. Chunks held back by the cap backfill any slot it leaves empty, so a question whose only relevant evidence lives in one document still gets a full result set. Set it to `0` to disable the safeguard and return the plain ranked slice. This applies to chunk retrieval (Ask, the repair planner, procedure suggestions), not to `/api/search/*`, which ranks whole records and cannot monopolize.
- `OPENAI_RERANK_MODEL` is the OpenAI model name used by the reranker. Leave blank to reuse `OPENAI_ANSWER_MODEL`.
- `OPENAI_EMBEDDING_MODEL` is the OpenAI model name used to embed document chunks and questions.
- `OPENAI_EMBEDDING_DIMENSIONS` is the embedding size stored in SQLite. The current value is `512`.
- `OPENAI_EMBEDDING_BATCH_SIZE` is how many chunks `npm run embed:backfill` sends per embedding request.
- `OCR_ENABLED` turns scanned-PDF OCR on or off. The default is `true`.
- `OCR_MIN_TEXT_CHARACTERS` is the page text threshold below which OCR is attempted.
- `OCR_DPI` is the image-rendering resolution used before OCR.
- `OCR_LANGUAGE` is the Tesseract language code. The default `eng` means English.
- `OCR_TESSERACT_COMMAND` is the Tesseract command name or full `.exe` path.
- `OCR_PDFTOPPM_COMMAND` is the Poppler `pdftoppm` command name or full `.exe` path.
- `SEED_DEMO` loads the optional sample PDF and its chunks at startup when it is set to anything other than empty, `0`, `false`, `no`, or `off`. Unset by default, so a normal workspace starts empty. `npm run demo:seed` is the one-off way to load the sample.
- `AGENT_TRACE` prints each Repair Planner span (agent step, model turn, tool call) to the server console when it is exactly `1`. Off by default. The same spans stream to the browser as `trace` frames either way; this only adds the console copy.

Because this file is normally copied to `server/.env`, the relative paths above are relative to the `server/` folder.

Most of these are read once at startup by `server/src/config.js`, which still accepts the older `OPENAI_MODEL` name as a fallback for existing local env files. Three are read elsewhere: `OPENAI_REASONING_EFFORT` by `server/src/services/openAiModelCapabilities.js`, `SEED_DEMO` by `server/src/initDatabase.js`, and `AGENT_TRACE` by `server/src/services/agent/tracing.js`. `server/src/services/aiAnswerService.js` uses the answer or vision model when it calls the OpenAI Responses API, and the Ask route exposes metrics only when the debug flag is enabled. `server/src/services/chunkEmbeddingService.js` uses the embedding model and dimensions when it calls the OpenAI Embeddings API.

## Read Only By Scripts And Tests

These are not app settings, and `.env.example` leaves them out.

- `EVAL_CASE_DELAY_MS` is how long the paid answer runs, `npm run eval:answers` and `npm run eval:capture`, wait between cases, in milliseconds, so a run stays under the provider's per-minute token limit. The default is `2000`. A rate-limited case (HTTP 429) is retried up to four times rather than recorded as a failure.
- `INIT_CWD` is set by npm to the folder you ran `npm` from. `npm run eval:capture` and `npm run eval:replay` resolve a relative path you give them (`--output-dir`, a capture file) from it, because the root scripts run them from `server/`. You do not set it.
- `NODE_TEST_CONTEXT` is set by Node's own test runner (`node --test`) on every test process. When it is present, `server/src/config.js` does not read `server/.env`, so no suite can pick up the real API key or `NETWORK_MODE`. Never set it yourself: the app would then ignore your `server/.env`.
- `SystemRoot` and `SystemDrive` are set by Windows. `server/src/services/tarExecutable.js` uses them to find the native `tar.exe` for backups.
- The smoke test and the retrieval and rerank evals point `DATABASE_FILE` and `UPLOADS_DIR` at a throwaway folder inside their own process, so they never touch your real data. The smoke test also blanks `OPENAI_API_KEY` and `SEED_DEMO`, turns `OCR_ENABLED` off, and sets `PORT=0`. You do not set these for them.

Keep `OPENAI_API_KEY` blank in committed examples. Put the real key only in your local `server/.env` file or in the VM/container environment.

If `OPENAI_API_KEY` is not set, the Ask feature still checks uploaded document chunks with keyword retrieval. When matching chunks exist, `/api/ask` returns `status: "ai_not_configured"` and the UI explains that AI is not configured. When the documents do not contain enough matching information, the app returns `not in documents` instead.

After importing or re-extracting PDFs with an OpenAI key configured, run:

```powershell
npm run embed:backfill
```

This embeds chunks that are missing the active `OPENAI_EMBEDDING_MODEL` and `OPENAI_EMBEDDING_DIMENSIONS` pair, and skips chunks already stored at the current embedding version.

OCR is local. It does not use OpenAI. When a PDF page has very little normal text, the backend uses Poppler `pdftoppm` to render that page to an image, then uses Tesseract to read text from the image. If either tool is missing, text PDFs still import normally, and scanned PDFs get an extraction status starting with `ocr_unavailable:`. The Docker runtime image installs both tools, so OCR works in a container by default; you only need to install them yourself for non-Docker (for example local Windows) setups.

## Google Compute Engine Values

For the intended Docker-on-VM deployment, pass env values to Docker instead of storing secrets in the repo:

```bash
-e NODE_ENV=production
-e PORT=4000
-e DATABASE_FILE=/data/corolla-fix-helper.db
-e UPLOADS_DIR=/data/uploads
-e MAX_UPLOAD_SIZE_MB=20
-e OPENAI_API_KEY=placeholder-openai-key
-e OPENAI_ANSWER_MODEL=gpt-5.5-2026-04-23
-e OPENAI_EMBEDDING_MODEL=text-embedding-3-small
-e OPENAI_EMBEDDING_DIMENSIONS=512
-e OPENAI_EMBEDDING_BATCH_SIZE=64
-e OCR_ENABLED=true
-e OCR_TESSERACT_COMMAND=tesseract
-e OCR_PDFTOPPM_COMMAND=pdftoppm
```

The `/data` path should be mounted to a persistent folder on the VM.

Inside a container the app cannot see the VM's own addresses: the only LAN address it finds is the container's. To open it by the VM's IP or a DNS name, also pass `-e NETWORK_MODE=1` (so it listens on the container's interface at all) and `-e ALLOWED_HOSTS=VM_PUBLIC_IP` (or the DNS name). `http://localhost:4000` on the VM itself works without `ALLOWED_HOSTS`.

Do not paste a real key into documentation, commits, screenshots, or pull request text.
