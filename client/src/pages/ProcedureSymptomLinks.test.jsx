import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { ProceduresPage } from "./ProceduresPage";
import { buildProcedure, createProceduresApi } from "../test/proceduresApiMock";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// The Procedures page asks the server for one page of procedures, and its
// symptom picker searches a page at a time (N7); nothing downloads a whole
// library.
const SYMPTOMS = [
  { id: 5, title: "Rough idle", system: "Engine", status: "open" },
  { id: 6, title: "Stalls when cold", system: "Engine", status: "monitoring" },
];

function renderProcedures() {
  const api = createProceduresApi({
    procedures: [
      buildProcedure(31, {
        title: "Clean the throttle body",
        system: "Engine",
        steps: "Remove intake and clean the throttle plate.",
        linkedSymptomIds: [5],
      }),
    ],
    symptoms: SYMPTOMS,
  });
  vi.stubGlobal("fetch", vi.fn(api.fetch));

  render(
    <MemoryRouter initialEntries={["/procedures"]}>
      <ProceduresPage />
    </MemoryRouter>
  );

  return api;
}

test("procedure detail renders linked symptoms and the link selector", async () => {
  const api = renderProcedures();

  expect(
    await screen.findByRole("heading", { name: "Clean the throttle body" })
  ).toBeInTheDocument();

  expect(
    await screen.findByRole("link", { name: "Open symptom Rough idle" })
  ).toHaveAttribute("href", "/symptoms?symptomId=5#symptom-library");

  expect(await screen.findByRole("checkbox", { name: /Stalls when cold/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save linked symptoms" })).toBeInTheDocument();
  expect(api.fullListRequests).toEqual([]);
});

test("user can save linked symptoms with mocked fetch", async () => {
  const api = renderProcedures();

  fireEvent.click(await screen.findByRole("checkbox", { name: /Stalls when cold/i }));
  fireEvent.click(screen.getByRole("button", { name: "Save linked symptoms" }));

  expect(await screen.findByText("Linked symptoms saved.")).toBeInTheDocument();

  const putCall = api.writes.find(
    (write) => write.method === "PUT" && write.path === "/api/procedures/31/symptoms"
  );

  expect(putCall).toBeTruthy();
  expect(putCall.body).toEqual({ symptomIds: [5, 6] });
});
