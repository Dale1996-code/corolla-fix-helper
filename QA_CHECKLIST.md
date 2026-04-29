# Corolla Fix Helper - Manual QA Checklist

Use this checklist after making changes so you can confirm the main v1 flows still work.

## 1) Start the app

Open a terminal in the project folder:

```powershell
cd C:\Users\daleb\source\corolla-fix-helper
npm run dev
```

Check that:

- the frontend opens at `http://localhost:5173`
- the backend health check works at `http://localhost:4000/api/health`

## 2) Check Settings

1. Open the Settings page.
2. Change one vehicle field such as trim or engine.
3. Save the vehicle profile.

Check that:

- you see a success message
- the updated value stays visible after saving
- local runtime info is shown as read-only

## 3) Check Documents

1. Open the Documents page.
2. Upload a PDF.
3. Fill in the required metadata.
4. Open the uploaded PDF from the app.

Check that:

- the upload succeeds
- the document appears in the list

### 3b) Delete a bad document import safely
1. In Documents, select an uploaded test document.
2. Click **Delete document** in the details panel.
3. Confirm the delete prompt.
4. Verify linked symptom/procedure relationships are removed for that document.
5. Verify linked notes no longer show that document in note details.

Expected:
- a clear confirmation appears before delete
- the document disappears from the list
- opening the document URL now returns not found
- no stale document links remain in symptoms, procedures, or notes
- the detail panel shows the saved metadata
- the PDF opens successfully

## 4) Check Search

1. Open the Search page.
2. In the Documents section, search for a keyword from an uploaded document.
3. Try at least one Documents filter such as system or favorites.
4. Confirm the same page also shows sections for symptoms, procedures, and notes.

Check that:

- document results appear when the keyword exists
- document filters narrow the results correctly
- the Search page also shows separate sections for symptoms, procedures, and notes

## 5) Check Symptoms

1. Create a symptom.
2. Link it to a document if one is available.
3. Use the search box, a filter, and a sort option.

Check that:

- the symptom saves successfully
- the list updates
- the detail panel follows the selected symptom
- the search and filters change the visible list correctly
- the no-results message appears when filters remove everything

## 6) Check Procedures

1. Create a procedure.
2. If a document is available, link it to the procedure.
3. Fill in tools, parts, safety notes, or steps.
4. Save it and open it in the detail panel.
5. If Settings already has saved common systems, click into the System field in create or edit mode and confirm the suggestions appear.
6. Use the search box, at least one filter, and a sort option.
7. If you linked a document, open it from the procedure detail panel.
8. If you have more than one procedure, apply a filter that hides the currently selected procedure.

Check that:

- the procedure saves successfully
- the detail panel shows the new content
- the linked document appears in the detail panel and opens the correct document page
- saved system suggestions appear in the System field if they already exist in Settings
- the list shows the updated procedure count while you browse
- the search, filters, and sort controls change the visible list correctly
- the no-results message appears when filters remove everything
- the `Clear filters` button restores the full list
- the detail panel switches to a visible procedure instead of staying stuck on a hidden one

## 7) Check Notes

1. Create a note.
2. Pick a note type.
3. Link it to a document, symptom, or procedure if one is available.
4. Use the Note type filter, Linked item filter, and Sort control.
5. Open the saved note in the detail panel.

Check that:

- the note saves successfully
- the note appears in the list
- the detail panel shows the saved content
- the list shows the linked item title when the note is linked
- the note filters and sort controls change the visible list
- the "Showing X of Y notes" count updates while browsing
- the detail panel shows the linked item and can open that linked record page

## 8) Run build and tests

From the project root, run:

```powershell
cd C:\Users\daleb\source\corolla-fix-helper
npm run build
npm run test
```

Check that:

- the build finishes without errors
- the backend tests pass
- the frontend tests pass
