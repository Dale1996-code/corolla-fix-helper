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
    restore: {
      supported: true,
      method: "cli",
      command: 'npm run restore -- "/path/to/corolla-fix-helper-backup-....tar.gz"',
      documentation: "docs/backup-restore.md",
    },
  },
  ai: {
    apiKeyConfigured: true,
    model: "gpt-5.5-2026-04-23",
    callsToday: 4,
    countingBasis: "provider requests",
    dayBoundary: "local",
    dailyCallLimit: 500,
    countPersistsAcrossRestart: false,
  },
};

const RESTORE_COMMAND = 'npm run restore -- "/path/to/corolla-fix-helper-backup-....tar.gz"';

function stubSettingsFetch(payload = settingsPayload) {
  const fetchMock = vi.fn((url) => {
    if (url === "/api/settings") {
      return Promise.resolve({ ok: true, json: async () => payload });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderSettings() {
  return render(
    <MemoryRouter initialEntries={["/settings"]}>
      <SettingsPage />
    </MemoryRouter>
  );
}

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

test("the AI section shows key status, model, and today's call count", async () => {
  stubSettingsFetch();

  renderSettings();

  expect(await screen.findByRole("heading", { name: "AI" })).toBeTruthy();
  expect(screen.getByText("Configured")).toBeTruthy();
  expect(screen.getByText("gpt-5.5-2026-04-23")).toBeTruthy();
  // Counted against the configured daily ceiling.
  expect(screen.getByText("4 of 500")).toBeTruthy();
  // The metric is labelled as provider requests, not as questions asked.
  expect(screen.getByText(/provider requests sent to OpenAI, not questions asked/i)).toBeTruthy();
  expect(screen.getByText(/Resets at local midnight and when the server restarts/i)).toBeTruthy();
});

test("the AI section reports a missing key as not configured", async () => {
  stubSettingsFetch({
    ...settingsPayload,
    ai: { ...settingsPayload.ai, apiKeyConfigured: false, callsToday: 0, dailyCallLimit: 0 },
  });

  renderSettings();

  expect(await screen.findByText("Not configured")).toBeTruthy();
  expect(screen.getByText(/Set OPENAI_API_KEY in the server .env file/i)).toBeTruthy();
  // With the ceiling disabled the count is shown on its own, still tracked.
  expect(screen.getByText("0")).toBeTruthy();
  expect(screen.getByText(/daily ceiling is disabled/i)).toBeTruthy();
});

test("the AI section stays honest while loading and when a refresh fails", async () => {
  let resolveSettings;
  const fetchMock = vi.fn(
    () =>
      new Promise((resolve) => {
        resolveSettings = () => resolve({ ok: true, json: async () => settingsPayload });
      })
  );
  vi.stubGlobal("fetch", fetchMock);

  renderSettings();

  // While loading, no configuration claim is made either way.
  expect(screen.getByText("Loading settings...")).toBeTruthy();
  expect(screen.queryByText("Not configured")).toBeNull();
  expect(screen.queryByText("Configured")).toBeNull();

  resolveSettings();
  expect(await screen.findByText("Configured")).toBeTruthy();

  // A failed refresh keeps the last known values instead of implying the key
  // was removed.
  fetchMock.mockImplementation(() =>
    Promise.resolve({ ok: false, json: async () => ({ error: "Could not refresh AI status." }) })
  );

  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

  expect(await screen.findByText(/Could not refresh AI status\./)).toBeTruthy();
  expect(screen.getByText("Configured")).toBeTruthy();
  expect(screen.getByText("4 of 500")).toBeTruthy();
});

test("the settings page renders without an ai block from an older server", async () => {
  const payloadWithoutAi = { ...settingsPayload };
  delete payloadWithoutAi.ai;
  stubSettingsFetch(payloadWithoutAi);

  renderSettings();

  expect(await screen.findByText(/AI status is not available from the server/i)).toBeTruthy();
  // Never guesses a configuration state it was not told.
  expect(screen.queryByText("Configured")).toBeNull();
  expect(screen.queryByText("Not configured")).toBeNull();
});

test("the backup section explains the CLI restore workflow", async () => {
  stubSettingsFetch();

  renderSettings();

  expect(await screen.findByText("Restoring a backup")).toBeTruthy();

  // The exact supported command, in a code block.
  const commandNode = screen.getByText(RESTORE_COMMAND);
  expect(commandNode.tagName).toBe("CODE");
  // Wide content scrolls inside its own container rather than pushing the page
  // sideways on a phone.
  expect(commandNode.parentElement.className).toContain("overflow-x-auto");

  expect(screen.getByText(/there is no restore button in the app/i)).toBeTruthy();
  expect(screen.getByText(/Stop the running server first/i)).toBeTruthy();
  expect(screen.getByText(/there is no confirmation prompt/i)).toBeTruthy();
  expect(screen.getByText(/replaces the documents, symptoms, procedures, notes/i)).toBeTruthy();
  expect(screen.getByText("docs/backup-restore.md")).toBeTruthy();
});

test("the restore command can be copied to the clipboard", async () => {
  stubSettingsFetch();
  const writeText = vi.fn(() => Promise.resolve());
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

  renderSettings();

  fireEvent.click(await screen.findByRole("button", { name: "Copy command" }));

  await waitFor(() => {
    expect(writeText).toHaveBeenCalledWith(RESTORE_COMMAND);
  });
  expect(await screen.findByText("Copied to clipboard")).toBeTruthy();
});

test("a browser without clipboard support says so instead of looking successful", async () => {
  stubSettingsFetch();
  vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });

  renderSettings();

  fireEvent.click(await screen.findByRole("button", { name: "Copy command" }));

  expect(await screen.findByText(/will not let the page copy for you/i)).toBeTruthy();
  expect(screen.queryByText("Copied to clipboard")).toBeNull();
});
