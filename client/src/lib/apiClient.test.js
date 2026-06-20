import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchAllImageAttachments,
  fetchSuggestedProcedures,
  requestJson,
  setProcedureSymptoms,
  setSymptomProcedures,
} from "./apiClient.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function mockFetchOnce(response) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
}

describe("requestJson", () => {
  it("returns the parsed JSON body on success", async () => {
    mockFetchOnce({ ok: true, json: async () => ({ value: 42 }) });

    const payload = await requestJson("/api/thing");
    expect(payload).toEqual({ value: 42 });
  });

  it("forwards fetch options without the errorMessage field", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    await requestJson("/api/thing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      errorMessage: "should not be forwarded",
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/thing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  });

  it("throws the server-provided error when the response is not ok", async () => {
    mockFetchOnce({ ok: false, json: async () => ({ error: "Boom" }) });

    await expect(requestJson("/api/thing", { errorMessage: "fallback" })).rejects.toThrow(
      "Boom"
    );
  });

  it("throws the fallback message when the body has no error field", async () => {
    mockFetchOnce({ ok: false, json: async () => ({}) });

    await expect(requestJson("/api/thing", { errorMessage: "fallback" })).rejects.toThrow(
      "fallback"
    );
  });
});

describe("fetchAllImageAttachments", () => {
  it("requests the all-attachments endpoint and returns the attachments array", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ attachments: [{ id: 1 }, { id: 2 }], total: 2 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchAllImageAttachments();

    expect(fetchMock).toHaveBeenCalledWith("/api/attachments/all", {});
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("returns an empty array when the payload has no attachments", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    );

    const result = await fetchAllImageAttachments();

    expect(result).toEqual([]);
  });
});

describe("symptom <-> procedure link helpers", () => {
  it("setSymptomProcedures PUTs the procedure ids and returns the body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ symptom: { id: 1 } }) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await setSymptomProcedures(1, [2, 3]);

    expect(fetchMock).toHaveBeenCalledWith("/api/symptoms/1/procedures", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ procedureIds: [2, 3] }),
    });
    expect(result).toEqual({ symptom: { id: 1 } });
  });

  it("setProcedureSymptoms PUTs the symptom ids and returns the body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ procedure: { id: 9 } }) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await setProcedureSymptoms(9, [4]);

    expect(fetchMock).toHaveBeenCalledWith("/api/procedures/9/symptoms", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symptomIds: [4] }),
    });
    expect(result).toEqual({ procedure: { id: 9 } });
  });

  it("fetchSuggestedProcedures GETs the suggestion endpoint", async () => {
    const payload = { status: "answered", suggestions: [{ procedureId: 2 }] };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchSuggestedProcedures(1);

    expect(fetchMock).toHaveBeenCalledWith("/api/symptoms/1/suggested-procedures", {});
    expect(result).toEqual(payload);
  });
});
