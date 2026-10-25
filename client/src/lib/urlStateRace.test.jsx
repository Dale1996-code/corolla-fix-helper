import { act, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useDraftTextParam, useViewParamWriter } from "./urlState";

// Issue #164. A page's keyword box (useDraftTextParam) and its other URL writes
// (useViewParamWriter) must share one view of "the latest URL", so that a
// keyword commit and a filter change landing in the same moment both survive.
//
// Everything runs under fake timers, and "the same moment" is made exact rather
// than hoped for: a timer firing and a filter write are put inside ONE act(), so
// React cannot render between them. That is the window the issue measured at
// 290-310 ms, reproduced with no clock at all.

const DEBOUNCE_MS = 300;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// Hosts both hooks the way a list page does: one writer, and a keyword box that
// commits through it. `hooks` hands the test the page's handlers.
function renderPage(entry, { clearOnCommit = ["page"] } = {}) {
  const hooks = {};

  function Probe() {
    const [searchParams, setSearchParams] = useSearchParams();
    const location = useLocation();
    hooks.navigate = useNavigate();
    hooks.write = useViewParamWriter(searchParams, setSearchParams);
    [hooks.draft, hooks.setDraft] = useDraftTextParam("q", {
      searchParams,
      writeParams: hooks.write,
      clearOnCommit,
    });
    return (
      <>
        <span data-testid="search">{location.search}</span>
        <span data-testid="draft">{hooks.draft}</span>
      </>
    );
  }

  render(
    <MemoryRouter initialEntries={[entry]}>
      <Probe />
    </MemoryRouter>
  );

  return hooks;
}

function url() {
  return screen.getByTestId("search").textContent;
}

function urlParams() {
  return Object.fromEntries(new URLSearchParams(url()));
}

function shownDraft() {
  return screen.getByTestId("draft").textContent;
}

async function tick(ms) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("a keyword commit and a filter change in the same moment (#164)", () => {
  test("the timer fires first, then the filter write: both parameters land", async () => {
    const hooks = renderPage("/list");

    act(() => hooks.setDraft("brake"));
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
      hooks.write({ status: "open", page: null });
    });

    expect(urlParams()).toEqual({ q: "brake", status: "open" });
    expect(shownDraft()).toBe("brake");
  });

  test("the filter write first, then the timer fires: both parameters land", async () => {
    const hooks = renderPage("/list");

    act(() => hooks.setDraft("brake"));
    await act(async () => {
      hooks.write({ status: "open", page: null });
      vi.advanceTimersByTime(DEBOUNCE_MS);
    });

    expect(urlParams()).toEqual({ q: "brake", status: "open" });
    expect(shownDraft()).toBe("brake");
  });

  test("the box never keeps a keyword the URL lost, and the commit does not stay lost", async () => {
    const hooks = renderPage("/list");

    act(() => hooks.setDraft("brake"));
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
      hooks.write({ status: "open" });
    });
    // Whatever order React settled the two writes in, the URL and the box agree,
    // and waiting longer changes nothing.
    await tick(5 * DEBOUNCE_MS);

    expect(urlParams().q).toBe("brake");
    expect(shownDraft()).toBe("brake");
    expect(urlParams().status).toBe("open");
  });

  test("a filter change just before and just after the commit both keep the keyword", async () => {
    const hooks = renderPage("/list");

    act(() => hooks.setDraft("brake"));
    await tick(DEBOUNCE_MS - 1);
    act(() => hooks.write({ status: "open" }));
    await tick(1);

    expect(urlParams()).toEqual({ status: "open", q: "brake" });

    act(() => hooks.write({ system: "Brakes" }));
    await tick(DEBOUNCE_MS);

    expect(urlParams()).toEqual({ status: "open", q: "brake", system: "Brakes" });
  });

  test("a keyword typed after a filter change commits onto that filter", async () => {
    const hooks = renderPage("/list");

    act(() => hooks.write({ status: "open" }));
    act(() => hooks.setDraft("brake"));
    await tick(DEBOUNCE_MS);

    expect(urlParams()).toEqual({ status: "open", q: "brake" });
  });

  test("unrelated parameters survive both writes", async () => {
    const hooks = renderPage("/list?symptomId=7&future=keep");

    act(() => hooks.setDraft("brake"));
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
      hooks.write({ status: "open" });
    });

    expect(urlParams()).toEqual({
      symptomId: "7",
      future: "keep",
      q: "brake",
      status: "open",
    });
  });
});

