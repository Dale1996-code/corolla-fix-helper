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
- the detail panel shows the saved metadata
- the PDF opens successfully

## 4) Check Document Search

1. Open the Document Search page.
2. Search for a keyword from an uploaded document.
3. Try at least one filter such as system or favorites.

Check that:

- results appear when the keyword exists
- filters narrow the results correctly

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
2. Fill in tools, parts, safety notes, or steps.
3. Save it and open it in the detail panel.

Check that:

- the procedure saves successfully
- the detail panel shows the new content

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
