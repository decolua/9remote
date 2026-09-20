# Site Browser

Test and interact with local dev servers (`localhost:3000`, `localhost:5173`, etc.) directly on your phone without exposing ports or setting up tunnels.

## What It Does

When developing web apps, you usually run dev servers like Next.js, Vite, or Django on `localhost`. Viewing them on a remote device typically requires complex port forwarding, reverse proxies, or cloud tunnels.

9Remote's **Site Browser** solves this seamlessly: it embeds a virtual browser right inside your 9Remote Workspace backed by a client Service Worker bridge. It routes all HTTP and asset traffic over your encrypted 9Remote connection directly to your host's local loopback.

---

## Key Features

### Zero Port Forwarding
- Preview `http://localhost:3000`, `http://localhost:5173`, `http://localhost:8080`, or any local port.
- No public IP, no firewall rules, and no third-party tunnel tools (like ngrok) needed.

### Real Mobile Device Testing
- Test touch interactions, responsive layouts, and mobile keyboards on real iOS and Android screens instead of browser devtools emulation.

### Service Worker Virtual Bridge
- Uses an in-browser Service Worker (`/workspace/browse`) to transparently proxy HTML, CSS, JavaScript chunks, images, and API requests.
- Prioritizes low-latency WebRTC data channels with automatic WebSocket fallback.

### Integrated Browser Controls
- **Address Bar:** Easily type target URLs (e.g., `localhost:3000/dashboard`).
- **Quick Port Switcher:** Quick buttons to jump between active ports (`3000`, `5173`, `8000`, `8080`).
- **Navigation Tools:** Back, Forward, Refresh, and Console log viewer.

---

## How to Use

1. Start your dev server in the 9Remote **Terminal** (for example: `npm run dev`).
2. Note the local port (e.g. `localhost:3000`).
3. In 9Remote, navigate to the **Browse** tab.
4. Enter `localhost:3000` or select the port from the quick bar.
5. Your local web application renders live!

---

## Security

- All requests are routed through your authenticated 9Remote session.
- Only reachable by approved devices connected to your computer.
- Host-side protection prevents unauthorized access outside local loopback networks.

---

## Next Steps

- Explore [Remote Desktop](remote-desktop)
- Learn about [File Explorer & Transfer](file-explorer)
