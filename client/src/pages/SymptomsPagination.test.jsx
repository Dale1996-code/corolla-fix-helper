import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { SymptomsPage } from "./SymptomsPage";
import { buildSymptom, createSymptomsApi, jsonResponse } from "../test/symptomsApiMock";

// N7 for Symptoms: the list is paged, filtered, and sorted by the server, and the
// two link pickers search a page at a time, so nothing on this page downloads a
// whole collection. Every record here is synthetic.

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// 60 symptoms. `buildSymptom` stamps each one a second after the last, so
// "Newest" is highest id first: page 1 is 60-36, page 2 is 35-11, page 3 is 10-1.
const SYMPTOMS = Array.from({ length: 60 }, (_, index) =>
  buildSymptom(index + 1, {
    system: index % 2 === 0 ? "Brakes" : "Engine",
    status: ["open", "monitoring", "resolved"][index % 3],
  })
);

// 30 of each, so the pickers' first page (25) leaves some behind.
const DOCUMENTS = Array.from({ length: 30 }, (_, index) => ({
  id: 101 + index,
  title: `Manual ${String(index + 1).padStart(2, "0")}`,
  system: "Brakes",
  documentType: "Repair Manual",
}));
const PROCEDURES = Array.from({ length: 30 }, (_, index) => ({
  id: 201 + index,
  title: `Procedure ${String(index + 1).padStart(2, "0")}`,
  system: "Brakes",
  difficulty: "beginner",
}));

function HistoryHarness() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <div>
      <button type="button" onClick={() => navigate(-1)}>
        history back
      </button>
      <span data-testid="url">{`${location.pathname}${location.search}`}</span>
    </div>
  );
}

function currentUrl() {
  return screen.getByTestId("url").textContent;
}

function stubApi({ symptoms = SYMPTOMS, extra } = {}) {
  const api = createSymptomsApi(
    { symptoms, documents: DOCUMENTS, procedures: PROCEDURES },
    { extra }
  );
  vi.stubGlobal("fetch", vi.fn(api.fetch));
  return api;
}

async function renderSymptoms(entry = "/symptoms", options) {
  const api = stubApi(options);

  render(
    <MemoryRouter initialEntries={[entry]}>
      <SymptomsPage />
      <HistoryHarness />
    </MemoryRouter>
  );

  return api;
}

function rowTitles() {
  return screen.queryAllByTestId("symptom-row-title").map((node) => node.textContent);
}

function rowButton(title) {
  return screen
    .getAllByTestId("symptom-row-title")
    .find((node) => node.textContent === title)
    .closest("button");
}

function selectedTitle() {
  return screen.queryByRole("heading", { level: 2, name: /^Symptom \d{3}$/ })?.textContent;
}

// "Page 2 of 3" is split across <span>s for its bold numbers.
async function expectPageIndicator(expectedText) {
  await waitFor(() =>
    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName === "SPAN" && element.textContent.replace(/\s+/g, " ") === expectedText
      )
    ).toBeInTheDocument()
  );
}

// A summary card is a label paragraph followed by its value; "Open" alone would
// also match the status badges in the rows.
function summaryValue(label) {
  return screen
    .getAllByText(label)
    .find((node) => node.tagName === "P" && node.nextElementSibling?.tagName === "P")
    .nextElementSibling.textContent;
}

// Resolves a held request when the test says so.
function holdRequests() {
  const held = [];
  return {
    held,
    hold(respond) {
      return new Promise((resolve) => held.push(() => resolve(respond())));
    },
  };
}

