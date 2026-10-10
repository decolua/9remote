// EPIPE from a parent-closed stdout/stderr pipe (Windows GUI/Tauri spawn) must not
// become a fatal uncaughtException — it killed the whole server over a QR-code
// print (#47/#50). Must be the first import of every entry so it is installed
// before the first console write.
for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.("error", (err) => {
    if (err?.code !== "EPIPE") throw err;
  });
}
