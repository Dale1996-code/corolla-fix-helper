import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { SearchPage } from "./SearchPage";

function jsonResponse(payload, ok = true) {
  return Promise.resolve({
    ok,
    json: async () => payload,
  });
}

function emptySearchResponse(filters = {}) {
  return {
    results: [],
    total: 0,
    filters,
  };
}

function createEmptySearchFetchMock() {
  return vi.fn((url) => {
    if (url === "/api/search/documents?sort=relevance&limit=25") {
      return jsonResponse(
        emptySearchResponse({
          systems: ["Engine"],
          documentTypes: ["Reference"],
        })
      );
    }

    if (url === "/api/search/symptoms?sort=newest") {
      return jsonResponse(
        emptySearchResponse({
          systems: ["Engine"],
          statuses: ["monitoring"],
        })
      );
    }

    if (url === "/api/search/procedures?sort=newest") {
      return jsonResponse(
        emptySearchResponse({
          systems: ["Engine"],
          difficulties: ["beginner"],
        })
      );
    }

    if (url === "/api/search/notes?sort=newest") {
      return jsonResponse(
        emptySearchResponse({
          noteTypes: ["observation"],
          relatedEntityTypes: ["symptom"],
        })
      );
    }

    if (url === "/api/attachments/all") {
      return jsonResponse({ attachments: [], total: 0 });
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  });
}

function createPendingPromise() {
  return new Promise(() => {});
}

// Wrap the empty-search mock with a populated saved-photo list and an Ask
// responder so the Vision Ask tests can drive the attachment selector.
function createFetchMockWithAttachments(attachments, askResponder) {
  const base = createEmptySearchFetchMock();

  return vi.fn((url, options) => {
    if (url === "/api/attachments/all") {
      return jsonResponse({ attachments, total: attachments.length });
    }

    if (url === "/api/ask") {
      return askResponder(options);
    }

    return base(url, options);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("SearchPage shows the Ask panel empty state above document search", async () => {
  const fetchMock = createEmptySearchFetchMock();
  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askHeading = await screen.findByRole("heading", {
    name: "Ask your documents",
  });
  const documentsHeading = screen.getByRole("heading", { name: "Documents" });
  expect(askHeading.compareDocumentPosition(documentsHeading)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING
  );

  const askSection = askHeading.closest("section");
  expect(askSection).not.toBeNull();
  expect(
    within(askSection).getByText("Type a question about your uploaded documents to begin.")
  ).toBeInTheDocument();

  fireEvent.click(within(askSection).getByRole("button", { name: "Ask" }));

  expect(
    within(askSection).getByText("Enter a question before asking.")
  ).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalledWith(
    "/api/ask",
    expect.objectContaining({ method: "POST" })
  );
});

test("SearchPage discloses that the question and PDF excerpts are sent to OpenAI", async () => {
  const fetchMock = createEmptySearchFetchMock();
  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askHeading = await screen.findByRole("heading", {
    name: "Ask your documents",
  });
  const askSection = askHeading.closest("section");

  expect(
    within(askSection).getByText(/sent to\s+OpenAI to generate an answer/i)
  ).toBeInTheDocument();
});

test("SearchPage shows loading state while Ask waits for an answer", async () => {
  const baseSearchFetchMock = createEmptySearchFetchMock();
  const fetchMock = vi.fn((url, options) => {
    if (url === "/api/ask") {
      return createPendingPromise();
    }

    return baseSearchFetchMock(url, options);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askSection = (
    await screen.findByRole("heading", { name: "Ask your documents" })
  ).closest("section");
  expect(askSection).not.toBeNull();

  fireEvent.change(within(askSection).getByRole("textbox", { name: "Question" }), {
    target: { value: "What is the oil drain plug torque?" },
  });
  fireEvent.click(within(askSection).getByRole("button", { name: "Ask" }));

  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/ask",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: "What is the oil drain plug torque?",
          history: [],
        }),
      })
    );
  });

  expect(
    within(askSection).getByRole("button", { name: "Asking..." })
  ).toBeDisabled();
  expect(within(askSection).getByText("Asking your documents...")).toBeInTheDocument();
});