test("the first view is one bounded page, with no whole-collection downloads", async () => {
  const api = await renderSymptoms();

  await waitFor(() => expect(rowTitles()).toHaveLength(25));
  expect(rowTitles()[0]).toBe("Symptom 060");
  expect(rowTitles().at(-1)).toBe("Symptom 036");
  expect(screen.getByText("Showing 1–25 of 60 symptoms.")).toBeInTheDocument();
  await expectPageIndicator("Page 1 of 3");

  // The summary cards describe every symptom, not the page.
  expect(summaryValue("Total symptoms")).toBe("60");
  expect(summaryValue("Visible now")).toBe("60");
  expect(summaryValue("Open")).toBe("20");
  expect(summaryValue("Monitoring")).toBe("20");
  expect(summaryValue("Resolved")).toBe("20");

  expect(api.listRequests).toHaveLength(1);
  expect(Object.fromEntries(api.listRequests[0])).toEqual({
    limit: "25",
    offset: "0",
    sort: "newest",
  });

  // The pickers ask for a page, too.
  await waitFor(() => expect(api.pickerRequests.length).toBeGreaterThan(0));
  for (const url of api.pickerRequests) {
    expect(url).toMatch(/limit=25/);
  }

  // Nothing asked for /api/symptoms, /api/documents, or /api/procedures whole.
  expect(api.fullListRequests).toEqual([]);
});

test("Next and Previous walk the page boundaries the server reports", async () => {
  const api = await renderSymptoms();
  await waitFor(() => expect(rowTitles()).toHaveLength(25));

  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(rowTitles()[0]).toBe("Symptom 035"));
  expect(rowTitles().at(-1)).toBe("Symptom 011");
  expect(screen.getByText("Showing 26–50 of 60 symptoms.")).toBeInTheDocument();
  expect(currentUrl()).toBe("/symptoms?page=2");

  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(rowTitles()).toHaveLength(10));
  expect(rowTitles().at(-1)).toBe("Symptom 001");
  expect(screen.getByText("Showing 51–60 of 60 symptoms.")).toBeInTheDocument();
  await expectPageIndicator("Page 3 of 3");
  expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  await waitFor(() => expect(rowTitles()[0]).toBe("Symptom 035"));
  expect(api.listRequests.map((params) => params.get("offset"))).toEqual(["0", "25", "50", "25"]);
});

test("a page past the end settles on the last real page, by replace", async () => {
  await renderSymptoms("/symptoms?page=9");

  await waitFor(() => expect(currentUrl()).toBe("/symptoms?page=3"));
  await waitFor(() => expect(screen.getByText("Showing 51–60 of 60 symptoms.")).toBeInTheDocument());
  expect(rowTitles()).toHaveLength(10);
});

test("the keyword, filters, and sort reach the server and span the whole list", async () => {
  const symptoms = SYMPTOMS.map((symptom) =>
    symptom.id === 2 ? { ...symptom, suspectedCauses: "Seized caliper slide pin" } : symptom
  );
  const api = await renderSymptoms("/symptoms", { symptoms });
  await waitFor(() => expect(rowTitles()).toHaveLength(25));

  // Symptom 002 sits on page 3; the search still finds it from page 1.
  fireEvent.change(screen.getByLabelText("Search"), { target: { value: "caliper" } });
  await waitFor(() => expect(rowTitles()).toEqual(["Symptom 002"]));
  expect(selectedTitle()).toBe("Symptom 002");
  expect(api.listRequests.at(-1).get("q")).toBe("caliper");
  expect(screen.getByText("Showing 1–1 of 1 symptom.")).toBeInTheDocument();
  // The whole-list cards do not shrink with a filter; "Visible now" does.
  expect(summaryValue("Total symptoms")).toBe("60");
  expect(summaryValue("Visible now")).toBe("1");

  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  await waitFor(() => expect(rowTitles()).toHaveLength(25));

  fireEvent.change(screen.getByLabelText("Status filter"), { target: { value: "resolved" } });
  await waitFor(() => expect(screen.getByText("Showing 1–20 of 20 symptoms.")).toBeInTheDocument());
  expect(api.listRequests.at(-1).get("status")).toBe("resolved");

  fireEvent.change(screen.getByLabelText("System filter"), { target: { value: "Engine" } });
  await waitFor(() => expect(api.listRequests.at(-1).get("system")).toBe("Engine"));
  await waitFor(() => expect(screen.getByText("Showing 1–10 of 10 symptoms.")).toBeInTheDocument());

  fireEvent.change(screen.getByLabelText("Sort order"), { target: { value: "oldest" } });
  await waitFor(() => expect(api.listRequests.at(-1).get("sort")).toBe("oldest"));
  // Oldest resolved Engine symptom is #6 (index 5: Engine, resolved).
  await waitFor(() => expect(rowTitles()[0]).toBe("Symptom 006"));
});

