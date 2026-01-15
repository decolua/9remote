import { TerminalManager } from "./terminal.js";

// State
let socket = null;
let terminal = null;
let apiKey = null;
let tunnelUrl = null;

// DOM Elements
const $ = (id) => document.getElementById(id);
const loginScreen = $("login-screen");
const terminalScreen = $("terminal-screen");
const tokenAuthDiv = $("token-auth");
const manualAuthDiv = $("manual-auth");
const apiKeyInput = $("apiKey");
const connectBtn = $("connectBtn");
const disconnectBtn = $("disconnectBtn");
const statusEl = $("status");
const connectionStatus = $("connection-status");

// Check for token in URL on load
window.addEventListener("DOMContentLoaded", async () => {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("t");
  
  console.log("[DEBUG] URL params:", { token: token ? "exists" : "missing" });
  
  if (token) {
    // Auto-auth with token
    console.log("[DEBUG] Token found, starting auto-auth");
    tokenAuthDiv.classList.remove("hidden");
    manualAuthDiv.classList.add("hidden");
    await handleTokenAuth(token);
  } else {
    console.log("[DEBUG] No token, showing manual auth");
  }
});

// Event Listeners
connectBtn.addEventListener("click", handleManualConnect);
disconnectBtn.addEventListener("click", handleDisconnect);

/**
 * Handle token-based auth (from QR code)
 */
async function handleTokenAuth(token) {
  try {
    console.log("[DEBUG] handleTokenAuth called");
    showStatus("Validating token...", "loading");
    
    // Validate token with API
    console.log("[DEBUG] Fetching /api/connect with token");
    const res = await fetch("/api/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token })
    });

    console.log("[DEBUG] Response status:", res.status);
    
    if (!res.ok) {
      const data = await res.json();
      console.error("[DEBUG] API error:", data);
      throw new Error(data.error || "Invalid or expired token");
    }

    const data = await res.json();
    console.log("[DEBUG] API response:", data);
    apiKey = data.apiKey;
    tunnelUrl = data.tunnelUrl;

    showStatus("Connecting to terminal...", "loading");
    connectSocket();

  } catch (err) {
    console.error("[DEBUG] Error in handleTokenAuth:", err);
    showStatus(err.message, "error");
    // Show manual auth as fallback
    setTimeout(() => {
      tokenAuthDiv.classList.add("hidden");
      manualAuthDiv.classList.remove("hidden");
    }, 2000);
  }
}

/**
 * Handle manual key entry
 */
async function handleManualConnect() {
  const key = apiKeyInput.value.trim();
  
  if (!key) {
    showStatus("Please enter API key", "error");
    return;
  }

  connectBtn.disabled = true;
  showStatus("Validating key...", "loading");

  try {
    // Validate with API (using key directly)
    const res = await fetch("/api/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: key })
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || "Invalid API key");
    }

    const data = await res.json();
    apiKey = key;
    tunnelUrl = data.tunnelUrl;

    showStatus("Connecting to terminal...", "loading");
    connectSocket();

  } catch (err) {
    showStatus(err.message, "error");
    connectBtn.disabled = false;
  }
}

function connectSocket() {
  if (!tunnelUrl) {
    showStatus("No tunnel URL", "error");
    return;
  }

  socket = io(tunnelUrl, {
    path: "/socket.io",
    transports: ["polling", "websocket"]
  });

  socket.on("connect", () => {
    showStatus("Connected!", "success");
    showTerminalScreen();
  });

  socket.on("output", (data) => {
    if (terminal) {
      terminal.write(data);
    }
  });

  socket.on("disconnect", () => {
    updateConnectionStatus(false);
  });

  socket.on("connect_error", (err) => {
    showStatus("Connection failed: " + err.message, "error");
    connectBtn.disabled = false;
  });
}

function showTerminalScreen() {
  // Prevent double initialization
  if (terminal) {
    console.log("[DEBUG] Terminal already initialized, skipping");
    loginScreen.classList.add("hidden");
    terminalScreen.classList.remove("hidden");
    updateConnectionStatus(true);
    return;
  }

  loginScreen.classList.add("hidden");
  terminalScreen.classList.remove("hidden");

  // Init terminal ONCE
  terminal = new TerminalManager("terminal").init();

  // Send input to server
  terminal.onData((data) => {
    if (socket?.connected) {
      socket.emit("input", data);
    }
  });

  // Handle resize (store reference for cleanup)
  const resizeHandler = () => {
    if (socket?.connected && terminal) {
      socket.emit("resize", terminal.getSize());
    }
  };
  
  // Store handler for cleanup
  terminal._resizeHandler = resizeHandler;
  window.addEventListener("resize", resizeHandler);

  updateConnectionStatus(true);
}

function handleDisconnect() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }

  if (terminal) {
    // Remove resize handler to prevent memory leak
    if (terminal._resizeHandler) {
      window.removeEventListener("resize", terminal._resizeHandler);
      terminal._resizeHandler = null;
    }
    
    terminal.dispose();
    terminal = null;
  }

  terminalScreen.classList.add("hidden");
  loginScreen.classList.remove("hidden");
  connectBtn.disabled = false;
  showStatus("", "info");
}

function showStatus(message, type = "info") {
  statusEl.textContent = message;
  statusEl.className = "text-sm text-center";
  
  const colors = {
    error: "text-red-400",
    success: "text-green-400",
    loading: "text-blue-400",
    info: "text-gray-400"
  };
  
  statusEl.classList.add(colors[type] || colors.info);
}

function updateConnectionStatus(isConnected) {
  const dot = connectionStatus.querySelector("span:first-child");
  const text = connectionStatus.querySelector("span:last-child");

  if (isConnected) {
    dot.className = "w-2 h-2 rounded-full bg-green-500 animate-pulse";
    text.textContent = "Connected";
  } else {
    dot.className = "w-2 h-2 rounded-full bg-red-500";
    text.textContent = "Disconnected";
  }
}
