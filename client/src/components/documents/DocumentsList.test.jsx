import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { DocumentsList } from "./DocumentsList";

const baseDocument = {
  id: 1,
  title: "Brake guide",
  originalFilename: "brake.pdf",
  system: "Brakes",
  documentType: "Repair Manual",
  isFavorite: false,
  isBookmarked: false,
  extractionStatus: "completed",
  updatedAt: "2026-06-25T00:00:00Z",
  createdAt: "2026-06-25T00:00:00Z",
  tags: [],
};

function renderList(documents) {
  render(
    <DocumentsList
      documents={documents}
      selectedDocumentId={null}
      onSelectDocument={() => {}}
      onToggleFavorite={() => {}}
      favoriteUpdateState={{ documentId: null, error: null }}
    />
  );
}

test("DocumentsList shows an embedding-pending hint when a document needs embedding", () => {
  renderList([{ ...baseDocument, id: 1, embeddingPending: true }]);

  expect(screen.getByText(/embedding pending/i)).toBeInTheDocument();
});

test("DocumentsList omits the embedding-pending hint when embeddings are current", () => {
  renderList([{ ...baseDocument, id: 2, embeddingPending: false }]);

  expect(screen.queryByText(/embedding pending/i)).not.toBeInTheDocument();
});
