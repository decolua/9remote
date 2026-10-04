// Popup = connection status + the one control that matters: cutting host
// access. Everything actionable lives in the 9remote web UI.
const $ = (id) => document.getElementById(id);
const ask = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, r));

async function render() {
  const s = await ask({ t: "status" });
  if (!s) return;
  $("ver").textContent = "v" + (s.version || "");
  $("host").textContent = s.host || "";
  const paused = Boolean(s.paused);
  $("dot").className = "dot " + (paused ? "cut" : s.connected ? "on" : "off");
  $("label").textContent = paused ? "Bridge paused" : s.connected ? "Connected" : "Reconnecting…";
  $("pauseHint").textContent = paused ? "Blocked until you turn it back on" : "Host may drive this browser";
  $("bridge").checked = !paused;
}

$("bridge").addEventListener("change", async (e) => {
  await ask({ t: "setPaused", paused: !e.target.checked });
  render();
});

render();
