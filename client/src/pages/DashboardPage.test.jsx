import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, test, vi } from "vitest";
import { DashboardPage } from "./DashboardPage";

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

test("DashboardPage shows saved vehicle profile from dashboard data", async () => {
  vi.stubGlobal("fetch", vi.fn(() => jsonResponse({
    vehicle: {
      id: 1,
      year: 2012,
      make: "Toyota",
      model: "Corolla",
      trim: "S",
      engine: "1.8L",
    },
    summary: {},
    favoriteDocuments: [],
    recentDocuments: [],
    recentSymptoms: [],
    recentProcedures: [],
    recentNotes: [],
    activeSymptoms: [],
    recentActivity: [],
  })));

  render(
    <MemoryRouter>
      <DashboardPage />
    </MemoryRouter>
  );

  expect(await screen.findByText("2012 Toyota Corolla S 1.8L")).toBeInTheDocument();
});
