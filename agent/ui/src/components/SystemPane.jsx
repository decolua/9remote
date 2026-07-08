import { useState, useEffect, useRef } from "preact/hooks";
import { useI18n } from "../i18n";

const POLL_MS = 5000;

function fmtUptime(sec) {
  if (!sec && sec !== 0) return "--";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtBytes(mb) {
  if (mb == null) return "--";
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}

function memPct(used, total) {
  if (!total) return 0;
  return Math.min(100, (used / total) * 100);
}

function Bar({ pct, color = "var(--brand-500)" }) {
  return (
    <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: "var(--border)" }}>
      <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

function StatRow({ icon, label, value, sub, pct, barColor }) {
  return (
    <div className="flex flex-col gap-1 py-2 border-b last:border-0" style={{ borderColor: "var(--border)" }}>
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: 16, color: "var(--text-muted)" }}>{icon}</span>
        <span className="text-xs flex-1" style={{ color: "var(--text-muted)" }}>{label}</span>
        <span className="text-xs font-mono font-medium" style={{ color: "var(--text-main)" }}>{value}</span>
      </div>
      {sub && <p className="text-[10px] pl-6" style={{ color: "var(--text-muted)" }}>{sub}</p>}
      {pct != null && <div className="pl-6"><Bar pct={pct} color={barColor} /></div>}
    </div>
  );
}

function SectionCard({ icon, title, children, t }) {
  return (
    <div className="card-elev p-5 flex flex-col gap-1">
      <div className="flex items-center gap-2.5 mb-2.5">
        <span className="material-symbols-outlined flex items-center justify-center w-8 h-8 rounded-lg flex-shrink-0" style={{ fontSize: 18, color: "var(--brand-500)", background: "var(--brand-tint)" }}>{icon}</span>
        <p className="text-[13px] font-bold tracking-tight" style={{ color: "var(--text-main)" }}>{title}</p>
      </div>
      {children}
    </div>
  );
}

export default function SystemPane() {
  const { t } = useI18n();
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(false);
  const timerRef = useRef(null);

  const fetchStats = async () => {
    try {
      const r = await fetch("/api/system/stats", { cache: "no-store" });
      if (!r.ok) throw new Error();
      const d = await r.json();
      setStats(d);
      setError(false);
    } catch {
      setError(true);
    }
  };

  useEffect(() => {
    fetchStats();
    timerRef.current = setInterval(fetchStats, POLL_MS);
    return () => clearInterval(timerRef.current);
  }, []);

  if (error && !stats) {
    return <p className="text-xs text-center mt-8" style={{ color: "var(--text-muted)" }}>{t("system.unavailable") || "Unable to load system stats"}</p>;
  }
  if (!stats) {
    return <p className="text-xs text-center mt-8" style={{ color: "var(--text-muted)" }}>Loading…</p>;
  }

  const { agent, os, remote } = stats;
  const heapPct = memPct(agent.memory.heapUsedMB, agent.memory.heapTotalMB);
  const rssPct = memPct(agent.memory.rssMB, os.totalMemMB);
  const freeMemPct = memPct(os.freeMemMB, os.totalMemMB);
  const heapWarn = agent.memory.heapUsedMB > (remote.memoryWarningThresholdMB || 1000);

  return (
    <div className="flex flex-col gap-5 max-w-2xl mx-auto w-full">
      <SectionCard icon="memory" title={t("system.agent") || "Agent"}>
        <StatRow icon="tag" label="Version" value={agent.version || "--"} sub={`${agent.nodeVersion} · PID ${agent.pid}`} />
        <StatRow icon="schedule" label={t("system.uptime") || "Uptime"} value={fmtUptime(agent.uptimeSec)} />
        <StatRow
          icon="memory"
          label={t("system.heapUsed") || "Heap used"}
          value={fmtBytes(agent.memory.heapUsedMB)}
          sub={`${t("system.heapTotal") || "total"} ${fmtBytes(agent.memory.heapTotalMB)} · ${t("system.external") || "external"} ${fmtBytes(agent.memory.externalMB)}`}
          pct={heapPct}
          barColor={heapWarn ? "var(--danger)" : "var(--brand-500)"}
        />
        <StatRow
          icon="developer_board"
          label="RSS"
          value={fmtBytes(agent.memory.rssMB)}
          sub={`${t("system.ofOsTotal") || "of OS"} ${fmtBytes(os.totalMemMB)}`}
          pct={rssPct}
          barColor="var(--info)"
        />
      </SectionCard>

      <SectionCard icon="computer" title={t("system.machine") || "Machine"}>
        <StatRow icon="dns" label="Hostname" value={os.hostname} sub={`${os.platform} · ${os.arch}`} />
        <StatRow icon="schedule" label={t("system.osUptime") || "OS uptime"} value={fmtUptime(os.uptimeSec)} />
        <StatRow icon="developer_board" label="CPU" value={`${os.cpuCount}×`} sub={os.cpuModel} />
        <StatRow
          icon="speed"
          label={t("system.loadAvg") || "Load avg"}
          value={os.loadAvg.map((l) => l.toFixed(2)).join(" / ")}
          sub={t("system.loadDesc") || "1m / 5m / 15m"}
        />
        <StatRow
          icon="memory"
          label={t("system.freeMem") || "Free memory"}
          value={fmtBytes(os.freeMemMB)}
          sub={`${t("system.ofOsTotal") || "of"} ${fmtBytes(os.totalMemMB)}`}
          pct={freeMemPct}
          barColor="var(--success)"
        />
      </SectionCard>

      <SectionCard icon="desktop_windows" title={t("system.remoteDesktop") || "Remote Desktop"}>
        <StatRow
          icon={remote.available ? "check_circle" : "cancel"}
          label={t("system.status") || "Status"}
          value={remote.available ? (t("system.available") || "Available") : (t("system.offline") || "Offline")}
        />
        <StatRow
          icon="devices"
          label={t("system.clients") || "Clients"}
          value={`${remote.total}`}
          sub={remote.streaming > 0 ? `${remote.streaming} ${t("system.streaming") || "streaming"}` : (t("system.idle") || "idle")}
        />
        <StatRow
          icon="warning"
          label={t("system.ramThreshold") || "RAM warning"}
          value={`${remote.memoryWarningThresholdMB} MB`}
          sub={heapWarn ? (t("system.thresholdExceeded") || "threshold exceeded") : (t("system.thresholdOk") || "within limit")}
        />
      </SectionCard>
    </div>
  );
}