test("a filter change drops the page and the System filter offers every system", async () => {
  await renderSymptoms("/symptoms?page=2");
  await waitFor(() => expect(rowTitles()[0]).toBe("Symptom 035"));

  const systemFilter = screen.getByLabelText("System filter");
  await waitFor(() =>
    expect(within(systemFilter).getAllByRole("option").map((option) => option.value)).toEqual([
      "all",
      "Brakes",
      "Engine",
    ])
  );

  fireEvent.change(systemFilter, { target: { value: "Brakes" } });
  expect(currentUrl()).toBe("/symptoms?system=Brakes");
  await waitFor(() => expect(screen.getByText("Showing 1–25 of 30 symptoms.")).toBeInTheDocument());
});

test("a deep link to a symptom on another page opens it by id and keeps the link", async () => {
  const api = await renderSymptoms("/symptoms?symptomId=3");

  await waitFor(() => expect(selectedTitle()).toBe("Symptom 003"));
  expect(api.lookups).toEqual(["/api/symptoms/3"]);
  expect(currentUrl()).toBe("/symptoms?symptomId=3");
  // Page 1 is still the list on screen.
  expect(rowTitles()[0]).toBe("Symptom 060");

  // Picking a row on the page is a URL change only: no list request, no lookup.
  const requestsBefore = api.listRequests.length;
  fireEvent.click(rowButton("Symptom 050"));
  expect(currentUrl()).toBe("/symptoms?symptomId=50");
  await waitFor(() => expect(selectedTitle()).toBe("Symptom 050"));
  expect(api.listRequests).toHaveLength(requestsBefore);
  expect(api.lookups).toEqual(["/api/symptoms/3"]);

  // Back returns to the off-page symptom.
  fireEvent.click(screen.getByRole("button", { name: "history back" }));
  await waitFor(() => expect(selectedTitle()).toBe("Symptom 003"));
});

test("loading indicators: the first load, then another page while the old one stays", async () => {
  const { held, hold } = holdRequests();
  let holdingPages = true;

  await renderSymptoms("/symptoms", {
    extra: (url, init, state) =>
      holdingPages && url.startsWith("/api/symptoms?")
        ? hold(() => state.route(url, init))
        : undefined,
  });

  expect(screen.getByText("Loading symptoms...")).toBeInTheDocument();
  await waitFor(() => expect(held).toHaveLength(1));
  held.shift()();
  await waitFor(() => expect(rowTitles()).toHaveLength(25));
  expect(screen.queryByText("Loading symptoms...")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(await screen.findByText("Loading page 2...")).toBeInTheDocument();
  // Until page 2 arrives, the counter and pager still describe page 1.
  expect(screen.getByText(/Showing 1–25 of 60 symptoms\./)).toBeInTheDocument();
  expect(rowTitles()[0]).toBe("Symptom 060");
  expect(document.getElementById("symptom-library")).toHaveAttribute("aria-busy", "true");

  holdingPages = false;
  held.shift()();
  await waitFor(() => expect(rowTitles()[0]).toBe("Symptom 035"));
  expect(screen.queryByText("Loading page 2...")).not.toBeInTheDocument();
  expect(document.getElementById("symptom-library")).toHaveAttribute("aria-busy", "false");
});

test("a stale answer to an earlier view never replaces the newer one", async () => {
  const { held, hold } = holdRequests();
  let holdFirstPage = true;

  const api = await renderSymptoms("/symptoms", {
    extra: (url, init, state) => {
      // The unfiltered first page is slow; everything else answers at once.
      if (holdFirstPage && url.startsWith("/api/symptoms?") && !url.includes("status=")) {
        holdFirstPage = false;
        return hold(() => state.route(url, init));
      }
      return undefined;
    },
  });

  await waitFor(() => expect(held).toHaveLength(1));
  held.shift()();
  await waitFor(() => expect(rowTitles()).toHaveLength(25));

  // Hold the next unfiltered request (page 2) and race a filtered one past it.
  holdFirstPage = true;
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(held).toHaveLength(1));
  fireEvent.change(screen.getByLabelText("Status filter"), { target: { value: "resolved" } });
  await waitFor(() => expect(screen.getByText("Showing 1–20 of 20 symptoms.")).toBeInTheDocument());

  // Page 2 of the unfiltered list answers last, and is dropped.
  held.shift()();
  await waitFor(() =>
    expect(api.listRequests.some((params) => params.get("offset") === "25")).toBe(true)
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.getByText("Showing 1–20 of 20 symptoms.")).toBeInTheDocument();
  expect(rowTitles()).not.toContain("Symptom 035");
  expect(currentUrl()).toBe("/symptoms?status=resolved");
});

