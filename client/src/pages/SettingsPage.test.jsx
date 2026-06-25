import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";

const settingsPayload = {
  vehicle: { year: 2009, make: "Toyota", model: "Corolla", trim: "LE", engine: "1.8L" },
  runtime: {
    databaseFile: "data/app.db",
    uploadsDir: "uploads",
    maxUploadSizeMb: 20,
    port: 4000,
    clientPort: 5173,
    pathsEditable: false,
  },
  documentDefaults: { commonSystems: [], documentTypes: [] },
  backupExport: {
    supported: true,
    path: "Download from Settings",
    message: "Use Export backup to download one .tar.gz file.",
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("SettingsPage streams the backup download from the endpoint without buffering a Blob", async () => {
  const fetchMock = vi.fn((url) => {
    if (url === "/api/settings") {
      return Promise.resolve({ ok: true, json: async () => settingsPayload });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  // The download is triggered by programmatically clicking a temporary <a>.
  let clickedHref = null;
  const clickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function clickImpl() {
      clickedHref = this.getAttribute("href");
    });

  render(
    <MemoryRouter initialEntries={["/settings"]}>
      <SettingsPage />
    </MemoryRouter>
  );

  const exportButton = await screen.findByRole("button", { name: /Export backup/i });
  fireEvent.click(exportButton);

  await waitFor(() => {
    expect(clickedHref).not.toBeNull();
  });

  // It points the browser straight at the streaming endpoint...
  expect(clickedHref).toBe("/api/settings/backup-export");
  // ...and never pulls the whole archive into memory via fetch/blob.
  expect(fetchMock).not.toHaveBeenCalledWith("/api/settings/backup-export");

  clickSpy.mockRestore();
});
