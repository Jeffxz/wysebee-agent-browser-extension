// Make a captured tab fit where it is going: a model's context.
//
// captureVisibleTab returns the visible area at full device resolution — 5120x2880 on a
// big Retina screen — as PNG. A colourful page (a game, a map) at that size is many
// megabytes: past what an MCP client will take as one image (the Claude API refuses
// anything over 5 MB and scales anything over ~1568 px down anyway), and past the
// probe link's frame limit on a large enough screen. So the image is scaled to fit
// MAX_EDGE on its long side and sent as JPEG, which keeps it to a few hundred KB.
//
// Scaling changes what a pixel in the screenshot means, and browser_mouse takes its
// x/y in screenshot pixels. So this reports `pxPerCss` — screenshot pixels per CSS
// pixel of the page — and background.js remembers it per tab, so a point picked off
// this image lands where it was seen. (Before scaling, that ratio was simply
// devicePixelRatio.)
//
// Uses only what a service worker has: fetch, createImageBitmap, OffscreenCanvas.

export const MAX_EDGE = 1568;
export const JPEG_QUALITY = 0.8;

/**
 * @param {string} dataUrl  what captureVisibleTab returned
 * @param {number} cssWidth  the page's viewport width in CSS pixels (innerWidth)
 * @returns {Promise<{data: string, mime: string, width: number, height: number, pxPerCss: number}>}
 */
export async function fitScreenshot(dataUrl, cssWidth, maxEdge = MAX_EDGE, quality = JPEG_QUALITY) {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // btoa takes a binary string; build it in chunks, since spreading a megabyte of
  // bytes into one call overflows the argument limit.
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return {
    data: btoa(binary),
    mime: "image/jpeg",
    width,
    height,
    pxPerCss: cssWidth > 0 ? width / cssWidth : scale,
  };
}
