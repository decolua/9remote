// Transport channel + profile config (config-driven, DRY).
// Add new protocol = 1 entry in profiles.enabled + register adapter.

export const CHANNELS = {
  control: "control",
  binary: "binary",
  file: "file"
};

// Control payload ceiling, used only when the engine does not report the SCTP
// limit itself (the browser's DC exposes maxMessageSize). Oversize envelopes are
// sliced by the adapter, not re-routed: the carrier is chosen from adapter state,
// never from the payload.
export const CONTROL_RTC_MAX_BYTES = 65536;

// RTC zombie recovery — ack timeout (detect dead-but-open DC) + restart backoff.
export const RTC_RESTART = {
  ackTimeoutMs: 5000,        // ack not received → suspect zombie → restart
  maxAttempts: 3,            // fast-retry count before switching to slow probe
  backoffMs: [500, 1500, 3000], // delay before each fast restart attempt (tight: answer normally <300ms)
  // Escalating probe cadence after the fast phase — each P2P retry is a DO
  // signaling round-trip, so back off instead of a fixed 30s forever.
  probeBackoffMs: [30000, 60000, 120000, 300000],
  // After this many failed probes, classify NAT; "hard" → give up RTC (WS-only)
  // and stop spending DO calls until the network changes.
  classifyAfterProbes: 3
};

// Standalone STUN probe used to lift an RTC give-up. A resume only re-arms RTC
// when the public IP actually changed (real network handover) — a timer would
// re-spam the DO on every long app switch even though the NAT never moved.
// This talks to public STUN only: no DO call, no agent involvement.
export const STUN_PROBE = {
  urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"],
  timeoutMs: 2500,
  // Don't re-probe more often than this — resume can fire in bursts.
  minIntervalMs: 15000
};

// Resume grace: when WS reconnects while RTC is mid-handshake (typical after
// background resume — tunnel WS beats RTC ICE gather), wait this long for RTC
// to open before resetting the terminal. If RTC opens → transparent switch, no
// flicker. If not → fall back to a WS-driven rejoin to recover content.
export const REJOIN_DEBOUNCE_MS = 500;

// A blip that recovers within the first attempts is transport noise, not news:
// the overlay already says "retrying", so the modal with its buttons waits
// until the retries are visibly not working before it interrupts.
export const RETRY_MODAL_MIN_ATTEMPT = 3;

// Control-DC liveness (ttyd pattern: periodic ping, hang up after interval+grace
// of silence). SCTP can stay "open" while an app-level stall blackholes every
// message. Agent pings, web pongs; each side also measures the other direction.
// Mirrored in agent/lib/transportConstants.js.
export const RTC_HEARTBEAT_INTERVAL_MS = 10_000;
export const RTC_HEARTBEAT_TIMEOUT_MS = 25_000;

// Max time RTC stays "connecting" before we give up. Without this, an offer that
// reached the DO before the agent joined its room is silently dropped — no answer
// ever arrives, ICE never runs, and the adapter hangs in "connecting" forever
// (only "ice failed" closes it, and ICE never starts without an answer). On
// timeout, close → PM._scheduleRtcRestart fires → re-offer; by retry 2-3 the
// agent has usually joined the signaling room and RTC opens.
export const RTC_CONNECT_TIMEOUT_MS = 4000;
// Armed once the answer lands, replacing the connect timer: that one measures
// "did the agent reply", this one measures ICE itself. Keeping a single budget
// meant a slow answer (the agent gathers against seven STUN servers) left ICE
// almost no time and the peer died on timeout every round.
// ICE normally completes in well under a second once both sides have candidates
// (89ms measured on a working path). The long tail is a dual-stack client that
// gathers IPv6 first and has to burn through those pairs before reaching a
// usable IPv4 one, so the window is sized for that fallback rather than the
// happy path.
export const RTC_ICE_TIMEOUT_MS = 15000;
// How often the dead-path watch samples getStats() while ICE is in flight. It
// only ever closes a peer whose pairs have ALL failed, so this is a fast-exit
// probe, not a second timeout — RTC_ICE_TIMEOUT_MS remains the backstop.
export const DEAD_PATH_POLL_MS = 1000;

// How long connect() waits for the signaling relay before starting RTC anyway.
// The relay is normally ready in well under a second; this covers a cold-start
// outlier so the first offer is delivered rather than buffered — and is bounded,
// so a relay that never reports ready cannot keep RTC from being attempted.
export const RTC_DEFER_MAX_MS = 12000;

// Resume-from-background probe window: after the OS suspends the tab,
// iceConnectionState events are deferred, so RTC may still report "open" while
// actually dead. On resume we sample getStats() across this window and check
// whether the selected ICE pair's responsesReceived grew (STUN keepalives flow
// on a live DC). No growth → zombie → force a full restart without waiting the
// ~30s for ICE "failed". Browser-only — no agent cooperation needed. Keep
// short: WS carries data during the probe.
export const RESUME_PROBE_TIMEOUT_MS = 2000;
// Hiding a phone app suspends WebRTC within seconds, so a peer that stayed
// hidden longer than this is dead for certain — probing it only delays the
// rebuild by the full probe window. Desktop tab-hides do not freeze WebRTC,
// so those still probe (a live peer there must not be torn down).
export const RESUME_PROBE_SKIP_HIDDEN_MS = 10000;

// DO signaling relay — fallback carrier for RTC signaling when tunnel WS is
// down/not ready. Same-origin endpoint (wss://<host>/signaling), apiKey-gated.
export const SIGNALING_CONFIG = {
  enabled: true,
  pingMs: 25000 // Hibernation auto-response — never wakes the DO, never billed
};

