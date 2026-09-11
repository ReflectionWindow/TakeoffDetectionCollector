import { describe, expect, it } from "vitest";
import { MAX_ZOOM, applyWheel, clampZoom, fitTransform, wheelZoomFactor, zoomAbout } from "../src/lib/viewport";

describe("fitTransform", () => {
  it("shows the whole sheet when it is larger than the viewport", () => {
    const v = fitTransform(2000, 1500, 1000, 800, 0);
    expect(v.zoom).toBeCloseTo(0.5);
    expect(2000 * v.zoom).toBeLessThanOrEqual(1000);
    expect(1500 * v.zoom).toBeLessThanOrEqual(800);
  });

  it("centres the sheet in the viewport", () => {
    const v = fitTransform(1000, 1000, 800, 600, 0);
    expect(v.zoom).toBeCloseTo(0.6);
    expect(v.panX).toBeCloseTo((800 - 1000 * 0.6) / 2);
    expect(v.panY).toBeCloseTo(0);
  });

  it("fits the constraining axis of a wide sheet", () => {
    const v = fitTransform(4000, 500, 1000, 1000, 0);
    expect(v.zoom).toBeCloseTo(0.25);
    expect(v.panY).toBeGreaterThan(0);
  });

  it("leaves padding around the sheet", () => {
    const v = fitTransform(1000, 1000, 500, 500, 20);
    expect(1000 * v.zoom).toBeLessThanOrEqual(500 - 40);
  });

  it("falls back to identity for a viewport that has not been measured", () => {
    expect(fitTransform(1000, 1000, 0, 0)).toEqual({ zoom: 1, panX: 0, panY: 0 });
    expect(fitTransform(0, 0, 500, 500)).toEqual({ zoom: 1, panX: 0, panY: 0 });
  });

  it("does not magnify a small sheet past the zoom ceiling", () => {
    expect(fitTransform(10, 10, 5000, 5000, 0).zoom).toBeLessThanOrEqual(MAX_ZOOM);
  });
});

describe("clampZoom", () => {
  it("holds zoom inside the allowed range", () => {
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(0)).toBeGreaterThan(0);
    expect(clampZoom(1)).toBe(1);
  });

  it("allows zooming well past actual size for mullion work", () => {
    expect(MAX_ZOOM).toBeGreaterThanOrEqual(24);
  });
});

describe("wheelZoomFactor", () => {
  it("zooms in when scrolling up and out when scrolling down", () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
  });

  it("scales with delta magnitude instead of a fixed step", () => {
    const small = wheelZoomFactor(8);
    const large = wheelZoomFactor(100);
    expect(Math.abs(Math.log(small))).toBeLessThan(Math.abs(Math.log(large)));
    expect(small).toBeLessThan(1);
    expect(large).toBeLessThan(small);
  });

  it("treats a line-mode notch as more than a few pixels", () => {
    expect(Math.abs(Math.log(wheelZoomFactor(1, 1)))).toBeGreaterThan(Math.abs(Math.log(wheelZoomFactor(1, 0))));
  });

  it("caps a single wild tick so the sheet cannot leap", () => {
    expect(wheelZoomFactor(4000)).toBeCloseTo(wheelZoomFactor(120));
    expect(wheelZoomFactor(-4000)).toBeCloseTo(wheelZoomFactor(-120));
  });
});

describe("applyWheel", () => {
  const start = { zoom: 2, panX: 40, panY: -10 };

  it("pans the sheet on a plain scroll", () => {
    const next = applyWheel(start, { deltaX: 15, deltaY: 40 }, 200, 150);
    expect(next.zoom).toBe(2);
    expect(next.panX).toBeCloseTo(25);
    expect(next.panY).toBeCloseTo(-50);
  });

  it("zooms about the cursor when Ctrl or ⌘ is held", () => {
    const ctrl = applyWheel(start, { deltaX: 0, deltaY: -20, ctrlKey: true }, 200, 150);
    const meta = applyWheel(start, { deltaX: 0, deltaY: -20, metaKey: true }, 200, 150);
    expect(ctrl.zoom).toBeGreaterThan(start.zoom);
    expect(meta.zoom).toBeCloseTo(ctrl.zoom);
    expect((200 - ctrl.panX) / ctrl.zoom).toBeCloseTo((200 - start.panX) / start.zoom);
  });
});

describe("zoomAbout", () => {
  it("keeps the anchor point under the cursor", () => {
    const start = { zoom: 1, panX: 0, panY: 0 };
    const next = zoomAbout(start, 2, 300, 200);
    expect((300 - next.panX) / next.zoom).toBeCloseTo(300);
    expect((200 - next.panY) / next.zoom).toBeCloseTo(200);
  });

  it("keeps the anchor stable when zooming out from a panned view", () => {
    const start = { zoom: 3, panX: -120, panY: 40 };
    const before = { x: (250 - start.panX) / start.zoom, y: (180 - start.panY) / start.zoom };
    const next = zoomAbout(start, 1.5, 250, 180);
    expect((250 - next.panX) / next.zoom).toBeCloseTo(before.x);
    expect((180 - next.panY) / next.zoom).toBeCloseTo(before.y);
  });
});
