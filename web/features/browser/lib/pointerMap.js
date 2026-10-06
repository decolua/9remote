// Frame-space → page-space mapping for the remote browser pane. Input.dispatch
// takes viewport CSS px; the frame is a jpeg scaled to the pane, meta carries
// the page's CSS viewport (deviceWidth/Height) and the pinch-zoom scale.
export function viewportPoint(offsetX, offsetY, rect, meta) {
  const scale = meta?.scale || 1;
  const deviceW = meta?.deviceWidth || rect.width;
  const deviceH = meta?.deviceHeight || rect.height;
  return {
    x: (offsetX / rect.width) * (deviceW / scale),
    y: (offsetY / rect.height) * (deviceH / scale)
  };
}
