# 9Remote

Your machine, from anywhere. A remote terminal, desktop stream, and file explorer reachable from any phone or browser.

```
npm i -g 9remote
9remote
```

Scan the QR code from a phone (or open the URL) and you're on your machine's shell — over WebRTC or WebSocket, through a tunnel that closes when you stop the agent.

## What's in here

- **`agent/`** — the Node.js CLI that runs on the machine you want to reach. Serves PTY terminals (sessions survive agent restarts via a daemon), streams the screen over WebRTC with dirty-tile diffing, and exposes a jailed file explorer. Published to npm as `9remote`.
- **`web/`** — the Next.js client UI + signaling/session API, deployed to Cloudflare Workers (OpenNext) backed by D1. Terminal data does not flow through it — clients connect to the agent directly.
- **`desktop/`** — Tauri wrapper around the agent for a native macOS app.
- **`gitbook/`** — the docs site.

The transport protocol (`agent/transport/` and `web/shared/transport/`) is implemented twice, mirrored on both sides — change one, change the other.

## Self-hosting the web app

The web app runs on Cloudflare Workers and needs a Cloudflare account (the free tier works). Plain-VPS hosting is not supported — the code uses Workers bindings (D1, KV, Durable Objects, R2).

```bash
# 1. Copy the example config and create the resources it references
cp web/wrangler.toml.example web/wrangler.toml
npx wrangler d1 create 9remote
npx wrangler kv namespace create OTA_KV
# fill the printed ids into web/wrangler.toml

# 2. Secrets: copy web/.dev.vars.example → web/.dev.vars, fill in your values,
#    then push them to the Worker
npm run secrets:sync

# 3. Deploy
npm run web:deploy
```

The agent itself runs anywhere Node runs — no Cloudflare dependency.

See `agent/.env.example` for the agent-side secrets (they must match the web side's).

## License

Business Source License 1.1 — see [LICENSE](LICENSE). In short:

- Use it, build it, modify it, run it for yourself or inside your organization (including at work) — freely, including production.
- Don't offer it (or derivatives) to others as a hosted/managed service, and don't strip its license-key/entitlement/billing mechanism.
- On **2028-08-29** the code automatically becomes Apache-2.0.

For commercial licensing beyond that, open a discussion in this repository.
