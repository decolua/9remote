import { createApp } from "./app.js";
const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
const app = await createApp({ dbPath: process.env.DATA_PATH || "./data/aremote.sqlite", adminPassword: process.env.ADMIN_PASSWORD, registrationPassword: process.env.REGISTRATION_PASSWORD, origins: (process.env.ALLOWED_ORIGINS || "").split(",").filter(Boolean), webDir: process.env.WEB_DIR, trustProxy: process.env.TRUST_PROXY === "1" });
app.http.listen(port, process.env.BIND_ADDRESS || "0.0.0.0", () => console.log(`ARemote Server listening on ${port}`));
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => { if (stopping) return; stopping = true; await app.close(); process.exit(0); });