test("a failed first load says so and Try again recovers", async () => {
  let failures = 1;

  await renderSymptoms("/symptoms", {
    extra: (url) => {
      if (failures > 0 && url.startsWith("/api/symptoms?")) {
        failures -= 1;
        return jsonResponse({ error: "Database is busy." }, { ok: false, status: 500 });
      }
      return undefined;
    },
  });

  expect(await screen.findByText("Could not load symptoms.")).toBeInTheDocument();
  expect(screen.getByText(/Database is busy\./)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(rowTitles()).toHaveLength(25));
  expect(screen.queryByText("Could not load symptoms.")).not.toBeInTheDocument();
});

test("a failed page keeps the last rows on screen and the pager retries it", async () => {
  let failNextPage = false;

  await renderSymptoms("/symptoms", {
    extra: (url) => {
      if (failNextPage && url.includes("offset=25")) {
        failNextPage = false;
        // Never reached the server.
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return undefined;
    },
  });
  await waitFor(() => expect(rowTitles()).toHaveLength(25));

  failNextPage = true;
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(await screen.findByText(/The server could not be reached\./)).toBeInTheDocument();
  expect(screen.getByText(/The symptoms below are the last ones that loaded\./)).toBeInTheDocument();
  expect(rowTitles()[0]).toBe("Symptom 060");
  expect(currentUrl()).toBe("/symptoms?page=2");

  // Next on the page the URL already asks for asks the server again.
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(rowTitles()[0]).toBe("Symptom 035"));
  expect(screen.queryByText("Could not load symptoms.")).not.toBeInTheDocument();
});

test("a failed lookup names the symptom, keeps the link, and retries; a 404 drops it", async () => {
  let failLookup = true;

  await renderSymptoms("/symptoms?symptomId=3", {
    extra: (url) => {
      if (failLookup && url === "/api/symptoms/3") {
        failLookup = false;
        return jsonResponse({ error: "Database is busy." }, { ok: false, status: 503 });
      }
      return undefined;
    },
  });

  expect(await screen.findByText("Could not load symptom #3.")).toBeInTheDocument();
  expect(currentUrl()).toBe("/symptoms?symptomId=3");
  // Never another symptom standing in for the one the link names.
  expect(selectedTitle()).toBeUndefined();

  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(selectedTitle()).toBe("Symptom 003"));
});

test("a missing symptom in a deep link drops out of the URL after the server's 404", async () => {
  const api = await renderSymptoms("/symptoms?page=2&symptomId=999");

  await waitFor(() => expect(currentUrl()).toBe("/symptoms?page=2"));
  expect(api.lookups).toEqual(["/api/symptoms/999"]);
  await waitFor(() => expect(selectedTitle()).toBe("Symptom 035"));
});