// Signaling errors that mean "the agent heard you, but the device isn't cleared"
// — a policy answer, not a transport failure. Mirrored in agent/lib/transportConstants.js.
// The client must show the approval UI instead of retrying/falling back.
export const SIGNALING_ERRORS = {
  pending: "pending-approval",
  rejected: "device-rejected"
};

// Why the agent refused this device's key TAIL (device:tailRejected).
// Wire format — mirrored in agent/lib/transportConstants.js.
export const TAIL_REJECT_REASON = {
  mismatch: "mismatch",              // wrong key — final, stop retrying
  sealUnreadable: "seal-unreadable", // our pinned sealing key is stale — drop it and retry plain
  timeout: "proof-timeout"           // we never proved in time
};

// Where this device stands with the host (useSocket → ConnectionModal). null
// means "no verdict yet"; `reconnect` is not a state but the event a carrier
// coming back fires, which clears a stale `approved` without inventing one.
export const APPROVAL_STATUS = {
  pending: "pending",
  approved: "approved",
  rejected: "rejected",
  reconnect: "reconnect"
};

// A one-time pairing code: six characters of code plus two of tail, shown
// together on the agent's screen and typed back as one string. Anything longer
// is an API key — which is all the login field needs to tell them apart.
export const ONE_TIME_CODE_LENGTH = 8;

// A key the user asked to remember, held until the agent accepts it.
//
// The Worker clears a v2 key by its HEAD alone, so login succeeds before
// anything has checked the TAIL. Saving at that point meant a wrong key landed
// in the saved list and had to be deleted again on refusal — which is how a
// mistyped tail could take a GOOD saved key with it. Nothing is written until
// the agent says yes.
export const PENDING_SAVE_KEY = "9remote_pending_save";

// "Remember this key" was ticked for a login that has no key to park yet.
// A one-time code only becomes a lasting key when the agent issues one, which
// happens after acceptance — so the intent is recorded here and acted on then.
export const WANTS_SAVE_KEY = "9remote_wants_save";

// Same-page storage events never fire — dispatched after EVERY saved-key list
// write (useApiKeyStorage, deviceTrust's enrollment save/upgrade) so mounted
// readers (the workspace layout's fleet sync) stay honest without callbacks.
export const KEYS_CHANGED_EVENT = "9remote:keys-changed";

// Handoff for a rejection that only becomes known after login: the Worker
// clears a key by its HEAD, but the TAIL is proven later, to the agent. The
// login page reads this on mount and shows it like any bad-key error.
export const LOGIN_ERROR_KEY = "9remote_login_error";

// Mermaid sanitises its HTML labels by default. `loose` turns that off and lets
// a label in an opened .mmd document run script in this origin, which holds the
// keys — so the default stays.
export const MERMAID_SECURITY_LEVEL = "strict";

// Network-change recovery. `online`/`connection.change` are only hints (MDN:
// onLine is "inherently unreliable"; Network Information API is absent on
// Safari), so they merely trigger a probe — the srflx IP below is the truth.
export const NET_RECOVERY = {
  debounceMs: 500 // connection.change fires in bursts on handover
};

// WS zombie recovery — detect a socket.io bus that still reports connected
// after OS background suspension froze its pings (data never flows again).
// Sized at ~2 missed cycles of the agent's pingInterval (12s), with room for a
// mobile stall: shorter than that and a phone waking up would be torn down for
// a heartbeat it was always going to send late.
export const WS_ZOMBIE_MS = 30000;

// File-transfer tunables (DC "file", separate from tiles' dcBinary).
// chunkSize + 8-byte frame header must fit dcMaxMessageSize (SCTP hard limit).
// dcBufferThreshold is generous (8MB) — file transfer is throughput, not real-time.
const FILE_FRAME_HEADER_SIZE = 8; // [uploadId u32][offset u32] — see fileFrame.js
export const FILE_TRANSFER = {
  chunkSize: 64 * 1024 - FILE_FRAME_HEADER_SIZE,
  windowSize: 64,                 // pipelining: in-flight unacked chunks
  dcBufferThreshold: 8 * 1024 * 1024,
  maxUploadSize: 50 * 1024 * 1024, // per-file cap
  maxDownloadSize: 200 * 1024 * 1024, // folder-zip cap (sum of file sizes)
  maxStreamMediaSize: 500 * 1024 * 1024 // progressive MSE streaming cap (audio/video)
};

export const ADAPTER_STATE = {
  idle: "idle",
  connecting: "connecting",
  open: "open",
  degraded: "degraded",
  closed: "closed"
};

// Per-profile config — clientApp vs remoteDesktop are independent
export const TRANSPORT_PROFILES = {
  clientApp: {
    enabled: ["ws", "rtc"],
    parallel: true,
    channels: {
      control: { strategy: "priority", prefer: "rtc" },
      binary: { strategy: "priority", prefer: "rtc" },
      file: { strategy: "priority", prefer: "rtc" }
    },
    rtc: { enableTurn: true, dcControl: { ordered: true } }
  },
  remoteDesktop: {
    enabled: ["ws", "rtc"],
    parallel: true,
    channels: {
      control: { strategy: "priority", prefer: "rtc" },
      binary: { strategy: "priority", prefer: "rtc" },
      file: { strategy: "priority", prefer: "rtc" }
    },
    rtc: { enableTurn: true, dcControl: { ordered: true } }
  }
};
