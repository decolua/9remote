// Pure geometry/gesture math for the remote desktop canvas.
// Extracted verbatim from useCanvas — no React, no DOM refs (plain rects passed in).

export const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

// Reverse the CSS transform (pan → scale) to map container-relative px → canvas logical px
export function toCanvasPoint({ clientX, clientY, containerRect, pan, totalScale }) {
  return {
    x: (clientX - containerRect.left - pan.x) / totalScale,
    y: (clientY - containerRect.top - pan.y) / totalScale
  };
}

// Canvas logical px → clamped 0-100 server percentages
export function toPercentPoint({ canvasPoint, canvasWidth, canvasHeight }) {
  return {
    percentX: clamp((canvasPoint.x / canvasWidth) * 100, 0, 100),
    percentY: clamp((canvasPoint.y / canvasHeight) * 100, 0, 100)
  };
}

// Max pan (both axes ≤ 0) for a display size inside a container
export function maxPanFor(containerSize, displaySize) {
  return {
    x: Math.min(0, containerSize.width - displaySize.width),
    y: Math.min(0, containerSize.height - displaySize.height)
  };
}

export function clampPan(pan, maxPan) {
  return { x: clamp(pan.x, maxPan.x, 0), y: clamp(pan.y, maxPan.y, 0) };
}

// CSS scale fitting the server canvas into the container at zoom=1
export const fitScaleFor = (containerSize, serverSize) =>
  Math.min(containerSize.width / serverSize.width, containerSize.height / serverSize.height);

// Apply a zoom change keeping `focal` (container-relative px) visually fixed.
// nextZoomRaw is clamped to [1, maxZoom]; a no-op zoom still re-clamps pan.
export function zoomAtFocal({ prevZoom, prevPan, focal, nextZoomRaw, maxZoom, containerSize, displaySizeAt }) {
  const nextZoom = clamp(nextZoomRaw, 1, maxZoom);
  const zoomRatio = nextZoom / prevZoom;
  const maxPan = maxPanFor(containerSize, displaySizeAt(nextZoom));
  const rawPan = {
    x: focal.x - (focal.x - prevPan.x) * zoomRatio,
    y: focal.y - (focal.y - prevPan.y) * zoomRatio
  };
  return { zoom: nextZoom, pan: clampPan(rawPan, maxPan) };
}

// Wheel deltaMode → pixel multiplier (0=pixel, 1=line, 2=page)
export function wheelModeMultiplier(deltaMode, cfg) {
  if (deltaMode === 1) return cfg.wheelLineHeight;
  if (deltaMode === 2) return cfg.wheelPageHeight;
  return 1;
}

// Threshold accumulator: returns signed scroll lines once past the threshold, else null
export function accumulateScrollDelta({ accum, delta, threshold, multiplier }) {
  const total = accum + delta;
  if (Math.abs(total) < threshold) return { accum: total, scroll: null };
  const amount = Math.max(1, Math.round(Math.abs(total) * multiplier));
  return { accum: 0, scroll: total > 0 ? amount : -amount };
}

// Double-click: within delay AND within move threshold of the last click
export function isDoubleClick({ now, lastTime, lastPos, x, y, cfg }) {
  const timeDiff = now - lastTime;
  const dx = Math.abs(x - lastPos.x);
  const dy = Math.abs(y - lastPos.y);
  return timeDiff < cfg.doubleClickDelay && dx < cfg.moveThreshold && dy < cfg.moveThreshold;
}

// Two-finger gesture intent lock — null while still ambiguous
export function classifyGestureIntent({ elapsed, deltaDistance, deltaCentroid, cfg }) {
  const hasZoomSignal = deltaDistance >= cfg.gestureDistanceThreshold;
  const hasScrollSignal = deltaCentroid >= cfg.gestureCentroidThreshold;
  if (!hasZoomSignal && !hasScrollSignal && elapsed < cfg.gestureLockDelay) return null;
  const ratio = deltaCentroid > 0.5 ? deltaDistance / deltaCentroid : Infinity;
  if (ratio >= cfg.gestureDominanceRatio && hasZoomSignal) return "zoom";
  if (ratio <= 1 / cfg.gestureDominanceRatio && hasScrollSignal) return "scroll";
  if (hasZoomSignal && !hasScrollSignal) return "zoom";
  if (hasScrollSignal && !hasZoomSignal) return "scroll";
  return null;
}

// Trackpad speed-based acceleration multiplier (px/ms input → sensitivity multiplier)
export function trackpadMultiplier({ deltaX, deltaY, dt, cfg }) {
  const speed = Math.sqrt(deltaX * deltaX + deltaY * deltaY) / dt;
  const accel = 1 + Math.min(cfg.trackpadAcceleration, speed * cfg.trackpadAcceleration);
  return cfg.trackpadSensitivity * accel;
}

// Direct-mode 1-finger pan: clamp pan to bounds, report vertical overflow (px past the
// edge) when the canvas is stuck at top/bottom — the caller turns it into scroll.
export function panWithEdgeOverflow({ prevPan, deltaX, deltaY, containerSize, displaySize }) {
  const maxPan = maxPanFor(containerSize, displaySize);
  const next = clampPan({ x: prevPan.x + deltaX, y: prevPan.y + deltaY }, maxPan);
  const panMovedY = Math.abs(next.y - prevPan.y) > 0.5;
  const overflowY = !panMovedY ? (prevPan.y + deltaY) - next.y : 0;
  return { pan: next, overflowY };
}

// Auto-follow pan: keep a cursor point inside the viewport margin. Returns the pan
// delta needed (already clamped by caller).
export function autoFollowPanAdjust({ cursor, pan, containerSize, displaySize, totalScale, marginRatio }) {
  const marginX = containerSize.width * marginRatio;
  const marginY = containerSize.height * marginRatio;
  const screenX = cursor.x * totalScale + pan.x;
  const screenY = cursor.y * totalScale + pan.y;
  const adj = { x: 0, y: 0 };
  if (screenX < marginX) adj.x = marginX - screenX;
  else if (screenX > containerSize.width - marginX) adj.x = -(screenX - (containerSize.width - marginX));
  if (screenY < marginY) adj.y = marginY - screenY;
  else if (screenY > containerSize.height - marginY) adj.y = -(screenY - (containerSize.height - marginY));
  return adj;
}

// Momentum frame: scroll lines from velocity (0 when below min), then friction-decayed velocity
export function momentumStep(velocity, cfg) {
  if (Math.abs(velocity.y) < cfg.momentumMinVelocity) return null;
  const scrollY = Math.round(velocity.y * cfg.edgeScrollMultiplier);
  return { scrollY, nextVelocity: { x: velocity.x * cfg.momentumFriction, y: velocity.y * cfg.momentumFriction } };
}

// Keyboard auto-pan target: place focus point ~1/3 down the (shorter) visible area
export function keyboardPanTarget({ focus, containerHeight, totalScale }) {
  const targetY = containerHeight / 3;
  return { y: targetY - focus.y * totalScale };
}

export const touchDistance = (touches) => {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
};

export const touchCenter = (touches) => ({
  x: (touches[0].clientX + touches[1].clientX) / 2,
  y: (touches[0].clientY + touches[1].clientY) / 2
});