describe("several writes before the next render", () => {
  test("rapid consecutive filter changes all land alongside a pending keyword", async () => {
    const hooks = renderPage("/list");

    act(() => hooks.setDraft("brake"));
    await act(async () => {
      hooks.write({ status: "open" });
      hooks.write({ system: "Brakes" });
      vi.advanceTimersByTime(DEBOUNCE_MS);
      hooks.write({ confidence: "high" });
      hooks.write({ sort: "title" });
    });

    expect(urlParams()).toEqual({
      status: "open",
      system: "Brakes",
      q: "brake",
      confidence: "high",
      sort: "title",
    });
  });

  test("a later write is not undone when an earlier write's render arrives", async () => {
    const hooks = renderPage("/list");

    await act(async () => {
      hooks.write({ status: "open" });
      hooks.write({ system: "Brakes" });
    });
    // After the dust settles, a third write builds on both.
    act(() => hooks.write({ sort: "title" }));

    expect(urlParams()).toEqual({ status: "open", system: "Brakes", sort: "title" });
  });

  test("changing a filter back to its default while a keyword is pending", async () => {
    const hooks = renderPage("/list?status=open");

    act(() => hooks.setDraft("brake"));
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
      hooks.write({ status: null });
    });

    expect(urlParams()).toEqual({ q: "brake" });
  });
});

describe("clearing the keyword while filters are active", () => {
  test("removes q and keeps every filter", async () => {
    const hooks = renderPage("/list?q=brake&status=open&system=Brakes");

    expect(shownDraft()).toBe("brake");
    act(() => hooks.setDraft(""));
    await tick(DEBOUNCE_MS);

    expect(urlParams()).toEqual({ status: "open", system: "Brakes" });
    expect(shownDraft()).toBe("");
  });

  test("clearing the keyword in the same moment as a filter change keeps the filter", async () => {
    const hooks = renderPage("/list?q=brake&status=open");

    act(() => hooks.setDraft(""));
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
      hooks.write({ system: "Brakes" });
    });

    expect(urlParams()).toEqual({ status: "open", system: "Brakes" });
    expect(shownDraft()).toBe("");
  });
});

describe("pagination resets when the search changes", () => {
  test("a commit drops page and keeps the filters", async () => {
    const hooks = renderPage("/list?page=4&status=open");

    act(() => hooks.setDraft("brake"));
    await tick(DEBOUNCE_MS);

    expect(urlParams()).toEqual({ status: "open", q: "brake" });
  });

  test("a commit landing with a filter change that also drops page stays on page one", async () => {
    const hooks = renderPage("/list?page=4");

    act(() => hooks.setDraft("brake"));
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
      hooks.write({ status: "open", page: null });
    });

    expect(urlParams()).toEqual({ q: "brake", status: "open" });
  });

  test("paging after the commit is not undone by it", async () => {
    const hooks = renderPage("/list");

    act(() => hooks.setDraft("brake"));
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
      hooks.write({ page: 2 });
    });

    expect(urlParams()).toEqual({ q: "brake", page: "2" });
  });
});

describe("history, refresh, and deep links", () => {
  test("a pasted link starts the box and URL in agreement, and a filter keeps both", async () => {
    const hooks = renderPage("/list?q=brake&status=open&page=2");

    expect(shownDraft()).toBe("brake");
    act(() => hooks.write({ system: "Brakes", page: null }));
    await tick(5 * DEBOUNCE_MS);

    expect(urlParams()).toEqual({ q: "brake", status: "open", system: "Brakes" });
    expect(shownDraft()).toBe("brake");
  });

  test("Back and Forward restore the URL and the box together", async () => {
    const hooks = renderPage("/list");

    // The filter is a history step; the keyword commit replaces it.
    act(() => hooks.write({ status: "open" }));
    act(() => hooks.setDraft("brake"));
    await tick(DEBOUNCE_MS);
    expect(urlParams()).toEqual({ status: "open", q: "brake" });

    await act(async () => hooks.navigate(-1));
    expect(url()).toBe("");
    expect(shownDraft()).toBe("");

    await act(async () => hooks.navigate(1));
    expect(urlParams()).toEqual({ status: "open", q: "brake" });
    expect(shownDraft()).toBe("brake");
  });

  test("a write after Back builds on the URL Back restored, not on a stale one", async () => {
    const hooks = renderPage("/list");

    act(() => hooks.write({ status: "open" }));
    act(() => hooks.write({ system: "Brakes" }));
    await act(async () => hooks.navigate(-1));
    expect(urlParams()).toEqual({ status: "open" });

    act(() => hooks.setDraft("brake"));
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE_MS);
      hooks.write({ sort: "title" });
    });

    expect(urlParams()).toEqual({ status: "open", q: "brake", sort: "title" });
  });
});

describe("the debounce itself", () => {
  test("nothing is written before 300 ms of quiet, and typing restarts the wait", async () => {
    const hooks = renderPage("/list");

    act(() => hooks.setDraft("b"));
    await tick(DEBOUNCE_MS - 1);
    expect(url()).toBe("");

    act(() => hooks.setDraft("br"));
    await tick(DEBOUNCE_MS - 1);
    expect(url()).toBe("");

    await tick(1);
    expect(urlParams()).toEqual({ q: "br" });
  });

  test("an unrelated URL change does not restart the countdown", async () => {
    const hooks = renderPage("/list");

    act(() => hooks.setDraft("brake"));
    await tick(200);
    act(() => hooks.write({ status: "open" }));
    await tick(100);

    expect(urlParams()).toEqual({ status: "open", q: "brake" });
  });
});