test("SearchPage shows AI not configured state from Ask response", async () => {
  const baseSearchFetchMock = createEmptySearchFetchMock();
  const fetchMock = vi.fn((url, options) => {
    if (url === "/api/ask") {
      return jsonResponse({
        question: "What is the oil drain plug torque?",
        status: "ai_not_configured",
        answer:
          "AI is not configured yet. Set OPENAI_API_KEY in the server environment to enable Ask.",
        citations: [],
      });
    }

    return baseSearchFetchMock(url, options);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askSection = (
    await screen.findByRole("heading", { name: "Ask your documents" })
  ).closest("section");
  expect(askSection).not.toBeNull();

  fireEvent.change(within(askSection).getByRole("textbox", { name: "Question" }), {
    target: { value: "What is the oil drain plug torque?" },
  });
  fireEvent.click(within(askSection).getByRole("button", { name: "Ask" }));

  expect(await within(askSection).findByText("AI not configured")).toBeInTheDocument();
  expect(
    within(askSection).getByText(
      "AI is not configured yet. Set OPENAI_API_KEY in the server environment to enable Ask."
    )
  ).toBeInTheDocument();
  expect(within(askSection).queryByText("Sources")).not.toBeInTheDocument();
});

test("SearchPage shows not-found state from Ask response", async () => {
  const baseSearchFetchMock = createEmptySearchFetchMock();
  const fetchMock = vi.fn((url, options) => {
    if (url === "/api/ask") {
      return jsonResponse({
        question: "What is the water pump torque?",
        status: "not_found",
        answer: "The uploaded documents do not contain enough information to answer that.",
        citations: [],
      });
    }

    return baseSearchFetchMock(url, options);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askSection = (
    await screen.findByRole("heading", { name: "Ask your documents" })
  ).closest("section");
  expect(askSection).not.toBeNull();

  fireEvent.change(within(askSection).getByRole("textbox", { name: "Question" }), {
    target: { value: "What is the water pump torque?" },
  });
  fireEvent.click(within(askSection).getByRole("button", { name: "Ask" }));

  expect(await within(askSection).findByText("No answer found")).toBeInTheDocument();
  expect(
    within(askSection).getByText(
      "The uploaded documents do not contain enough information to answer that."
    )
  ).toBeInTheDocument();
  expect(within(askSection).queryByText("Sources")).not.toBeInTheDocument();
});

test("SearchPage shows retrieved context on a not-found Ask response", async () => {
  const baseSearchFetchMock = createEmptySearchFetchMock();
  const contextSnippet =
    "Water pump x Timing chain cover 24 241 17 -- torque table row from the engine manual.";
  const fetchMock = vi.fn((url, options) => {
    if (url === "/api/ask") {
      return jsonResponse({
        question: "What is the water pump torque?",
        status: "not_found",
        answer: "The uploaded documents do not contain enough information to answer that.",
        // citations stays [] exactly as before; the passages arrive alongside it.
        citations: [],
        retrievedContext: [
          {
            documentId: 12,
            documentTitle: "Engine Mechanical Torque Specifications",
            originalFilename: "engine-torque.pdf",
            pageNumber: 3,
            chunkIndex: 0,
            snippet: contextSnippet,
          },
        ],
      });
    }

    return baseSearchFetchMock(url, options);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askSection = (
    await screen.findByRole("heading", { name: "Ask your documents" })
  ).closest("section");
  expect(askSection).not.toBeNull();

  fireEvent.change(within(askSection).getByRole("textbox", { name: "Question" }), {
    target: { value: "What is the water pump torque?" },
  });
  fireEvent.click(within(askSection).getByRole("button", { name: "Ask" }));

  expect(await within(askSection).findByText("No answer found")).toBeInTheDocument();

  // The recovered evidence is shown...
  expect(
    within(askSection).getByRole("heading", {
      name: "Retrieved context (may include passages the answer did not use)",
    })
  ).toBeInTheDocument();
  expect(within(askSection).getByText(contextSnippet)).toBeInTheDocument();
  expect(
    within(askSection).getByText("Engine Mechanical Torque Specifications, page 3")
  ).toBeInTheDocument();

  // ...but never as a sourced answer.
  expect(within(askSection).queryByText("Sources")).not.toBeInTheDocument();
});

test("SearchPage labels a legacy answer as unverified and never document-backed", async () => {
  const baseSearchFetchMock = createEmptySearchFetchMock();
  const fetchMock = vi.fn((url, options) => {
    if (url === "/api/ask") {
      return jsonResponse({
        question: "What is the oil filter cap torque?",
        // Old servers called this answered and put every retrieved passage in
        // citations. The current UI must downgrade that shape on its own.
        status: "answered",
        answer: "The oil filter cap torque is 27 ft-lb.",
        citations: [
          {
            documentId: 7,
            documentTitle: "Oil Manual",
            originalFilename: "oil.pdf",
            pageNumber: 1,
            chunkIndex: 0,
            snippet: "The oil drain plug torque is 27 ft-lb.",
          },
        ],
      });
    }

    return baseSearchFetchMock(url, options);
  });

  vi.stubGlobal("fetch", fetchMock);
  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askSection = (
    await screen.findByRole("heading", { name: "Ask your documents" })
  ).closest("section");
  fireEvent.change(within(askSection).getByRole("textbox", { name: "Question" }), {
    target: { value: "What is the oil filter cap torque?" },
  });
  fireEvent.click(within(askSection).getByRole("button", { name: "Ask" }));

  expect(
    await within(askSection).findByText("Unverified AI answer — not document-backed")
  ).toBeInTheDocument();
  expect(within(askSection).getByText("The oil filter cap torque is 27 ft-lb.")).toBeInTheDocument();
  expect(within(askSection).queryByText("From your documents")).not.toBeInTheDocument();
  expect(within(askSection).queryByText("Sources")).not.toBeInTheDocument();
});

test("SearchPage omits retrieved context when the response has none", async () => {
  const baseSearchFetchMock = createEmptySearchFetchMock();
  const fetchMock = vi.fn((url, options) => {
    if (url === "/api/ask") {
      return jsonResponse({
        question: "What is the water pump torque?",
        status: "not_found",
        answer: "The uploaded documents do not contain enough information to answer that.",
        citations: [],
      });
    }

    return baseSearchFetchMock(url, options);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askSection = (
    await screen.findByRole("heading", { name: "Ask your documents" })
  ).closest("section");

  fireEvent.change(within(askSection).getByRole("textbox", { name: "Question" }), {
    target: { value: "What is the water pump torque?" },
  });
  fireEvent.click(within(askSection).getByRole("button", { name: "Ask" }));

  expect(await within(askSection).findByText("No answer found")).toBeInTheDocument();
  expect(
    within(askSection).queryByText(/Retrieved context/)
  ).not.toBeInTheDocument();
});

test("SearchPage renders evidence-contract channels as distinct blocks", async () => {
  const baseSearchFetchMock = createEmptySearchFetchMock();
  const fetchMock = vi.fn((url, options) => {
    if (url === "/api/ask") {
      return jsonResponse({
        question: "What is the oil drain plug torque?",
        status: "partial",
        answer: "UNSUPPORTED RAW ANSWER: use 99 Nm.",
        citations: [
          {
            documentId: 7,
            documentTitle: "Oil Manual",
            originalFilename: "oil.pdf",
            pageNumber: 1,
            chunkIndex: 0,
            snippet: "Torque : 37 Nm (377 kgf-cm, 27 ft-lbf)",
          },
        ],
        evidence: {
          documentSupported: [
            {
              claim: "The oil drain plug torque is 37 Nm.",
              evidenceQuote: "Torque : 37 Nm (377 kgf-cm, 27 ft-lbf)",
              documentId: 7,
              documentTitle: "Oil Manual",
              pageNumber: 1,
              chunkIndex: 0,
            },
          ],
          generalGuidance: ["Let the engine cool before draining the oil."],
          gaps: ["The filter torque is not covered."],
        },
        retrievedContext: [
          {
            documentId: 99,
            documentTitle: "Unused Manual",
            pageNumber: 8,
            chunkIndex: 3,
            snippet: "UNUSED PASSAGE",
          },
        ],
      });
    }

    return baseSearchFetchMock(url, options);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askSection = (
    await screen.findByRole("heading", { name: "Ask your documents" })
  ).closest("section");

  fireEvent.change(within(askSection).getByRole("textbox", { name: "Question" }), {
    target: { value: "What is the oil drain plug torque?" },
  });
  fireEvent.click(within(askSection).getByRole("button", { name: "Ask" }));

  // Document-supported claims, with the quote shown so the owner can check it.
  const supportedHeading = await within(askSection).findByRole("heading", {
    name: "From your documents",
  });
  const supportedBlock = supportedHeading.closest("section");
  expect(
    within(supportedBlock).getByText("The oil drain plug torque is 37 Nm.")
  ).toBeInTheDocument();
  expect(
    within(supportedBlock).getByText(/Torque : 37 Nm \(377 kgf-cm, 27 ft-lbf\)/)
  ).toBeInTheDocument();

  // General guidance is a visually separate, explicitly labeled channel.
  const guidanceHeading = within(askSection).getByRole("heading", {
    name: "General guidance — not from your documents",
  });
  const guidanceBlock = guidanceHeading.closest("section");
  expect(
    within(guidanceBlock).getByText("Let the engine cool before draining the oil.")
  ).toBeInTheDocument();
  expect(
    within(supportedBlock).queryByText("Let the engine cool before draining the oil.")
  ).not.toBeInTheDocument();

  // Gaps are shown rather than hidden.
  expect(
    within(askSection).getByRole("heading", { name: "Not covered by your documents" })
  ).toBeInTheDocument();
  expect(within(askSection).getByText("The filter torque is not covered.")).toBeInTheDocument();
  expect(within(askSection).queryByText(/UNSUPPORTED RAW ANSWER/)).not.toBeInTheDocument();
  expect(within(askSection).queryByText("UNUSED PASSAGE")).not.toBeInTheDocument();
});

test("SearchPage keeps distinct evidence quotes from the same source chunk", async () => {
  const baseSearchFetchMock = createEmptySearchFetchMock();
  const fetchMock = vi.fn((url, options) => {
    if (url === "/api/ask") {
      return jsonResponse({
        question: "How do I reinstall the oil drain plug?",
        status: "answered",
        answer: "RAW STRUCTURED ANSWER IS NOT RENDERED",
        citations: [
          {
            documentId: 7,
            documentTitle: "Oil Manual",
            originalFilename: "oil.pdf",
            pageNumber: 1,
            chunkIndex: 0,
            snippet: "Clean and install the oil drain plug with a new gasket.",
          },
          {
            documentId: 7,
            documentTitle: "Oil Manual",
            originalFilename: "oil.pdf",
            pageNumber: 1,
            chunkIndex: 0,
            snippet: "Torque : 37 Nm (377 kgf-cm, 27 ft-lbf)",
          },
        ],
        evidence: {
          documentSupported: [
            {
              claim: "Install the oil drain plug with a new gasket.",
              evidenceQuote: "Clean and install the oil drain plug with a new gasket.",
              documentId: 7,
              documentTitle: "Oil Manual",
              pageNumber: 1,
              chunkIndex: 0,
            },
            {
              claim: "The oil drain plug torque is 37 Nm.",
              evidenceQuote: "Torque : 37 Nm (377 kgf-cm, 27 ft-lbf)",
              documentId: 7,
              documentTitle: "Oil Manual",
              pageNumber: 1,
              chunkIndex: 0,
            },
          ],
          generalGuidance: [],
          gaps: [],
        },
      });
    }

    return baseSearchFetchMock(url, options);
  });

  vi.stubGlobal("fetch", fetchMock);
  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askSection = (
    await screen.findByRole("heading", { name: "Ask your documents" })
  ).closest("section");
  fireEvent.change(within(askSection).getByRole("textbox", { name: "Question" }), {
    target: { value: "How do I reinstall the oil drain plug?" },
  });
  fireEvent.click(within(askSection).getByRole("button", { name: "Ask" }));

  expect(
    await within(askSection).findByText("Install the oil drain plug with a new gasket.")
  ).toBeInTheDocument();
  expect(
    within(askSection).getByText("The oil drain plug torque is 37 Nm.")
  ).toBeInTheDocument();
  expect(
    within(askSection).getAllByRole("link", { name: "Open source Oil Manual Page 1" })
  ).toHaveLength(2);
});

test("SearchPage hides an answered response that has no evidence and no citations", async () => {
  const baseSearchFetchMock = createEmptySearchFetchMock();
  const fetchMock = vi.fn((url, options) => {
    if (url === "/api/ask") {
      return jsonResponse({
        question: "What is the oil drain plug torque?",
        status: "answered",
        answer: "UNSUPPORTED ANSWER WITHOUT A SOURCE",
        citations: [],
      });
    }

    return baseSearchFetchMock(url, options);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askSection = (
    await screen.findByRole("heading", { name: "Ask your documents" })
  ).closest("section");

  fireEvent.change(within(askSection).getByRole("textbox", { name: "Question" }), {
    target: { value: "What is the oil drain plug torque?" },
  });
  fireEvent.click(within(askSection).getByRole("button", { name: "Ask" }));

  expect(
    await within(askSection).findByText("Could not ask documents")
  ).toBeInTheDocument();
  expect(
    within(askSection).queryByText("From your documents")
  ).not.toBeInTheDocument();
  expect(
    within(askSection).queryByText("UNSUPPORTED ANSWER WITHOUT A SOURCE")
  ).not.toBeInTheDocument();
});

test("SearchPage hides a response whose API status is missing", async () => {
  const baseSearchFetchMock = createEmptySearchFetchMock();
  const fetchMock = vi.fn((url, options) => {
    if (url === "/api/ask") {
      return jsonResponse({
        question: "What is the oil drain plug torque?",
        answer: "UNSUPPORTED ANSWER WITH NO STATUS",
        citations: [
          {
            documentId: 7,
            documentTitle: "Oil Manual",
            originalFilename: "oil.pdf",
            pageNumber: 1,
            chunkIndex: 0,
            snippet: "Torque : 37 Nm (377 kgf-cm, 27 ft-lbf)",
          },
        ],
      });
    }

    return baseSearchFetchMock(url, options);
  });

  vi.stubGlobal("fetch", fetchMock);
  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askSection = (
    await screen.findByRole("heading", { name: "Ask your documents" })
  ).closest("section");
  fireEvent.change(within(askSection).getByRole("textbox", { name: "Question" }), {
    target: { value: "What is the oil drain plug torque?" },
  });
  fireEvent.click(within(askSection).getByRole("button", { name: "Ask" }));

  expect(
    await within(askSection).findByText("Could not ask documents")
  ).toBeInTheDocument();
  expect(
    within(askSection).queryByText("UNSUPPORTED ANSWER WITH NO STATUS")
  ).not.toBeInTheDocument();
});

test("SearchPage hides a document-supported claim whose source does not match a citation", async () => {
  const baseSearchFetchMock = createEmptySearchFetchMock();
  const fetchMock = vi.fn((url, options) => {
    if (url === "/api/ask") {
      return jsonResponse({
        question: "What is the oil drain plug torque?",
        status: "answered",
        answer: "UNSUPPORTED MISMATCHED ANSWER",
        citations: [
          {
            documentId: 8,
            documentTitle: "Different Manual",
            originalFilename: "different.pdf",
            pageNumber: 4,
            chunkIndex: 2,
            snippet: "A different passage.",
          },
        ],
        evidence: {
          documentSupported: [
            {
              claim: "The oil drain plug torque is 54 Nm.",
              evidenceQuote: "Torque is 54 Nm.",
              documentId: 7,
              documentTitle: "Oil Manual",
              pageNumber: 1,
              chunkIndex: 0,
            },
          ],
          generalGuidance: [],
          gaps: [],
        },
      });
    }

    return baseSearchFetchMock(url, options);
  });

  vi.stubGlobal("fetch", fetchMock);
  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askSection = (
    await screen.findByRole("heading", { name: "Ask your documents" })
  ).closest("section");
  fireEvent.change(within(askSection).getByRole("textbox", { name: "Question" }), {
    target: { value: "What is the oil drain plug torque?" },
  });
  fireEvent.click(within(askSection).getByRole("button", { name: "Ask" }));

  expect(
    await within(askSection).findByText("Could not ask documents")
  ).toBeInTheDocument();
  expect(within(askSection).queryByText("From your documents")).not.toBeInTheDocument();
  expect(within(askSection).queryByText(/54 Nm/)).not.toBeInTheDocument();
});

test("SearchPage hides a document-supported claim whose quote does not match its citation", async () => {
  const baseSearchFetchMock = createEmptySearchFetchMock();
  const fetchMock = vi.fn((url, options) => {
    if (url === "/api/ask") {
      return jsonResponse({
        question: "What is the oil drain plug torque?",
        status: "answered",
        answer: "UNSUPPORTED SAME-SOURCE ANSWER",
        citations: [
          {
            documentId: 7,
            documentTitle: "Oil Manual",
            originalFilename: "oil.pdf",
            pageNumber: 1,
            chunkIndex: 0,
            snippet: "Torque : 37 Nm",
          },
        ],
        evidence: {
          documentSupported: [
            {
              claim: "The oil drain plug torque is 54 Nm.",
              evidenceQuote: "Torque is 54 Nm.",
              documentId: 7,
              documentTitle: "Oil Manual",
              pageNumber: 1,
              chunkIndex: 0,
            },
          ],
          generalGuidance: [],
          gaps: [],
        },
      });
    }

    return baseSearchFetchMock(url, options);
  });

  vi.stubGlobal("fetch", fetchMock);
  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askSection = (
    await screen.findByRole("heading", { name: "Ask your documents" })
  ).closest("section");
  fireEvent.change(within(askSection).getByRole("textbox", { name: "Question" }), {
    target: { value: "What is the oil drain plug torque?" },
  });
  fireEvent.click(within(askSection).getByRole("button", { name: "Ask" }));

  expect(
    await within(askSection).findByText("Could not ask documents")
  ).toBeInTheDocument();
  expect(within(askSection).queryByText("From your documents")).not.toBeInTheDocument();
  expect(within(askSection).queryByText(/54 Nm/)).not.toBeInTheDocument();
});

test("SearchPage rejects matching passages whose server evidence identifiers disagree", async () => {
  const baseSearchFetchMock = createEmptySearchFetchMock();
  const quote = "The oil drain plug torque is 27 ft-lb.";
  const fetchMock = vi.fn((url, options) => {
    if (url === "/api/ask") {
      return jsonResponse({
        question: "What is the oil drain plug torque?",
        status: "answered",
        answer: "UNSUPPORTED EVIDENCE-ID MISMATCH",
        citations: [
          {
            evidenceId: "ask_ev_v1_aaaaaaaaaaaaaaaaaaaaaaaa",
            documentId: 7,
            documentTitle: "Oil Manual",
            originalFilename: "oil.pdf",
            pageNumber: 1,
            chunkIndex: 0,
            snippet: quote,
          },
        ],
        evidence: {
          documentSupported: [
            {
              evidenceId: "ask_ev_v1_bbbbbbbbbbbbbbbbbbbbbbbb",
              claim: "The oil drain plug torque is 27 ft-lb.",
              evidenceQuote: quote,
              documentId: 7,
              documentTitle: "Oil Manual",
              pageNumber: 1,
              chunkIndex: 0,
            },
          ],
          generalGuidance: [],
          gaps: [],
        },
      });
    }

    return baseSearchFetchMock(url, options);
  });

  vi.stubGlobal("fetch", fetchMock);
  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askSection = (
    await screen.findByRole("heading", { name: "Ask your documents" })
  ).closest("section");
  fireEvent.change(within(askSection).getByRole("textbox", { name: "Question" }), {
    target: { value: "What is the oil drain plug torque?" },
  });
  fireEvent.click(within(askSection).getByRole("button", { name: "Ask" }));

  expect(await within(askSection).findByText("Could not ask documents")).toBeInTheDocument();
  expect(within(askSection).queryByText("From your documents")).not.toBeInTheDocument();
  expect(within(askSection).queryByText(/27 ft-lb/)).not.toBeInTheDocument();
});

test("SearchPage rejects a long evidence quote that only matches the citation preview", async () => {
  const sharedPrefix = "Verified manual passage ".repeat(11).slice(0, 217);
  const fabricatedQuote = `${sharedPrefix} fabricated instruction after the preview.`;
  const baseSearchFetchMock = createEmptySearchFetchMock();
  const fetchMock = vi.fn((url, options) => {
    if (url === "/api/ask") {
      return jsonResponse({
        question: "What should I do next?",
        status: "answered",
        answer: "UNSUPPORTED LONG-QUOTE ANSWER",
        citations: [
          {
            documentId: 7,
            documentTitle: "Oil Manual",
            originalFilename: "oil.pdf",
            pageNumber: 1,
            chunkIndex: 0,
            snippet: `${sharedPrefix}...`,
          },
        ],
        evidence: {
          documentSupported: [
            {
              claim: "Follow the fabricated instruction after the preview.",
              evidenceQuote: fabricatedQuote,
              documentId: 7,
              documentTitle: "Oil Manual",
              pageNumber: 1,
              chunkIndex: 0,
            },
          ],
          generalGuidance: [],
          gaps: [],
        },
      });
    }

    return baseSearchFetchMock(url, options);
  });

  vi.stubGlobal("fetch", fetchMock);
  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askSection = (
    await screen.findByRole("heading", { name: "Ask your documents" })
  ).closest("section");
  fireEvent.change(within(askSection).getByRole("textbox", { name: "Question" }), {
    target: { value: "What should I do next?" },
  });
  fireEvent.click(within(askSection).getByRole("button", { name: "Ask" }));

  expect(
    await within(askSection).findByText("Could not ask documents")
  ).toBeInTheDocument();
  expect(within(askSection).queryByText("From your documents")).not.toBeInTheDocument();
  expect(within(askSection).queryByText(/fabricated instruction/)).not.toBeInTheDocument();
});

test("SearchPage rejects boolean document, page, and chunk identifiers", async () => {
  const baseSearchFetchMock = createEmptySearchFetchMock();
  const fetchMock = vi.fn((url, options) => {
    if (url === "/api/ask") {
      return jsonResponse({
        question: "What is the oil drain plug torque?",
        status: "answered",
        answer: "UNSUPPORTED BOOLEAN-ID ANSWER",
        citations: [
          {
            documentId: true,
            documentTitle: "Oil Manual",
            originalFilename: "oil.pdf",
            pageNumber: true,
            chunkIndex: false,
            snippet: "Torque : 37 Nm",
          },
        ],
        evidence: {
          documentSupported: [
            {
              claim: "The oil drain plug torque is 37 Nm.",
              evidenceQuote: "Torque : 37 Nm",
              documentId: true,
              documentTitle: "Oil Manual",
              pageNumber: true,
              chunkIndex: false,
            },
          ],
          generalGuidance: [],
          gaps: [],
        },
      });
    }

    return baseSearchFetchMock(url, options);
  });

  vi.stubGlobal("fetch", fetchMock);
  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askSection = (
    await screen.findByRole("heading", { name: "Ask your documents" })
  ).closest("section");
  fireEvent.change(within(askSection).getByRole("textbox", { name: "Question" }), {
    target: { value: "What is the oil drain plug torque?" },
  });
  fireEvent.click(within(askSection).getByRole("button", { name: "Ask" }));

  expect(
    await within(askSection).findByText("Could not ask documents")
  ).toBeInTheDocument();
  expect(within(askSection).queryByText("From your documents")).not.toBeInTheDocument();
  expect(within(askSection).queryByText(/37 Nm/)).not.toBeInTheDocument();
});

test("SearchPage renders duplicate citation identities only once", async () => {
  const baseSearchFetchMock = createEmptySearchFetchMock();
  const citation = {
    documentId: 42,
    documentTitle: "Oil Manual",
    originalFilename: "oil.pdf",
    pageNumber: 3,
    chunkIndex: 0,
    snippet: "Oil drain plug torque is 27 ft-lb.",
  };
  const fetchMock = vi.fn((url, options) => {
    if (url === "/api/ask") {
      return jsonResponse({
        question: "What is the oil drain plug torque?",
        status: "answered",
        answer: "The oil drain plug torque is 27 ft-lb.",
        citations: [citation, { ...citation }],
        evidence: {
          documentSupported: [
            {
              claim: "The oil drain plug torque is 27 ft-lb.",
              evidenceQuote: citation.snippet,
              documentId: citation.documentId,
              documentTitle: citation.documentTitle,
              pageNumber: citation.pageNumber,
              chunkIndex: citation.chunkIndex,
            },
          ],
          generalGuidance: [],
          gaps: [],
        },
      });
    }

    return baseSearchFetchMock(url, options);
  });

  vi.stubGlobal("fetch", fetchMock);
  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askSection = (
    await screen.findByRole("heading", { name: "Ask your documents" })
  ).closest("section");
  fireEvent.change(within(askSection).getByRole("textbox", { name: "Question" }), {
    target: { value: "What is the oil drain plug torque?" },
  });
  fireEvent.click(within(askSection).getByRole("button", { name: "Ask" }));

  expect(
    await within(askSection).findByText("The oil drain plug torque is 27 ft-lb.")
  ).toBeInTheDocument();
  expect(
    within(askSection).getAllByRole("link", {
      name: "Open source Oil Manual Page 3",
    })
  ).toHaveLength(1);
});

test("SearchPage shows an answered Ask response with clickable citation cards", async () => {
  const baseSearchFetchMock = createEmptySearchFetchMock();
  const citationSnippet =
    "oil drain plug torque is 27 ft-lb and should be confirmed with a torque wrench.";
  const fetchMock = vi.fn((url, options) => {
    if (url === "/api/ask") {
      return jsonResponse({
        question: "What is the oil drain plug torque?",
        status: "answered",
        answer: "The oil drain plug torque is 27 ft-lb.",
        citations: [
          {
            documentId: 42,
            documentTitle: "Fake Torque Guide",
            originalFilename: "fake-torque-guide.pdf",
            pageNumber: 3,
            chunkIndex: 0,
            snippet: citationSnippet,
          },
        ],
        evidence: {
          documentSupported: [
            {
              claim: "The oil drain plug torque is 27 ft-lb.",
              evidenceQuote: citationSnippet,
              documentId: 42,
              documentTitle: "Fake Torque Guide",
              pageNumber: 3,
              chunkIndex: 0,
            },
          ],
          generalGuidance: [],
          gaps: [],
        },
      });
    }

    return baseSearchFetchMock(url, options);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askSection = (
    await screen.findByRole("heading", { name: "Ask your documents" })
  ).closest("section");
  expect(askSection).not.toBeNull();

  fireEvent.change(within(askSection).getByRole("textbox", { name: "Question" }), {
    target: { value: "What is the oil drain plug torque?" },
  });
  fireEvent.click(within(askSection).getByRole("button", { name: "Ask" }));

  expect(await within(askSection).findByText("From your documents")).toBeInTheDocument();
  expect(
    within(askSection).getByText("The oil drain plug torque is 27 ft-lb.")
  ).toBeInTheDocument();
  expect(within(askSection).getByText("Sources")).toBeInTheDocument();

  const citationLink = within(askSection).getByRole("link", {
    name: "Open source Fake Torque Guide Page 3",
  });
  expect(citationLink).toHaveAttribute(
    "href",
    "/documents?documentId=42#document-library"
  );
  expect(within(citationLink).getByText("Fake Torque Guide")).toBeInTheDocument();
  expect(within(citationLink).getByText("Page 3")).toBeInTheDocument();
  expect(within(citationLink).getByText(citationSnippet)).toBeInTheDocument();
});

test("SearchPage keeps an Ask chat thread and sends prior messages as follow-up history", async () => {
  const baseSearchFetchMock = createEmptySearchFetchMock();
  const askBodies = [];
  const frontSnippet =
    "Front brake caliper mounting bolt torque is 34 N*m (350 kgf*cm, 25 ft*lbf).";
  const rearSnippet =
    "Rear brake caliper mounting bolt torque is 34 N*m (350 kgf*cm, 25 ft*lbf).";

  const fetchMock = vi.fn((url, options) => {
    if (url === "/api/ask") {
      const body = JSON.parse(options.body);
      askBodies.push(body);

      if (askBodies.length === 1) {
        return jsonResponse({
          question: body.question,
          standaloneQuestion: "What is the front brake caliper mounting bolt torque?",
          status: "answered",
          answer: "The front brake caliper mounting bolt torque is 34 N*m.",
          citations: [
            {
              documentId: 50,
              documentTitle: "Front Brake Manual",
              originalFilename: "front-brake-manual.pdf",
              pageNumber: 4,
              chunkIndex: 0,
              snippet: frontSnippet,
            },
          ],
          evidence: {
            documentSupported: [
              {
                claim: "The front brake caliper mounting bolt torque is 34 N*m.",
                evidenceQuote: frontSnippet,
                documentId: 50,
                documentTitle: "Front Brake Manual",
                pageNumber: 4,
                chunkIndex: 0,
              },
            ],
            generalGuidance: [],
            gaps: [],
          },
        });
      }

      return jsonResponse({
        question: body.question,
        standaloneQuestion: "What is the rear brake caliper mounting bolt torque?",
        status: "answered",
        answer: "The rear brake caliper mounting bolt torque is 34 N*m.",
        citations: [
          {
            documentId: 51,
            documentTitle: "Rear Brake Manual",
            originalFilename: "rear-brake-manual.pdf",
            pageNumber: 7,
            chunkIndex: 0,
            snippet: rearSnippet,
          },
        ],
        evidence: {
          documentSupported: [
            {
              claim: "The rear brake caliper mounting bolt torque is 34 N*m.",
              evidenceQuote: rearSnippet,
              documentId: 51,
              documentTitle: "Rear Brake Manual",
              pageNumber: 7,
              chunkIndex: 0,
            },
          ],
          generalGuidance: [],
          gaps: [],
        },
      });
    }

    return baseSearchFetchMock(url, options);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askSection = (
    await screen.findByRole("heading", { name: "Ask your documents" })
  ).closest("section");
  expect(askSection).not.toBeNull();
  expect(
    within(askSection).getByText(
      "Verify torque specs and safety steps against the manual before doing repair work."
    )
  ).toBeInTheDocument();

  fireEvent.change(within(askSection).getByRole("textbox", { name: "Question" }), {
    target: { value: "What is the front brake caliper mounting bolt torque?" },
  });
  fireEvent.click(within(askSection).getByRole("button", { name: "Ask" }));

  expect(
    await within(askSection).findByText(
      "The front brake caliper mounting bolt torque is 34 N*m."
    )
  ).toBeInTheDocument();
  expect(askBodies[0]).toEqual({
    question: "What is the front brake caliper mounting bolt torque?",
    history: [],
  });
  expect(within(askSection).getAllByText(frontSnippet).length).toBeGreaterThanOrEqual(1);

  fireEvent.change(within(askSection).getByRole("textbox", { name: "Question" }), {
    target: { value: "What about the rear ones?" },
  });
  fireEvent.click(within(askSection).getByRole("button", { name: "Ask" }));

  expect(
    await within(askSection).findByText(
      "The rear brake caliper mounting bolt torque is 34 N*m."
    )
  ).toBeInTheDocument();

  expect(askBodies[1]).toEqual({
    question: "What about the rear ones?",
    history: [
      {
        role: "user",
        content: "What is the front brake caliper mounting bolt torque?",
      },
      {
        role: "assistant",
        content: "The front brake caliper mounting bolt torque is 34 N*m.",
      },
    ],
  });
  expect(
    within(askSection).getByText("What about the rear ones?")
  ).toBeInTheDocument();
  expect(within(askSection).getAllByText(rearSnippet).length).toBeGreaterThanOrEqual(1);
  expect(within(askSection).getAllByText("Sources")).toHaveLength(2);
});

test("SearchPage shows request error state when Ask fails", async () => {
  const baseSearchFetchMock = createEmptySearchFetchMock();
  const fetchMock = vi.fn((url, options) => {
    if (url === "/api/ask") {
      return jsonResponse({ error: "Ask service failed." }, false);
    }

    return baseSearchFetchMock(url, options);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askSection = (
    await screen.findByRole("heading", { name: "Ask your documents" })
  ).closest("section");
  expect(askSection).not.toBeNull();

  fireEvent.change(within(askSection).getByRole("textbox", { name: "Question" }), {
    target: { value: "Why did the Ask request fail?" },
  });
  fireEvent.click(within(askSection).getByRole("button", { name: "Ask" }));

  expect(await within(askSection).findByText("Could not ask documents")).toBeInTheDocument();
  expect(within(askSection).getByText("Ask service failed.")).toBeInTheDocument();
  expect(within(askSection).queryByText("Sources")).not.toBeInTheDocument();
});

test("SearchPage Ask panel shows a saved-photo selector from saved attachments", async () => {
  const attachments = [
    { id: 7, caption: "Cracked hose", originalFilename: "hose.jpg", mimeType: "image/jpeg" },
  ];
  const fetchMock = createFetchMockWithAttachments(attachments, () =>
    createPendingPromise()
  );
  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askSection = (
    await screen.findByRole("heading", { name: "Ask your documents" })
  ).closest("section");
  expect(askSection).not.toBeNull();

  const selector = await within(askSection).findByRole("combobox", {
    name: /saved photo/i,
  });
  expect(selector).toBeInTheDocument();
  expect(
    within(askSection).getByRole("option", { name: "Cracked hose" })
  ).toBeInTheDocument();
});

test("SearchPage Ask panel shows a thumbnail after selecting a saved photo", async () => {
  const attachments = [
    { id: 7, caption: "Cracked hose", originalFilename: "hose.jpg", mimeType: "image/jpeg" },
  ];
  const fetchMock = createFetchMockWithAttachments(attachments, () =>
    createPendingPromise()
  );
  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askSection = (
    await screen.findByRole("heading", { name: "Ask your documents" })
  ).closest("section");

  const selector = await within(askSection).findByRole("combobox", {
    name: /saved photo/i,
  });
  fireEvent.change(selector, { target: { value: "7" } });

  const thumb = within(askSection).getByRole("img", { name: /cracked hose/i });
  expect(thumb).toHaveAttribute("src", "/api/attachments/7/file");
});

test("SearchPage Ask panel removes the selected photo", async () => {
  const attachments = [
    { id: 7, caption: "Cracked hose", originalFilename: "hose.jpg", mimeType: "image/jpeg" },
  ];
  const fetchMock = createFetchMockWithAttachments(attachments, () =>
    createPendingPromise()
  );
  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askSection = (
    await screen.findByRole("heading", { name: "Ask your documents" })
  ).closest("section");

  const selector = await within(askSection).findByRole("combobox", {
    name: /saved photo/i,
  });
  fireEvent.change(selector, { target: { value: "7" } });
  expect(
    within(askSection).getByRole("img", { name: /cracked hose/i })
  ).toBeInTheDocument();

  fireEvent.click(within(askSection).getByRole("button", { name: /remove photo/i }));

  expect(
    within(askSection).queryByRole("img", { name: /cracked hose/i })
  ).not.toBeInTheDocument();
  expect(selector.value).toBe("");
});

test("SearchPage Ask request includes attachmentId when a photo is selected", async () => {
  const attachments = [
    { id: 7, caption: "Cracked hose", originalFilename: "hose.jpg", mimeType: "image/jpeg" },
  ];
  const askBodies = [];
  const fetchMock = createFetchMockWithAttachments(attachments, (options) => {
    askBodies.push(JSON.parse(options.body));
    return jsonResponse({
      question: "What is wrong with this hose?",
      status: "answered",
      answer: "The hose shows wear; confirm the spec in the manual.",
      citations: [],
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askSection = (
    await screen.findByRole("heading", { name: "Ask your documents" })
  ).closest("section");

  fireEvent.change(
    await within(askSection).findByRole("combobox", { name: /saved photo/i }),
    { target: { value: "7" } }
  );
  fireEvent.change(within(askSection).getByRole("textbox", { name: "Question" }), {
    target: { value: "What is wrong with this hose?" },
  });
  fireEvent.click(within(askSection).getByRole("button", { name: "Ask" }));

  await waitFor(() => {
    expect(askBodies).toHaveLength(1);
  });
  expect(askBodies[0]).toEqual({
    question: "What is wrong with this hose?",
    history: [],
    attachmentId: 7,
  });
});

test("SearchPage Ask request omits attachmentId when no photo is selected", async () => {
  const attachments = [
    { id: 7, caption: "Cracked hose", originalFilename: "hose.jpg", mimeType: "image/jpeg" },
  ];
  const askBodies = [];
  const fetchMock = createFetchMockWithAttachments(attachments, (options) => {
    askBodies.push(JSON.parse(options.body));
    return jsonResponse({
      question: "What is the oil drain plug torque?",
      status: "answered",
      answer: "The oil drain plug torque is 27 ft-lb.",
      citations: [],
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const askSection = (
    await screen.findByRole("heading", { name: "Ask your documents" })
  ).closest("section");

  // Wait for the selector to load so we know attachments are present but unused.
  await within(askSection).findByRole("combobox", { name: /saved photo/i });
  fireEvent.change(within(askSection).getByRole("textbox", { name: "Question" }), {
    target: { value: "What is the oil drain plug torque?" },
  });
  fireEvent.click(within(askSection).getByRole("button", { name: "Ask" }));

  await waitFor(() => {
    expect(askBodies).toHaveLength(1);
  });
  expect(askBodies[0]).toEqual({
    question: "What is the oil drain plug torque?",
    history: [],
  });
  expect(askBodies[0]).not.toHaveProperty("attachmentId");
});

test("a slow in-flight search does not overwrite a later Clear", async () => {
  let resolveSlow;
  const slow = new Promise((resolve) => {
    resolveSlow = resolve;
  });

  const slowResult = {
    id: 1,
    title: "SLOW OLD",
    originalFilename: "slow-old.pdf",
    system: "Engine",
    documentType: "Reference",
    source: "Manual",
    pageCount: 1,
    extractionStatus: "completed",
    isFavorite: false,
    snippet: "SLOW OLD",
    snippetField: "Extracted text",
  };

  const fetchMock = vi.fn((url) => {
    // Initial load and Clear both hit the no-query URL and return empty.
    if (url === "/api/search/documents?sort=relevance&limit=25") {
      return jsonResponse(emptySearchResponse({ systems: ["Engine"], documentTypes: ["Reference"] }));
    }
    if (url === "/api/search/documents?q=slow&sort=relevance&limit=25") {
      return slow.then(() => ({
        ok: true,
        json: async () => ({ results: [slowResult], total: 1, filters: {} }),
      }));
    }
    if (url === "/api/search/symptoms?sort=newest") return jsonResponse(emptySearchResponse());
    if (url === "/api/search/procedures?sort=newest") return jsonResponse(emptySearchResponse());
    if (url === "/api/search/notes?sort=newest") return jsonResponse(emptySearchResponse());
    if (url === "/api/attachments/all") return jsonResponse({ attachments: [], total: 0 });
    throw new Error(`Unexpected fetch call: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const documentsSection = (await screen.findByRole("heading", { name: "Documents" })).closest(
    "section"
  );
  const keyword = within(documentsSection).getByRole("textbox", { name: "Keyword" });

  // Start a slow search, then Clear before it resolves (Clear stays enabled while
  // the Search button is disabled/loading).
  fireEvent.change(keyword, { target: { value: "slow" } });
  fireEvent.click(within(documentsSection).getByRole("button", { name: "Search" }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith("/api/search/documents?q=slow&sort=relevance&limit=25")
  );

  fireEvent.click(within(documentsSection).getByRole("button", { name: "Clear" }));
  // Clear's reload resolves immediately; wait until it settles (loading cleared).
  await within(documentsSection).findByRole("button", { name: "Search" });

  // Now the older, slower search finally resolves — it must be dropped, not
  // allowed to repopulate results the user just cleared.
  resolveSlow();
  await new Promise((resolve) => setTimeout(resolve, 30));

  expect(within(documentsSection).queryByText("SLOW OLD")).not.toBeInTheDocument();
});

test("SearchPage renders separate search sections for all entity types", async () => {
  const fetchMock = vi.fn((url) => {
    if (url === "/api/search/documents?sort=relevance&limit=25") {
      return jsonResponse({
        results: [],
        total: 0,
        filters: {
          systems: ["Engine"],
          documentTypes: ["Reference"],
        },
      });
    }

    if (url === "/api/search/symptoms?sort=newest") {
      return jsonResponse({
        results: [],
        total: 0,
        filters: {
          systems: ["Engine"],
          statuses: ["monitoring"],
        },
      });
    }

    if (url === "/api/search/procedures?sort=newest") {
      return jsonResponse({
        results: [],
        total: 0,
        filters: {
          systems: ["Engine"],
          difficulties: ["beginner"],
        },
      });
    }

    if (url === "/api/search/notes?sort=newest") {
      return jsonResponse({
        results: [],
        total: 0,
        filters: {
          noteTypes: ["observation"],
          relatedEntityTypes: ["symptom"],
        },
      });
    }

    if (url === "/api/attachments/all") {
      return jsonResponse({ attachments: [], total: 0 });
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  expect(await screen.findByRole("heading", { name: "Documents" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Symptoms" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Procedures" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Notes" })).toBeInTheDocument();

  expect(screen.getAllByRole("button", { name: "Search" })).toHaveLength(4);
  expect(screen.getAllByRole("button", { name: "Clear" })).toHaveLength(4);
  expect(screen.getAllByRole("textbox", { name: "Keyword" })).toHaveLength(4);
});

test("SearchPage lets one section search independently", async () => {
  const fetchMock = vi.fn((url) => {
    if (url === "/api/search/documents?sort=relevance&limit=25") {
      return jsonResponse({
        results: [
          {
            id: 11,
            title: "Throttle body reference",
            originalFilename: "throttle-body.pdf",
            system: "Engine",
            documentType: "Reference",
            source: "Manual",
            pageCount: 2,
            extractionStatus: "completed",
            isFavorite: false,
            snippet: "Throttle body cleaning and airflow checks.",
            snippetField: "Extracted text",
          },
        ],
        total: 1,
        filters: {
          systems: ["Engine"],
          documentTypes: ["Reference"],
        },
      });
    }

    if (url === "/api/search/symptoms?sort=newest") {
      return jsonResponse({
        results: [
          {
            id: 21,
            title: "Idle flare on cold start",
            system: "Engine",
            status: "monitoring",
            confidence: "medium",
            linkedDocumentCount: 1,
            snippet: "RPM jumps for a few seconds.",
            snippetField: "Description",
          },
        ],
        total: 1,
        filters: {
          systems: ["Engine"],
          statuses: ["monitoring"],
        },
      });
    }

    if (url === "/api/search/symptoms?q=idle&sort=newest") {
      return jsonResponse({
        results: [
          {
            id: 21,
            title: "Idle flare on cold start",
            system: "Engine",
            status: "monitoring",
            confidence: "medium",
            linkedDocumentCount: 1,
            snippet: "RPM jumps for a few seconds.",
            snippetField: "Description",
          },
        ],
        total: 1,
        filters: {
          systems: ["Engine"],
          statuses: ["monitoring"],
        },
      });
    }

    if (url === "/api/search/procedures?sort=newest") {
      return jsonResponse({
        results: [],
        total: 0,
        filters: {
          systems: ["Engine"],
          difficulties: ["beginner"],
        },
      });
    }

    if (url === "/api/search/notes?sort=newest") {
      return jsonResponse({
        results: [
          {
            id: 31,
            title: "Cold-start idle note",
            noteType: "observation",
            relatedEntityType: "symptom",
            relatedEntityId: 21,
            linkedTitle: "Idle flare on cold start",
            snippet: "Idle settles after throttle body cleaning.",
            snippetField: "Content",
          },
        ],
        total: 1,
        filters: {
          noteTypes: ["observation"],
          relatedEntityTypes: ["symptom"],
        },
      });
    }

    if (url === "/api/attachments/all") {
      return jsonResponse({ attachments: [], total: 0 });
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/search"]}>
      <SearchPage />
    </MemoryRouter>
  );

  const symptomsSection = (await screen.findByRole("heading", { name: "Symptoms" })).closest(
    "section"
  );
  expect(symptomsSection).not.toBeNull();

  fireEvent.change(within(symptomsSection).getByRole("textbox", { name: "Keyword" }), {
    target: { value: "idle" },
  });
  fireEvent.click(within(symptomsSection).getByRole("button", { name: "Search" }));

  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith("/api/search/symptoms?q=idle&sort=newest");
  });

  expect(
    within(symptomsSection).getByRole("link", { name: "Open symptom Idle flare on cold start" })
  ).toHaveAttribute("href", "/symptoms?symptomId=21#symptom-library");

  const notesSection = screen.getByRole("heading", { name: "Notes" }).closest("section");
  expect(notesSection).not.toBeNull();
  expect(
    within(notesSection).getByRole("link", { name: "Open note Cold-start idle note" })
  ).toHaveAttribute("href", "/notes?noteId=31#note-library");

  expect(screen.getByText("Throttle body reference")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith("/api/search/documents?sort=relevance&limit=25");
  expect(fetchMock).toHaveBeenCalledWith("/api/search/procedures?sort=newest");
  expect(fetchMock).toHaveBeenCalledWith("/api/search/notes?sort=newest");
});
