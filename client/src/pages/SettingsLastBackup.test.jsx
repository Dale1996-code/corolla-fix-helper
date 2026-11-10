import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";

// "Last backup" is the one place the owner learns whether the data is covered,
// so these tests pin what it may claim: "Verified" only when the file is there
// AND a test restore passed; "Status unknown" whenever the app cannot confirm
// the file; a visible warning past seven days; never the word "safe".

const NONE = { recorded: false, stale: true, staleAfterDays: 7 };

const CLI_PATH = "D:\\Backups\\corolla-fix-helper-backup-2026-11-08T12-00-00-000Z.tar.gz";

const VERIFIED = {
  recorded: true,
  createdAt: "2026-11-08T12:00:00.000Z",
  source: "cli",
  destination: CLI_PATH,
  archiveBytes: 52428800,
  file: "found",
  verification: "passed",
  verifiedAt: "2026-11-08T12:00:30.000Z",
  assurance: "verified",
  ageDays: 2,
  stale: false,
  staleAfterDays: 7,
};

function payloadWith(lastBackup, backupExportExtras = {}) {
  return {
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
      lastBackup,
      ...backupExportExtras,
    },
    ai: {
      apiKeyConfigured: true,
      model: "gpt-test",
      callsToday: 0,
      countingBasis: "provider requests",
      dayBoundary: "local",
      dailyCallLimit: 0,
      countPersistsAcrossRestart: false,
    },
  };
}

function stubFetch(...payloads) {
  const queue = [...payloads];
  const fetchMock = vi.fn((url) => {
    if (url !== "/api/settings") {
      throw new Error(`Unexpected fetch: ${url}`);
    }

    const next = queue.length > 1 ? queue.shift() : queue[0];

    return Promise.resolve(
      next.failure
        ? { ok: false, json: async () => ({ error: next.failure }) }
        : { ok: true, json: async () => next }
    );
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

test("with no backup recorded the page says so and does not imply the data is covered", async () => {
  stubFetch(payloadWith(NONE));
  renderSettings();

  expect(await screen.findByText(/No backup recorded yet/)).toBeTruthy();
  expect(screen.queryByText(/Verified: it passed/)).toBeNull();
});

test("a verified command-line backup shows when, where, and that it passed a test restore", async () => {
  stubFetch(payloadWith(VERIFIED));
  renderSettings();

  expect(await screen.findByText(/Verified: it passed a test restore/)).toBeTruthy();
  expect(screen.getByText(CLI_PATH)).toBeTruthy();
  // The date is shown twice on purpose: when it was made, and when it passed.
  const made = within(screen.getByText("Made").parentElement);
  expect(made.getByText(/Nov [789], 2026/)).toBeTruthy();
  expect(made.getByText("2 days ago")).toBeTruthy();
  const testRestore = within(screen.getByText("Test restore").parentElement);
  expect(testRestore.getByText(/Passed on Nov [789], 2026/)).toBeTruthy();
  expect(screen.getByText("Found (same size as when it was made)")).toBeTruthy();
  expect(screen.queryByText(/days old/)).toBeNull();
});

test("a backup more than seven days old shows a warning with its age", async () => {
  stubFetch(payloadWith({ ...VERIFIED, ageDays: 12, stale: true }));
  renderSettings();

  const warning = await screen.findByText(/12 days old/);

  expect(warning.textContent).toMatch(/older than 7 days/);
});

test("a backup whose file cannot be found is never shown as verified", async () => {
  stubFetch(payloadWith({ ...VERIFIED, file: "missing", assurance: "unknown" }));
  renderSettings();

  expect(await screen.findByText(/Status unknown/)).toBeTruthy();
  expect(screen.getByText("Not found at that location")).toBeTruthy();
  expect(screen.queryByText(/Verified: it passed/)).toBeNull();
  // It did pass once; the page must not let that read as current assurance.
  expect(screen.getByText(/can no longer be confirmed/)).toBeTruthy();
});

test("a Settings download is shown as unknown because the app cannot see where the browser saved it", async () => {
  stubFetch(
    payloadWith({
      recorded: true,
      createdAt: "2026-11-09T12:00:00.000Z",
      source: "settings",
      destination: null,
      archiveBytes: null,
      file: "not_checkable",
      verification: "not_run",
      verifiedAt: null,
      assurance: "unknown",
      ageDays: 1,
      stale: false,
      staleAfterDays: 7,
    })
  );
  renderSettings();

  expect(await screen.findByText(/Status unknown/)).toBeTruthy();
  expect(screen.getByText(/Your browser's download folder/)).toBeTruthy();
  expect(screen.getByText("Can't be checked from here")).toBeTruthy();
  expect(screen.queryByText(/Verified: it passed/)).toBeNull();
});

test("a backup that was created but never test-restored says it is not verified", async () => {
  stubFetch(
    payloadWith({
      ...VERIFIED,
      verification: "not_run",
      verifiedAt: null,
      assurance: "created",
    })
  );
  renderSettings();

  expect(await screen.findByText(/Created, not verified/)).toBeTruthy();
  expect(screen.getByText("Not run")).toBeTruthy();
  expect(screen.queryByText(/Verified: it passed/)).toBeNull();
});

test("the page never calls a backup safe", async () => {
  for (const lastBackup of [NONE, VERIFIED, { ...VERIFIED, assurance: "created", verification: "not_run" }]) {
    stubFetch(payloadWith(lastBackup));
    const { unmount } = renderSettings();

    const panel = await screen.findByRole("region", { name: "Last backup" });
    expect(panel.textContent).toMatch(/backup/i);
    expect(panel.textContent).not.toMatch(/\bsafe\b/i);

    unmount();
    vi.unstubAllGlobals();
  }
});

test("Check again re-reads the status, and keeps the last values if the check fails", async () => {
  stubFetch(payloadWith(NONE), payloadWith(VERIFIED), { failure: "Could not reach the server." });
  renderSettings();

  await screen.findByText(/No backup recorded yet/);

  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(await screen.findByText(/Verified: it passed a test restore/)).toBeTruthy();
  expect(screen.queryByText(/No backup recorded yet/)).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(await screen.findByText(/Could not reach the server/)).toBeTruthy();
  expect(screen.getByText(/Verified: it passed a test restore/)).toBeTruthy();
});

test("the backup command comes from the server and is shown beside the export button", async () => {
  stubFetch(payloadWith(NONE, { cli: { command: 'npm run backup -- "/path/to/backup-folder"' } }));
  renderSettings();

  expect(await screen.findByText('npm run backup -- "/path/to/backup-folder"')).toBeTruthy();
});