test("creating a symptom selects it, links a picked document, and refreshes the page", async () => {
  const api = await renderSymptoms();
  await waitFor(() => expect(rowTitles()).toHaveLength(25));
  const requestsBefore = api.listRequests.length;
  const createForm = within(document.getElementById("create-symptom"));

  fireEvent.change(createForm.getByLabelText(/^Title/), { target: { value: "Symptom 900" } });
  fireEvent.click(await createForm.findByRole("checkbox", { name: /Manual 02/ }));
  fireEvent.click(createForm.getByRole("button", { name: "Save symptom" }));

  expect(await screen.findByText("Symptom saved.")).toBeInTheDocument();
  await waitFor(() => expect(selectedTitle()).toBe("Symptom 900"));
  // React Router commits the URL as a transition, a beat after the panel.
  await waitFor(() => expect(currentUrl()).toBe("/symptoms?symptomId=61"));

  const post = api.writes.find((write) => write.method === "POST");
  expect(post.body.linkedDocumentIds).toEqual([102]);

  await waitFor(() => expect(api.listRequests.length).toBe(requestsBefore + 1));
  await waitFor(() => expect(summaryValue("Total symptoms")).toBe("61"));
  expect(rowTitles()[0]).toBe("Symptom 900");
  expect(screen.getByRole("link", { name: "Open document Manual 02" })).toBeInTheDocument();
});

test("creating while a deep link names another symptom does not look that one up again", async () => {
  const api = await renderSymptoms("/symptoms?symptomId=3");
  await waitFor(() => expect(selectedTitle()).toBe("Symptom 003"));
  const createForm = within(document.getElementById("create-symptom"));

  fireEvent.change(createForm.getByLabelText(/^Title/), { target: { value: "Symptom 902" } });
  fireEvent.click(createForm.getByRole("button", { name: "Save symptom" }));

  await waitFor(() => expect(currentUrl()).toBe("/symptoms?symptomId=61"));
  expect(selectedTitle()).toBe("Symptom 902");
  expect(api.lookups).toEqual(["/api/symptoms/3"]);
});

test("a new symptom a filter hides is still shown, by id, until the owner moves on", async () => {
  const api = await renderSymptoms("/symptoms?status=resolved");
  await waitFor(() => expect(screen.getByText("Showing 1–20 of 20 symptoms.")).toBeInTheDocument());
  const createForm = within(document.getElementById("create-symptom"));

  // Created as open, under a resolved-only filter.
  fireEvent.change(createForm.getByLabelText(/^Title/), { target: { value: "Symptom 901" } });
  fireEvent.click(createForm.getByRole("button", { name: "Save symptom" }));

  await waitFor(() => expect(selectedTitle()).toBe("Symptom 901"));
  await waitFor(() => expect(api.listRequests.length).toBe(2));
  expect(rowTitles()).not.toContain("Symptom 901");
  expect(selectedTitle()).toBe("Symptom 901");
  // The server's answer was used; the page did not need to look it up.
  expect(api.lookups).toEqual([]);
});

test("editing keeps the edited symptom on display and saves documents outside the picker page", async () => {
  // Manual 30 is past the picker's first page of 25.
  const symptoms = SYMPTOMS.map((symptom) =>
    symptom.id === 40
      ? {
          ...symptom,
          linkedDocumentIds: [130],
          linkedDocuments: [{ id: 130, title: "Manual 30", system: "Brakes", documentType: "Repair Manual" }],
        }
      : symptom
  );
  const api = await renderSymptoms("/symptoms?sort=oldest&page=2", { symptoms });
  await waitFor(() => expect(rowTitles()[0]).toBe("Symptom 026"));
  fireEvent.click(rowButton("Symptom 040"));
  await waitFor(() => expect(selectedTitle()).toBe("Symptom 040"));

  fireEvent.click(screen.getByRole("button", { name: "Edit symptom" }));
  const editTitle = screen.getAllByLabelText(/^Title/).find((input) => input.value === "Symptom 040");
  fireEvent.change(editTitle, { target: { value: "Symptom 040 edited" } });

  // The linked document is listed and ticked although it is not in the
  // picker's first page; another one is added from that page.
  const editForm = within(editTitle.closest("form"));
  expect(editForm.getByRole("checkbox", { name: /Manual 30/ })).toBeChecked();
  fireEvent.click(await editForm.findByRole("checkbox", { name: /Manual 01/ }));
  fireEvent.click(editForm.getByRole("button", { name: "Save changes" }));

  expect(await screen.findByText("Changes saved.")).toBeInTheDocument();
  const put = api.writes.find((write) => write.method === "PUT");
  expect(put.body.linkedDocumentIds).toEqual([130, 101]);

  // Under "Oldest" the save moves the row to the last page; the panel stays on it.
  await waitFor(() => expect(rowTitles()).not.toContain("Symptom 040 edited"));
  expect(screen.getByRole("heading", { level: 2, name: "Symptom 040 edited" })).toBeInTheDocument();
  await waitFor(() => expect(currentUrl()).toBe("/symptoms?sort=oldest&page=2&symptomId=40"));
});

