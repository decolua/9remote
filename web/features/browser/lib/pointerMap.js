// Stage-space → page-space mapping for the remote browser pane. The frame is
// rendered object-contain inside the stage, so the drawn image may be inset
// (letterbox bars) — map through the DISPLAYED image rect, not the stage rect.
// Input.dispatch takes viewport CSS px; meta carries the page's CSS viewport
// (deviceWidth/Height) and the pinch-zoom scale.

// Rect of a contain-fit image inside a box.
export function containRect(boxW, boxH, imgW, imgH) {
  const scale = Math.min(boxW / imgW, boxH / imgH);
  const w = imgW * scale;
  const h = imgH * scale;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

// Distance between the first two tracked touch points (pinch span).
export function pinchDistance(points) {
  const [a, b] = [...points.values()];
  if (!a || !b) return 0;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function viewportPoint(offsetX, offsetY, rect, meta) {
  const scale = meta?.scale || 1;
  const deviceW = meta?.deviceWidth || rect.width;
  const deviceH = meta?.deviceHeight || rect.height;
  // Aspect comes from the device viewport — the jpeg preserves it.
  const drawn = containRect(rect.width, rect.height, deviceW, deviceH);
  const inImage = {
    x: (offsetX - drawn.x) / drawn.w,
    y: (offsetY - drawn.y) / drawn.h
  };
  // Outside the letterboxed image: clamp to the nearest edge.
  const cx = Math.min(1, Math.max(0, inImage.x));
  const cy = Math.min(1, Math.max(0, inImage.y));
  return {
    x: cx * (deviceW / scale),
    y: cy * (deviceH / scale)
  };
}
