import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { RepairChecklistsPage } from "./RepairChecklistsPage";

function jsonResponse(payload, ok = true) {
  return Promise.resolve({
    ok,
    json: async () => payload,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("RepairChecklistsPage lists a checklist, shows its status and items, and checks an item off", async () => {
  const checklist = {
    id: 1,
    title: "Front brake job",
    status: "in_progress",
    description: "Replace front pads and rotors.",
    notes: "Torque caliper bolts to spec.",
    createdAt: "2026-05-01T08:00:00.000Z",
    updatedAt: "2026-05-01T09:00:00.000Z",
    items: [
      {
        id: 10,
        text: "Buy pads",
        isDone: false,
        sortOrder: 0,
        createdAt: "2026-05-01T08:05:00.000Z",
        updatedAt: "2026-05-01T08:05:00.000Z",
      },
      {
        id: 11,
        text: "Torque caliper bolts",
        isDone: false,
        sortOrder: 1,
        createdAt: "2026-05-01T08:06:00.000Z",
        updatedAt: "2026-05-01T08:06:00.000Z",
      },
    ],
    itemCount: 2,
    doneItemCount: 0,
  };

  const updatedChecklist = {
    ...checklist,
    items: [{ ...checklist.items[0], isDone: true }, checklist.items[1]],
    doneItemCount: 1,
  };

  const fetchMock = vi.fn((url, options = {}) => {
    if (url === "/api/repair-checklists" && (!options.method || options.method === "GET")) {
      return jsonResponse({ checklists: [checklist], total: 1 });
    }

    if (url === "/api/repair-checklists/1/items/10" && options.method === "PUT") {
      return jsonResponse({
        message: "Checklist item updated.",
        checklist: updatedChecklist,
      });
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);

  render(
    <MemoryRouter initialEntries={["/repair-checklists"]}>
      <RepairChecklistsPage />
    </MemoryRouter>
  );

  expect((await screen.findAllByText("Front brake job")).length).toBeGreaterThan(0);
  // "In progress" is the display label for the stored `in_progress` status.
  expect(screen.getAllByText("In progress").length).toBeGreaterThan(0);
  expect(screen.getByText("Buy pads")).toBeInTheDocument();
  expect(screen.getByText("Torque caliper bolts")).toBeInTheDocument();

  const toggle = screen.getByRole("checkbox", { name: "Toggle done for Buy pads" });
  expect(toggle).not.toBeChecked();

  fireEvent.click(toggle);

  await waitFor(() => {
    const putCall = fetchMock.mock.calls.find(
      ([url, options]) => url === "/api/repair-checklists/1/items/10" && options?.method === "PUT"
    );
    expect(putCall).toBeTruthy();
    expect(JSON.parse(putCall[1].body)).toMatchObject({ isDone: true });
  });

  await waitFor(() => {
    expect(
      screen.getByRole("checkbox", { name: "Toggle done for Buy pads" })
    ).toBeChecked();
  });
});