test("an implicit selection is pinned before a save re-sorts the page", async () => {
  const api = await renderSymptoms("/symptoms?sort=oldest");
  await waitFor(() => expect(selectedTitle()).toBe("Symptom 001"));

  fireEvent.click(screen.getByRole("button", { name: "Edit symptom" }));
  const editTitle = screen.getAllByLabelText(/^Title/).find((input) => input.value === "Symptom 001");
  fireEvent.change(editTitle, { target: { value: "Symptom 001 edited" } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

  expect(await screen.findByText("Changes saved.")).toBeInTheDocument();
  await waitFor(() => expect(api.listRequests.length).toBe(2));
  // The saved symptom now sorts last, off this page; the panel did not jump to
  // the new first row.
  await waitFor(() => expect(rowTitles()[0]).toBe("Symptom 002"));
  expect(screen.getByRole("heading", { level: 2, name: "Symptom 001 edited" })).toBeInTheDocument();
  await waitFor(() => expect(currentUrl()).toBe("/symptoms?sort=oldest&symptomId=1"));
});

test("deleting the only row on the last page steps back a page", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const symptoms = SYMPTOMS.slice(0, 26);
  const api = await renderSymptoms("/symptoms?page=2&symptomId=1", { symptoms });
  await waitFor(() => expect(rowTitles()).toEqual(["Symptom 001"]));
  await waitFor(() => expect(selectedTitle()).toBe("Symptom 001"));

  fireEvent.click(screen.getByRole("button", { name: "Delete" }));

  await waitFor(() => expect(currentUrl()).toBe("/symptoms"));
  await waitFor(() => expect(screen.getByText("Showing 1–25 of 25 symptoms.")).toBeInTheDocument());
  expect(api.writes.at(-1)).toEqual({ method: "DELETE", path: "/api/symptoms/1" });
  expect(selectedTitle()).toBe("Symptom 026");
  expect(summaryValue("Total symptoms")).toBe("25");
  // The deleted symptom is never looked up: the page already knows it is gone.
  expect(api.lookups).toEqual([]);
});

test("Back to a history entry naming a deleted symptom drops it and clamps the page", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const symptoms = SYMPTOMS.slice(0, 26);
  const api = await renderSymptoms("/symptoms?page=2&symptomId=1", { symptoms });
  await waitFor(() => expect(selectedTitle()).toBe("Symptom 001"));

  // A second entry that still shows symptom 1, now looked up by id from page 1.
  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  await waitFor(() => expect(currentUrl()).toBe("/symptoms?symptomId=1"));
  await waitFor(() => expect(api.lookups).toEqual(["/api/symptoms/1"]));
  expect(selectedTitle()).toBe("Symptom 001");

  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(currentUrl()).toBe("/symptoms"));

  // The entry before still says page=2&symptomId=1. Both are now wrong -- the
  // symptom is gone and 25 symptoms make one page -- and both writes that fix
  // them land, rather than the second undoing the first.
  fireEvent.click(screen.getByRole("button", { name: "history back" }));
  await waitFor(() => expect(currentUrl()).toBe("/symptoms"));
  await waitFor(() => expect(screen.getByText("Showing 1–25 of 25 symptoms.")).toBeInTheDocument());
  expect(selectedTitle()).toBe("Symptom 026");
  expect(api.lookups).toEqual(["/api/symptoms/1"]);
});

