import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AttachmentPanel } from "./AttachmentPanel";

function jsonResponse(payload, ok = true) {
  return Promise.resolve({
    ok,
    json: async () => payload,
  });
}

function makeAttachment(overrides = {}) {
  return {
    id: 1,
    entityType: "symptom",
    entityId: 5,
    originalFilename: "engine-bay.png",
    storedFilename: "engine-bay-123.png",
    filePath: "server/uploads/attachments/images/engine-bay-123.png",
    mimeType: "image/png",
    fileSize: 2048,
    caption: "Engine bay",
    createdAt: "2026-05-01T10:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("AttachmentPanel renders existing attachments with an image source", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockReturnValue(
      jsonResponse({ attachments: [makeAttachment()], total: 1 })
    )
  );

  render(<AttachmentPanel entityType="symptom" entityId={5} />);

  expect(await screen.findByText("Engine bay")).toBeInTheDocument();

  const image = screen.getByRole("img");
  expect(image).toHaveAttribute("src", "/api/attachments/1/file");
});

// The panel used to label its control "Remove" while the confirmation it opened
// said "Delete this photo" -- one action described two ways. The button, the
// prompt, and the request have to agree.
test("AttachmentPanel deletes a photo with matching button and prompt wording", async () => {
  const fetchMock = vi
    .fn()
    .mockReturnValueOnce(jsonResponse({ attachments: [makeAttachment()], total: 1 }))
    .mockReturnValueOnce(jsonResponse({ message: "Attachment deleted." }));
  vi.stubGlobal("fetch", fetchMock);

  const confirmMock = vi.fn(() => true);
  vi.stubGlobal("confirm", confirmMock);

  render(<AttachmentPanel entityType="symptom" entityId={5} />);

  expect(await screen.findByText("Engine bay")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Delete" }));

  expect(confirmMock).toHaveBeenCalledWith(
    'Delete this photo ("Engine bay")? This cannot be undone.'
  );

  // The relabelled button still calls the same route.
  await screen.findByText(/no photos yet/i);
  expect(fetchMock.mock.calls[1][0]).toBe("/api/attachments/1");
  expect(fetchMock.mock.calls[1][1].method).toBe("DELETE");
});

test("AttachmentPanel uploads an image and shows it (happy path)", async () => {
  const fetchMock = vi
    .fn()
    .mockReturnValueOnce(jsonResponse({ attachments: [], total: 0 }))
    .mockReturnValueOnce(
      jsonResponse({
        message: "Attachment saved.",
        attachment: makeAttachment({ id: 9, caption: "New photo" }),
      })
    );
  vi.stubGlobal("fetch", fetchMock);

  render(<AttachmentPanel entityType="symptom" entityId={5} />);

  expect(await screen.findByText(/no photos yet/i)).toBeInTheDocument();

  const file = new File(["bytes"], "new-photo.png", { type: "image/png" });
  fireEvent.change(screen.getByLabelText(/add a photo/i), {
    target: { files: [file] },
  });
  fireEvent.change(screen.getByLabelText(/caption/i), {
    target: { value: "New photo" },
  });
  fireEvent.click(screen.getByRole("button", { name: /upload/i }));

  expect(await screen.findByText("New photo")).toBeInTheDocument();

  expect(fetchMock).toHaveBeenCalledTimes(2);
  const [uploadUrl, uploadOptions] = fetchMock.mock.calls[1];
  expect(uploadUrl).toBe("/api/attachments");
  expect(uploadOptions.method).toBe("POST");
  expect(uploadOptions.body).toBeInstanceOf(FormData);
  expect(uploadOptions.body.get("entityType")).toBe("symptom");
  expect(uploadOptions.body.get("entityId")).toBe("5");
});
