import { describe, it, expect, vi, afterEach } from "vitest";
import { requestJson } from "./apiClient.js";

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
