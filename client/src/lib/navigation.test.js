import { describe, expect, test } from "vitest";
import { buildDocumentFileLink, buildEntityLink, documentSourceName } from "./navigation";

describe("buildEntityLink", () => {
  test("routes each entity type to its library anchor", () => {
    expect(buildEntityLink("document", 42)).toBe("/documents?documentId=42#document-library");
    expect(buildEntityLink("symptom", 7)).toBe("/symptoms?symptomId=7#symptom-library");
    expect(buildEntityLink("procedure", 7)).toBe("/procedures?procedureId=7#procedure-library");
    expect(buildEntityLink("note", 7)).toBe("/notes?noteId=7#note-library");
  });

  test("falls back to the dashboard without an id", () => {
    expect(buildEntityLink("document", null)).toBe("/dashboard");
  });
});

describe("buildDocumentFileLink", () => {
  test("targets the cited page of the stored PDF", () => {
    expect(buildDocumentFileLink(42, 3)).toBe("/api/documents/42/file#page=3");
  });

  test("still opens the document when there is no page number", () => {
    expect(buildDocumentFileLink(42)).toBe("/api/documents/42/file");
    expect(buildDocumentFileLink(42, null)).toBe("/api/documents/42/file");
  });

  // A page number the server could not vouch for must never become a fragment;
  // the document itself is still worth opening.
  test("drops a page number that is not a positive integer", () => {
    for (const pageNumber of [0, -3, 2.5, "3", "3 OR 1=1", NaN, Infinity, true, {}, []]) {
      expect(buildDocumentFileLink(42, pageNumber)).toBe("/api/documents/42/file");
    }
  });

  test("refuses to build a link without a validated document id", () => {
    for (const documentId of [0, -1, 1.5, "42", "42/../../etc", null, undefined, true, {}]) {
      expect(buildDocumentFileLink(documentId, 3)).toBeNull();
    }
  });

  // The href is assembled from two validated numbers, so there is no channel
  // through which a model-supplied title, filename, or URL could reach it.
  test("builds only same-origin document file paths", () => {
    for (const link of [buildDocumentFileLink(42, 3), buildDocumentFileLink(42)]) {
      expect(link.startsWith("/api/documents/")).toBe(true);
      expect(link).toMatch(/^\/api\/documents\/\d+\/file(#page=\d+)?$/);
    }
  });
});

describe("documentSourceName", () => {
  test("prefers the document title over the uploaded filename", () => {
    expect(
      documentSourceName({ documentTitle: "Lubrication System", originalFilename: "chunk_001.pdf" })
    ).toBe("Lubrication System");
  });

  test("falls back to the uploaded filename", () => {
    expect(documentSourceName({ documentTitle: "   ", originalFilename: "oil.pdf" })).toBe(
      "oil.pdf"
    );
  });

  test("uses a neutral label when nothing displayable is known", () => {
    expect(documentSourceName({})).toBe("Source document");
    expect(documentSourceName(null)).toBe("Source document");
    expect(documentSourceName({ documentTitle: 42, originalFilename: [] })).toBe(
      "Source document"
    );
  });
});
