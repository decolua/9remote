let token = sessionStorage.getItem("aremote.admin") || "";
const $ = id => document.getElementById(id);
async function api(path, method = "GET", data) {
  const r = await fetch(`/api/admin/${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const result = await r.json(); if (!r.ok) { if (r.status === 401) clear(); throw new Error(result.error); } return result;
}
function clear() { token = ""; sessionStorage.removeItem("aremote.admin"); $("panel").hidden = true; $("login").hidden = false; $("code").textContent = ""; }
function action(fn) { return async e => { e?.preventDefault(); $("status").textContent = ""; try { await fn(e); } catch (err) { $("status").textContent = err.message; } }; }
function button(text, fn) { const b = document.createElement("button"); b.textContent = text; b.onclick = action(fn); return b; }
async function refresh() {
  const [data, logs] = await Promise.all([api("status"), api("logs")]);
  $("panel").hidden = false; $("login").hidden = true;
  $("metrics").textContent = `在线设备 ${data.devices.filter(d => d.online).length} · 活跃会话 ${data.sessions.length} · 上传 ${data.traffic.upload} B · 下载 ${data.traffic.download} B · 累计 ${data.traffic.total} B`;
  const table = document.createElement("table");
  for (const d of data.devices) {
    const tr = document.createElement("tr");
    for (const value of [d.name, d.role, d.revoked ? "已撤销" : d.online ? "在线" : "离线", d.lastSeen ? new Date(d.lastSeen).toLocaleString() : "尚未连接", d.id]) { const td = document.createElement("td"); td.textContent = value; tr.append(td); }
    const td = document.createElement("td"); if (!d.revoked) td.append(button("撤销授权", async () => { await api("revoke", "POST", { id: d.id }); await refresh(); })); tr.append(td); table.append(tr);
  }
  $("devices").replaceChildren(table);
  for (const [id, role] of [["clients", "client"], ["hosts", "host"]]) {
    $(id).replaceChildren(...data.devices.filter(d => d.role === role && !d.revoked).map(d => { const o = document.createElement("option"); o.value = d.id; o.textContent = d.name; return o; }));
  }
  $("grants").replaceChildren(...data.grants.map(g => { const row = document.createElement("p"); row.textContent = `${data.devices.find(d => d.id === g.clientId)?.name} → ${data.devices.find(d => d.id === g.hostId)?.name} `; row.append(button("移除访问权", async () => { await api("grants", "DELETE", g); await refresh(); })); return row; }));
  $("sessions").textContent = JSON.stringify(data.sessions, null, 2);
  $("logs").textContent = logs.map(l => `${new Date(l.time).toLocaleString()} ${l.event} ${l.deviceId || ""} ${l.sessionId || ""}`).join("\n");
}
$("login").onsubmit = action(async e => { const result = await api("login", "POST", Object.fromEntries(new FormData(e.target))); token = result.token; sessionStorage.setItem("aremote.admin", token); e.target.reset(); await refresh(); });
$("pair").onsubmit = action(async e => { const result = await api("pairings", "POST", Object.fromEntries(new FormData(e.target))); $("code").textContent = result.code; });
$("grant").onsubmit = action(async e => { await api("grants", "POST", Object.fromEntries(new FormData(e.target))); await refresh(); });
$("password").onsubmit = action(async e => { await api("password", "POST", Object.fromEntries(new FormData(e.target))); e.target.reset(); clear(); $("status").textContent = "密码已修改，请重新登录。"; });
$("refresh").onclick = action(refresh);
$("logout").onclick = action(async () => { await api("logout", "POST"); clear(); });
if (token) action(refresh)();
setInterval(() => { if (token) action(refresh)(); }, 15000);
