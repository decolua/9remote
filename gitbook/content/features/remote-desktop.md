# Remote Desktop

Low-latency screen streaming and remote control powered by WebRTC.

## What It Does

9Remote Desktop lets you view and interact with your computer's screen from any device with high responsiveness. It uses peer-to-peer WebRTC data channels and intelligent dirty-tile compression to deliver smooth control even over cellular networks.

## Core Features

### High-Performance WebRTC Streaming
- **Sub-50ms Latency:** Screen data flows directly between your host computer and your client device using WebRTC data channels.
- **Dirty-Tile Diffing:** Instead of re-encoding the entire display on every frame, 9Remote's `TileManager` detects and transmits only the rectangular regions of the screen that changed.
- **Hardware-Accelerated Encoding:** Uses native high-speed JPEG compression (`@julusian/jpeg-turbo` on Windows, native image pipelines on macOS/Linux) to keep host CPU usage minimal.

### Intuitive Touch & Mouse Input
- **Touch Mode (Mobile):**
  - Tap anywhere to left-click.
  - Long press for right-click.
  - Two-finger drag to scroll smoothly.
  - Pinch-to-zoom to inspect fine UI elements or code.
- **Trackpad / Pointer Mode:** Use your phone screen as a precision laptop trackpad with left/right click buttons.
- **Mouse Drag:** Click and hold to drag windows, move sliders, or select text.

### Keyboard & Clipboard
- Floating mobile virtual keyboard toolbar with Ctrl, Alt, Shift, Esc, and arrow keys.
- **Clipboard Sync:** Copy text on your phone and paste it directly into your remote computer, or vice versa.

### Dynamic Quality Adjustment
Adjust streaming profile according to your connection:
- **High:** Maximum clarity and crisp text rendering.
- **Balanced (Default):** Optimal balance between clarity and bandwidth.
- **Performance:** Low bandwidth, high frame rate for constrained mobile data.

---

## Tips for the Best Experience

- **Landscape Orientation:** Rotate your mobile device to landscape for a natural desktop aspect ratio.
- **WiFi vs Mobile Data:** On metered mobile connections, choose Balanced or Performance mode in the streaming settings.
- **Turn Off When Not In Use:** Stop the stream when switching to Terminal or File Explorer to preserve battery and bandwidth.

---

## Limitations

- **Multi-Monitor:** Currently captures the primary display.
- **Audio:** Audio streaming is not currently supported (optimized for productivity and development, not media playback or gaming).

---

## Next Steps

- Browse files and code with [File Explorer](file-explorer)
- Run commands with [Terminal](terminal)
