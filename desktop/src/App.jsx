import React, { useState, useEffect } from "react"
import PermissionScreen from "./screens/PermissionScreen"
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

export default function App() {
  const [screen, setScreen] = useState("permission")
  const [permissions, setPermissions] = useState(defaultPermissions)
  const [mainState, setMainState] = useState(defaultMainState)

  // check permissions on mount
  useEffect(() => {
    tauriInvoke("check_permissions").then((result) => {
      if (!result) return
      const { screenRecording, accessibility } = result
      setPermissions({ screenRecording, accessibility })
      if (screenRecording && accessibility) {
        setScreen("main")
      }
    })
  }, [])

  // listen to sidecar raw JSON events from Rust
  useEffect(() => {
    let unlisten
    tauriListen("sidecar_event", (event) => {
      try {
        const data = JSON.parse(event.payload?.payload || event.payload || "{}")
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
    // Open System Preferences
    await tauriInvoke("request_permission", { permissionType: type })

    // Poll permissions every 2s for 60s after user opens System Prefs
    let attempts = 0
    const poll = setInterval(async () => {
      attempts++
      const result = await tauriInvoke("check_permissions")
      if (!result) return

      const updated = {
        screenRecording: result.screen_recording ?? result.screenRecording,
        accessibility: result.accessibility,
      }
      setPermissions(updated)

      if ((updated.screenRecording && updated.accessibility) || attempts >= 30) {
        clearInterval(poll)
        if (updated.screenRecording && updated.accessibility) {
          setScreen("main")
        }
      }
    }, 2000)
  }

  const handleContinue = () => {
    if (permissions.screenRecording && permissions.accessibility) {
      setScreen("main")
    }
  }

  const handleRefresh = async () => {
    setMainState(defaultMainState)
    await tauriInvoke("restart_sidecar")
  }

  const handleStop = async () => {
    await tauriInvoke("stop_sidecar")
    setMainState(defaultMainState)
  }

  if (screen === "permission") {
    return (
      <PermissionScreen
        permissions={permissions}
        onRequestPermission={handleRequestPermission}
        onContinue={handleContinue}
      />
    )
  }

  return (
    <MainScreen
      step={mainState.step}
      tunnelUrl={mainState.tunnelUrl}
      oneTimeKey={mainState.oneTimeKey}
      qrUrl={mainState.qrUrl}
      latency={mainState.latency}
      uptime={mainState.uptime}
      onRefresh={handleRefresh}
      onStop={handleStop}
    />
  )
}
