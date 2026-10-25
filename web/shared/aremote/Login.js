"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { clearDevice, normalizeServer, readDevice, relayApi, saveDevice } from "./client";
import { setAuthData } from "@/shared/hooks/useSessionStorage";
import Container from "@/shared/components/ui/Container";
import AnimatedBackground from "@/features/landing/components/AnimatedBackground";
import ThemeToggle from "@/shared/theme/ThemeToggle";
export default function ARemoteLogin() {
  const router = useRouter();
  const [device, setDevice] = useState(null), [hosts, setHosts] = useState([]), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [server, setServer] = useState(""), [port, setPort] = useState(""), [name, setName] = useState("ARemote Client"), [credential, setCredential] = useState(""), [kind, setKind] = useState("code");
  async function refresh(d) { const result = await relayApi("/api/hosts", null, d); setHosts(result.hosts); }
  useEffect(() => { const d = readDevice(); setDevice(d); setServer(d?.server || window.location.origin); if (d) refresh(d).catch(e => setError(e.message)); }, []);
  useEffect(() => { if (!device) return; const timer = setInterval(() => refresh(device).catch(e => setError(e.message)), 15000); return () => clearInterval(timer); }, [device]);
  async function register(e) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      const origin = normalizeServer(server, port);
      const data = await relayApi("/api/devices/register", { role: "client", name, [kind]: credential }, { server: origin });
      const d = { server: origin, ...data }; saveDevice(d); setDevice(d); setCredential(""); await refresh(d);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  function connect(host) { setAuthData({ apiKey: host.id, tunnelUrl: device.server, mode: "remote" }); router.push("/workspace"); }
  const field = "w-full rounded-lg border border-white/20 bg-transparent p-3 my-2";
  return <><AnimatedBackground /><Container><div className="relative mx-auto my-16 w-full max-w-lg rounded-2xl border border-white/10 bg-black/60 p-8 text-white"><div className="flex justify-between"><h1 className="text-3xl font-bold">ARemote</h1><ThemeToggle /></div><p className="my-4 text-white/60">连接你的自托管 Agent 平台</p>{error && <p role="alert" className="my-4 text-red-300">{error}</p>}{!device ? <form onSubmit={register}><label>Server 地址<input className={field} value={server} onChange={e => setServer(e.target.value)} placeholder="https://remote.example.com" required /></label><label>端口（可选）<input className={field} value={port} onChange={e => setPort(e.target.value)} type="number" min="1" max="65535" /></label><label>设备名称<input className={field} value={name} onChange={e => setName(e.target.value)} maxLength={100} required /></label><label>认证方式<select className={field} value={kind} onChange={e => setKind(e.target.value)}><option value="code">一次性设备配对码</option><option value="password">注册密码</option></select></label><input aria-label="注册密码或配对码" type="password" className={field} value={credential} onChange={e => setCredential(e.target.value)} required autoComplete="off" /><button disabled={busy} className={field}>{busy ? "连接中…" : "认证并注册此设备"}</button></form> : <><p className="break-all">{device.server}</p><h2 className="my-4 text-xl">已授权 Host</h2>{hosts.length === 0 && <p>暂无授权 Host，请管理员在管理后台授权此 Client。</p>}{hosts.map(h => <button key={h.id} disabled={!h.online} onClick={() => connect(h)} className={field}>{h.name} · {h.online ? "在线 — 连接" : "离线"}</button>)}<button className={field} onClick={() => refresh(device).catch(e => setError(e.message))}>刷新列表</button><button className={field} onClick={async () => { try { const r = await relayApi("/api/devices/rotate", {}, device); const d = { ...device, token: r.token }; saveDevice(d); setDevice(d); } catch (e) { setError(e.message); } }}>轮换设备凭证</button><button className={field} onClick={() => { clearDevice(); sessionStorage.clear(); localStorage.removeItem("9remote_auth_state"); setDevice(null); setHosts([]); }}>退出 / 更换 Server</button></>}</div></Container></>;
}
