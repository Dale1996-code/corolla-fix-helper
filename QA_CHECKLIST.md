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
- The sidebar shows Dashboard, Documents, Ask AI, Repair Planner, Symptoms, Procedures, Notes, Checklists, and Settings.

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
7. Click **Bookmark** to flag the document.
8. Edit document metadata and add a few comma separated tags.
9. Filter the list by Bookmark and by Tag.

Check:

- Upload succeeds.
- The document appears in the list.
- Extraction status and page count are shown.
- The PDF opens from the app.
- Re-run extraction finishes with a clear success or error message and refreshes searchable chunks.
- Favorites, bookmarks, tags, and metadata changes persist after refresh.
- Bookmark and Tag filters narrow the list as expected, and tag chips show on the cards.

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

## 5. Search Sections

1. Open Search.
2. Search the Documents section for text from an uploaded PDF.
3. Search the Symptoms, Procedures, and Notes sections.
4. Try one filter in each section.

Check:

- Each Search section has its own controls.
- Results narrow correctly.
- Result links open the matching item.
- Empty states are clear when no result matches.

## 6. Ask AI

Use a fake or sample PDF with text you can safely test.

1. Open Ask AI.
2. Run `npm run embed:backfill` if `OPENAI_API_KEY` is configured and the PDF was imported or re-extracted.
3. Ask a question that should be answered by text in the uploaded PDF.
4. Ask a question that the uploaded PDFs cannot answer.

Check:

- If `OPENAI_API_KEY` is configured, the answer uses uploaded document text and shows citations.
- If `OPENAI_API_KEY` is not configured, a supported question shows an AI-not-configured message.
- Unsupported questions show a not-enough-information message.
- `npm run eval:retrieval` reports keyword wrong, hybrid right for all eval cases.

### Vision Ask (optional saved image)

First save at least one image attachment on a symptom, procedure, or note (see section 12) so the Ask panel has a photo to choose.

1. In the Ask panel, confirm a "saved photo" selector lists your saved attachments.
2. Select one; confirm its thumbnail appears next to the question input and that "Remove photo" clears it.
3. With a photo selected, ask a question the PDFs can answer.
4. With no photo selected, ask the same kind of question (text-only Ask).

Check:

- Text-only Ask is unchanged: leaving the selector on "No photo" sends no `attachmentId` and behaves exactly as before.
- With a photo selected and `OPENAI_API_KEY` configured, the answer may mention what is visible in the photo, but every spec, torque value, capacity, tool, step, and warning is still drawn from PDF chunks and cited.
- An unsupported question still returns the not-found message even with a photo attached (the image does not invent an answer).
- A request whose `attachmentId` is invalid (non-positive) returns a clear 400-style error and never calls the model.
- A request whose attachment record or image file is missing returns a clear 404-style error and never calls the model.
- Without `OPENAI_API_KEY`, Ask shows the same AI-not-configured message whether or not a photo is attached.

## 7. Repair Planner

Use a fake or sample PDF so the agent has manuals to cite.

1. Open Repair Planner.
2. Enter a repair brief, skill level, available tools, and available parts.
3. Click **Build repair plan**.
4. Submit with an empty brief to confirm the validation message.

Check:

- The agent activity log shows tool calls and results while it runs.
- The prioritized plan text streams in progressively.
- Readiness, owner checklist, extracted tasks, handoff drafts, and sources cards appear when finished.
- Source cards open the matching document page.
- If `OPENAI_API_KEY` is not configured, an AI-not-configured banner appears and nothing crashes.
- See `docs/repair-planner.md` for the full validation checklist and the live key-backed check.

## 8. Repair Checklists

Use a test checklist, not an important repair record.

1. Open **Checklists** and observe the initial loading state.
2. Create a checklist with a title, description, notes, and each available status:
   `planned`, `in_progress`, `blocked`, or `done`.
3. Select the checklist, edit its title, description, notes, and status, then save.
4. Add several items, edit an item's text, check an item, uncheck it, move items
   Up and Down, and delete a test item.
5. Create or update a second checklist, then confirm the checklist with the
   newest activity appears first in the list. An item write should update the
   parent checklist's activity time too.
6. Use the browser Network panel while saving. Each successful create, metadata
   edit, item add/edit/check/move/delete, or status change should update the
   visible checklist from the returned whole-checklist payload without an
   unnecessary second `GET /api/repair-checklists` request.
7. Test an empty database/list, a slow first load, and a failed list or write
   request.

Check:

- The sidebar label is **Checklists** and the page opens at `/repair-checklists`.
- Loading, empty, success, and failure messages are clear and do not leave stale
  data or banners on another selected checklist.
- Creating and editing metadata persists title, description, notes, and status.
- Items remain in their saved order, and Up/Down changes that order.
- Check and uncheck updates the item and the done count.
- Successful writes apply the server-returned full checklist in place; the UI
  does not refetch the entire list unnecessarily.

## 9. Symptoms

1. Create a symptom.
2. Link it to a document if one exists.
3. Use search, filters, and sorting.
4. Edit the symptom.
5. Delete a test symptom.

Check:

- The list and detail panel update correctly.
- Linked documents open the correct document page.
- Counts and empty states make sense.

## 10. Procedures

1. Create a procedure.
2. Add steps, tools, parts, safety notes, difficulty, and confidence.
3. Link it to a document if one exists.
4. Use search, filters, and sorting.
5. Edit and delete a test procedure.

Check:

- The saved content appears in the detail panel.
- Linked documents open correctly.
- Saved Settings system suggestions appear in create or edit fields.

## 11. Notes

1. Create a note.
2. Pick a note type.
3. Link it to a document, symptom, or procedure if one exists.
4. Use note type filter, linked item filter, and sorting.
5. Edit and delete a test note.

Check:

- The note appears in the list.
- The detail panel shows the linked item.
- The linked item opens from the note detail panel.

## 12. Image Attachments

Use test symptoms, procedures, and notes, not important data. Attachments are
image-only; documents stay PDF-only and are not affected.

1. Open a symptom detail panel and find the **Photos** section.
2. Upload a JPEG, PNG, or WebP image, optionally with a caption.
3. Click the thumbnail to open the full image, then click **Remove** to delete it.
4. Try uploading a non-image file (for example a `.txt` or `.pdf`).
5. Repeat the upload on a procedure and on a note detail panel.
6. Attach an image to a test symptom, then delete that symptom.

Check:

- The uploaded image appears as a thumbnail in the Photos section after upload.
- The thumbnail opens the stored image inline.
- Remove deletes the image from the panel.
- A non-image file is rejected with a clear "image" error and nothing is saved.
- Procedures and notes show the same Photos panel and behavior.
- Deleting the owning symptom, procedure, or note removes its attachments, and
  `UPLOADS_DIR/attachments/images/` no longer holds the orphaned files.
- `npm run backup:drill` still passes and reports that the attachment image came
  back intact.

## 13. Build And Tests

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

## 14. Bulk Import Smoke Test

Use a small folder with fake or safe PDFs first.

```powershell
cd C:\Users\daleb\source\corolla-fix-helper
npm run import -- "C:\path\to\test-pdfs"
```

Check:

- The report shows imported, skipped, failed, and `IMAGE-ONLY` counts.
- Running the same command again skips already imported PDFs instead of duplicating them.
- Imported PDFs appear in the Documents page.
- Text PDFs and OCR-readable scanned PDFs create searchable chunks for Ask Your Documents.
- If OCR tools are missing, scanned PDFs show a clear `ocr_unavailable:` extraction status instead of breaking text-PDF imports.

## 15. Local Production Smoke Test

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
