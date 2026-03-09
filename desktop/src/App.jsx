import React, { useState, useEffect } from "react"
import MainScreen from "./screens/MainScreen"

const defaultPermissions = { screenRecording: false, accessibility: false }

const defaultMainState = {
  step: 0,
  tunnelUrl: "",
  oneTimeKey: "",
  qrUrl: "",
  latency: null,
  uptime: null,
}

function parsePermissions(result) {
  return {
    screenRecording: result.screenRecording ?? result.screen_recording ?? false,
    accessibility: result.accessibility ?? false,
  }
}

async function tauriInvoke(cmd, args) {
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    return await invoke(cmd, args)
  } catch {
    return null
  }
}

async function tauriListen(event, handler) {
  try {
    const { listen } = await import("@tauri-apps/api/event")
    return await listen(event, handler)
  } catch {
    return () => {}
  }
}

const MAX_LOGS = 200

export default function App() {
  const [permissions, setPermissions] = useState(defaultPermissions)
  const [mainState, setMainState] = useState(defaultMainState)
  const [logs, setLogs] = useState([])

  useEffect(() => {
    tauriInvoke("check_permissions").then((result) => {
      if (!result) return
      setPermissions(parsePermissions(result))
    })
  }, [])

  useEffect(() => {
    let unlisten
    tauriListen("sidecar_event", (event) => {
      const raw = event.payload?.payload || event.payload || ""
      setLogs((prev) => {
        const next = [...prev, raw]
        return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next
      })
      try {
        const data = JSON.parse(raw || "{}")
        if (data.type === "step") {
          if (data.step === "ready") {
            setMainState((prev) => ({
              ...prev,
              step: 3,
              tunnelUrl: data.url || prev.tunnelUrl,
              oneTimeKey: data.key || prev.oneTimeKey,
              qrUrl: data.qrUrl || prev.qrUrl,
            }))
          } else {
            setMainState((prev) => ({ ...prev, step: Number(data.step) }))
          }
        } else if (data.type === "stats") {
          setMainState((prev) => ({ ...prev, latency: data.latency, uptime: data.uptime }))
        }
      } catch { }
    }).then((fn) => { unlisten = fn })
    return () => unlisten?.()
  }, [])

  const handleRequestPermission = async (type) => {
    await tauriInvoke("request_permission", { permissionType: type })

    let attempts = 0
    const poll = setInterval(async () => {
      attempts++
      const result = await tauriInvoke("check_permissions")
      if (!result) return

      const updated = parsePermissions(result)
      setPermissions(updated)

      if (updated.screenRecording && updated.accessibility || attempts >= 30) {
        clearInterval(poll)
      }
    }, 2000)
  }

  const handleRefresh = async () => {
    setMainState(defaultMainState)
    await tauriInvoke("restart_sidecar")
  }

  const handleStop = async () => {
    await tauriInvoke("stop_sidecar")
    setMainState(defaultMainState)
  }

  return (
    <MainScreen
      step={mainState.step}
      tunnelUrl={mainState.tunnelUrl}
      oneTimeKey={mainState.oneTimeKey}
      qrUrl={mainState.qrUrl}
      latency={mainState.latency}
      uptime={mainState.uptime}
      permissions={permissions}
      onRequestPermission={handleRequestPermission}
      onRefresh={handleRefresh}
      onStop={handleStop}
      logs={logs}
    />
  )
}
