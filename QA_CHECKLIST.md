# Corolla Fix Helper Manual QA Checklist

Use this after changes to confirm the main app still works. Manual QA means checking the app by hand in a browser.

## 1. Start The App

```powershell
cd C:\Users\daleb\source\corolla-fix-helper
npm run dev
```

Check:

- Frontend opens at `http://localhost:5173`.
- Backend health check works at `http://localhost:4000/api/health`.
- The sidebar shows Dashboard, Documents, Search, Symptoms, Procedures, Notes, and Settings.

## 2. Settings

1. Open Settings.
2. Change one vehicle value, such as trim or engine.
3. Save the vehicle profile.
4. Save a simple document default, such as a common system name.
5. Click **Export backup (.tar.gz)**.

Check:

- Save messages appear.
- Runtime values are shown as read-only.
- Backup export downloads a `.tar.gz` file.
- No secret values appear in the browser.

## 3. Documents

1. Open Documents.
2. Upload a fake or sample PDF.
3. Fill in the required metadata.
4. Open the uploaded PDF from the detail panel.
5. Click **Re-run extraction**.
6. Mark the document as a favorite.
7. Edit document metadata.

Check:

- Upload succeeds.
- The document appears in the list.
- Extraction status and page count are shown.
- The PDF opens from the app.
- Re-run extraction finishes with a clear success or error message.
- Favorites and metadata changes persist after refresh.

## 4. Document Delete Cleanup

Use a test document, not important data.

1. Link the document to a symptom, a procedure, and a note.
2. Delete the document from Documents.
3. Confirm the delete prompt.

Check:

- The document disappears from the list.
- The old PDF URL no longer opens.
- Linked symptom and procedure relationships are removed.
- Linked notes no longer show a stale document link.

## 5. Search

1. Open Search.
2. Search the Documents section for text from an uploaded PDF.
3. Search the Symptoms, Procedures, and Notes sections.
4. Try one filter in each section.

Check:

- Each Search section has its own controls.
- Results narrow correctly.
- Result links open the matching item.
- Empty states are clear when no result matches.

## 6. Ask Your Documents

Use a fake or sample PDF with text you can safely test.

1. Open Search.
2. Ask a question that should be answered by text in the uploaded PDF.
3. Ask a question that the uploaded PDFs cannot answer.

Check:

- If `OPENAI_API_KEY` is configured, the answer uses uploaded document text and shows citations.
- If `OPENAI_API_KEY` is not configured, a supported question shows an AI-not-configured message.
- Unsupported questions show a not-enough-information message.

## 7. Symptoms

1. Create a symptom.
2. Link it to a document if one exists.
3. Use search, filters, and sorting.
4. Edit the symptom.
5. Delete a test symptom.

Check:

- The list and detail panel update correctly.
- Linked documents open the correct document page.
- Counts and empty states make sense.

## 8. Procedures

1. Create a procedure.
2. Add steps, tools, parts, safety notes, difficulty, and confidence.
3. Link it to a document if one exists.
4. Use search, filters, and sorting.
5. Edit and delete a test procedure.

Check:

- The saved content appears in the detail panel.
- Linked documents open correctly.
- Saved Settings system suggestions appear in create or edit fields.

## 9. Notes

1. Create a note.
2. Pick a note type.
3. Link it to a document, symptom, or procedure if one exists.
4. Use note type filter, linked item filter, and sorting.
5. Edit and delete a test note.

Check:

- The note appears in the list.
- The detail panel shows the linked item.
- The linked item opens from the note detail panel.

## 10. Build And Tests

```powershell
cd C:\Users\daleb\source\corolla-fix-helper
npm run lint
npm run typecheck
npm run build
npm run test
```

Check:

- Lint finishes without errors.
- Typecheck finishes without errors for the changed server files.
- The build finishes without errors.
- Backend tests pass.
- Frontend tests pass.

## 11. Bulk Import Smoke Test

Use a small folder with fake or safe PDFs first.

```powershell
cd C:\Users\daleb\source\corolla-fix-helper
npm run import -- "C:\path\to\test-pdfs"
```

Check:

- The report shows imported, skipped, failed, and `IMAGE-ONLY` counts.
- Running the same command again skips already imported PDFs instead of duplicating them.
- Imported PDFs appear in the Documents page.
- Text PDFs create searchable chunks for Ask Your Documents.

## 12. Local Production Smoke Test

```powershell
cd C:\Users\daleb\source\corolla-fix-helper
npm run build
npm start
```

Check:

- The app opens at `http://localhost:4000`.
- `http://localhost:4000/api/health` returns OK.
- Browser refresh works on a frontend route such as `/documents`.

For cloud deployment checks, use `docs/gcp-deployment.md`. No actual deployment is assumed by this checklist.
