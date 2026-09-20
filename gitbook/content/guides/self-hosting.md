# Self-Hosting 9Remote

Deploy your own private 9Remote signaling and web infrastructure on Cloudflare Workers and D1.

## Why Self-Host?

By default, 9Remote provides free hosted signaling at `https://9remote.cc`. While all data is encrypted and traffic flows peer-to-peer over WebRTC, self-hosting gives you:

- **100% Data Sovereignty:** Device approval records, session tokens, and connection metadata live exclusively in your own Cloudflare D1 database.
- **Custom Branding & Domains:** Host the web app on your own company domain (e.g. `remote.yourcompany.com`).
- **Zero Third-Party Dependency:** Completely independent of our hosted servers.

---

## Architecture Overview

The self-hosted backend runs entirely on Cloudflare's serverless edge:
- **Next.js Web App:** Packaged via OpenNext and deployed to Cloudflare Workers with static asset binding.
- **Signaling Broker:** Cloudflare Durable Objects for WebRTC session coordination.
- **Database:** Cloudflare D1 (serverless SQLite) storing user sessions and approved device records.

---

## Prerequisites

- A [Cloudflare Account](https://cloudflare.com) (Free tier is sufficient)
- Node.js 20+ and `npm`
- Wrangler CLI: `npm install -g wrangler` authenticated via `wrangler login`

---

## Deployment Steps

### Step 1: Clone the Repository
```bash
git clone https://github.com/yourusername/9remote.git
cd 9remote
npm install
```

### Step 2: Create Cloudflare D1 Database
Create the database for device management and sessions:

```bash
npx wrangler d1 create nineremote-db
```

Copy the generated `database_id` and paste it into `web/wrangler.toml` under `[[d1_databases]]`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "nineremote-db"
database_id = "YOUR_GENERATED_DATABASE_ID"
```

### Step 3: Run Database Migrations
Apply the initial database schema to your D1 database:

```bash
npx wrangler d1 execute nineremote-db --file=./web/migrations/001_initial.sql --remote
```

### Step 4: Configure Secrets
Create `web/.dev.vars` with your secret keys:

```bash
ADMIN_JWT_SECRET="your-random-32-byte-secret"
API_KEY_SECRET="your-random-32-byte-secret"
TOKEN_SECRET="your-random-32-byte-secret"
TURN_KEY_SECRET="your-turn-secret"
```

Sync these secrets to your Cloudflare production environment:
```bash
npm run secrets:sync -- --env=production
```

### Step 5: Deploy the Web Backend
Deploy the full-stack web application to Cloudflare Workers:

```bash
npm run web:deploy
```

Once deployment finishes, Wrangler will output your live URL (e.g., `https://9remote-web.yoursubdomain.workers.dev` or your custom domain).

---

## Connecting the Agent CLI to Your Backend

On your host computer (where you run terminal/desktop access), configure the 9Remote CLI to communicate with your custom backend:

### Option 1: Environment Variable
```bash
export NINEREMOTE_WORKER_URL="https://remote.yourcompany.com"
9remote start
```

### Option 2: Global Configuration
Edit `~/.9remote/config.json` (or `%USERPROFILE%\.9remote\config.json` on Windows):

```json
{
  "workerUrl": "https://remote.yourcompany.com"
}
```

Now, when you run `9remote start`, it will register its Cloudflare tunnel and broker WebRTC connections entirely through your own private infrastructure.

---

## Next Steps

- Explore [Architecture & Transport](../architecture/overview)
- Return to [Getting Started](../getting-started)
