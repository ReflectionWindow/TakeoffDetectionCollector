import { afterEach, describe, expect, it, vi } from "vitest";
import { releaseJobOnUnload } from "../src/lib/api";

describe("releaseJobOnUnload", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends the session token as text/plain via sendBeacon", () => {
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal("navigator", { sendBeacon });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    releaseJobOnUnload("job-1", "tok-abc");

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(sendBeacon).toHaveBeenCalledWith("/v1/jobs/job-1/release", expect.any(Blob));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to keepalive fetch when sendBeacon fails", () => {
    vi.stubGlobal("navigator", { sendBeacon: () => false });
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetchMock);

    releaseJobOnUnload("job-2", "tok-xyz");

    expect(fetchMock).toHaveBeenCalledWith("/v1/jobs/job-2/release", {
      method: "POST",
      headers: { Authorization: "Bearer tok-xyz" },
      keepalive: true,
    });
  });

  it("does nothing without a token", () => {
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal("navigator", { sendBeacon });
    releaseJobOnUnload("job-3", null);
    expect(sendBeacon).not.toHaveBeenCalled();
  });
});