test("linked procedures outside the picker's page stay visible, and Show more pages on", async () => {
  // Procedure 30 is past the picker's first page of 25.
  const symptoms = SYMPTOMS.map((symptom) =>
    symptom.id === 60
      ? {
          ...symptom,
          linkedProcedureIds: [230],
          linkedProcedures: [{ id: 230, title: "Procedure 30", system: "Brakes", difficulty: "beginner" }],
        }
      : symptom
  );
  const api = await renderSymptoms("/symptoms", { symptoms });
  await waitFor(() => expect(selectedTitle()).toBe("Symptom 060"));

  expect(screen.getByRole("link", { name: "Open procedure Procedure 30" })).toBeInTheDocument();
  expect(await screen.findByRole("checkbox", { name: /Procedure 30/ })).toBeChecked();
  expect(await screen.findByRole("checkbox", { name: /Procedure 01/ })).not.toBeChecked();
  expect(screen.getByText("Showing 1–25 of 30 procedures. 1 selected.")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Show more procedures" }));
  expect(await screen.findByRole("checkbox", { name: /Procedure 29/ })).toBeInTheDocument();
  expect(api.pickerRequests.some((url) => url.startsWith("/api/search/procedures") && url.includes("offset=25"))).toBe(true);
  // Procedure 30 is listed once, not again when its page arrives.
  expect(screen.getAllByRole("checkbox", { name: /Procedure 30/ })).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Show more procedures" })).not.toBeInTheDocument();

  // Searching narrows the picker on the server.
  fireEvent.change(screen.getByLabelText("Find procedures"), { target: { value: "Procedure 07" } });
  await waitFor(() =>
    expect(api.pickerRequests.at(-1)).toMatch(/^\/api\/search\/procedures\?.*q=Procedure\+07/)
  );
  await waitFor(() =>
    expect(screen.queryByRole("checkbox", { name: /Procedure 01/ })).not.toBeInTheDocument()
  );
  expect(screen.getByRole("checkbox", { name: /Procedure 07/ })).toBeInTheDocument();
  // What is already linked stays listed, so it can still be unticked.
  expect(screen.getByRole("checkbox", { name: /Procedure 30/ })).toBeChecked();
});

test("selecting another symptom reuses the procedure picker's first page", async () => {
  const api = await renderSymptoms();
  await waitFor(() => expect(selectedTitle()).toBe("Symptom 060"));
  await screen.findByRole("checkbox", { name: /Procedure 01/ });
  const procedureSearches = () =>
    api.pickerRequests.filter((url) => url.startsWith("/api/search/procedures"));
  expect(procedureSearches()).toHaveLength(1);

  fireEvent.click(rowButton("Symptom 059"));
  await waitFor(() => expect(selectedTitle()).toBe("Symptom 059"));
  await screen.findByRole("checkbox", { name: /Procedure 01/ });
  expect(procedureSearches()).toHaveLength(1);
});

test("a failed picker search says so and Try again recovers", async () => {
  let failSearch = true;

  await renderSymptoms("/symptoms", {
    extra: (url) => {
      if (failSearch && url.startsWith("/api/search/procedures")) {
        failSearch = false;
        return jsonResponse({ error: "Search is unavailable." }, { ok: false, status: 500 });
      }
      return undefined;
    },
  });

  expect(await screen.findByText("Could not load procedures.")).toBeInTheDocument();
  expect(screen.getByText(/Search is unavailable\./)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("checkbox", { name: /Procedure 01/ })).toBeInTheDocument();
  expect(screen.queryByText("Could not load procedures.")).not.toBeInTheDocument();
});

test("an empty library shows the empty states, not a pager", async () => {
  const api = createSymptomsApi({ symptoms: [], documents: [], procedures: [] });
  vi.stubGlobal("fetch", vi.fn(api.fetch));

  render(
    <MemoryRouter initialEntries={["/symptoms"]}>
      <SymptomsPage />
    </MemoryRouter>
  );

  // The counter and the list's own empty state both say so.
  expect(await screen.findAllByText("No symptoms yet.")).toHaveLength(2);
  expect(screen.getByText("Select a symptom to view details.")).toBeInTheDocument();
  expect(screen.queryByRole("navigation", { name: "Symptoms pages" })).not.toBeInTheDocument();
  expect(
    await screen.findByText("No documents available yet. Upload a PDF on the Documents page first.")
  ).toBeInTheDocument();
});
