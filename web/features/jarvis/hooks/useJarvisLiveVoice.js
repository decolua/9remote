"use client";

// The live voice conductor — Gemini 3.8 Live over WebSocket, speech-to-speech
// with barge-in, running the SAME coordinator tools the chat Jarvis has. The
// manifest comes from the agent (jarvis:tools) so the wire schemas have one
// source; tool calls ride jarvis:tool. Turn-based voice (useVoiceInput) stays
// untouched — this is the parallel live surface.
import { useCallback, useEffect, useRef, useState } from "react";
import { JARVIS_LIVE_MODEL, JARVIS_LIVE_SYSTEM_PROMPT, liveToolDeclarations } from "@/shared/lib/jarvisConstants";

const IN_RATE = 16000;   // mic chunks the Live API expects
const OUT_RATE = 24000;  // audio the model streams back

// ── Cost gate: hybrid VAD, Google's recommended shape ──
// Server VAD stays ON (it catches speech starts with prefix padding, so word
// onsets are never clipped). This gate only decides WHICH chunks leave the
// socket — input audio is billed as received, so silence that is never sent is
// silence never paid for — and sends audioStreamEnd once the user goes quiet,
// which finalizes the turn with less latency than the server's own silence wait.
const CHUNK_SAMPLES = 1024;   // 64ms per chunk — docs advise 20-100ms for latency
const PRE_ROLL_CHUNKS = 5;    // ~320ms kept locally, flushed when speech starts
const SPEECH_RMS = 0.03;      // mean absolute amplitude that counts as voice
const SILENCE_FINALIZE_MS = 500;  // quiet this long → audioStreamEnd (turn finalizes)
const SILENCE_PAUSE_MS = 1000;   // quiet this long → stop streaming (billing stops)

// Live re-bills the WHOLE context every turn; the SDK default trigger is 80% of
// the 128k window (~68 min of audio equivalent) — a compounding bomb. A small
// cap fits Jarvis's task-shaped calls: cheaper turns AND faster ones (shorter
// context = faster responses, per the docs).
const COMPRESSION_TRIGGER_TOKENS = 12000;
const COMPRESSION_TARGET_TOKENS = 6000;

export function createSpeechGate({ sendChunk, sendStreamEnd, now = () => Date.now() }) {
  const ring = [];
  let sending = false;
  let lastSpeechAt = 0;
  let sentStreamEnd = true;
  return {
    onChunk(chunk, level) {
      const t = now();
      const spoke = level >= SPEECH_RMS;
      if (spoke) lastSpeechAt = t;
      if (spoke && !sending) {
        sending = true;
        sentStreamEnd = false;
        for (const pre of ring) sendChunk(pre); // the onset rides its own pre-roll
      }
      ring.push(chunk);
      if (ring.length > PRE_ROLL_CHUNKS) ring.shift();
      if (!sending) return; // idle silence: not one byte leaves the socket
      if (t - lastSpeechAt >= SILENCE_PAUSE_MS) {
        sending = false; // docs: a stream paused >1s should be ended; resuming just sends again
        return;
      }
      if (!sentStreamEnd && t - lastSpeechAt >= SILENCE_FINALIZE_MS) {
        sentStreamEnd = true;
        try { sendStreamEnd(); } catch { /* the socket can die mid-signal; onclose reports */ }
      }
      sendChunk(chunk); // hangover audio keeps the server VAD fed through short pauses
    }
  };
}

export function useJarvisLiveVoice({ busRef, apiKey, voice, model }) {
  // idle → connecting → live; error falls back to idle with a message.
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  // {who: "user"|"jarvis"|"tool", text} — newest last, capped.
  const [entries, setEntries] = useState([]);
  // Running context size from usageMetadata — the number the bill compounds on.
  const [tokens, setTokens] = useState(0);
  const push = useCallback((who, text) => {
    if (!text) return;
    setEntries((prev) => [...prev.slice(-40), { who, text: String(text).slice(0, 400) }]);
  }, []);
  const ref = useRef({});

  const stop = useCallback(() => {
    const s = ref.current;
    ref.current = {};
    if (s?.levelProbe) clearTimeout(s.levelProbe);
    try { s.session?.close?.(); } catch {}
    for (const src of s.playing || []) { try { src.stop(); } catch {} }
    s.processor?.disconnect?.();
    s.mute?.disconnect?.();
    s.stream?.getTracks?.().forEach((t) => t.stop());
    try { s.inCtx?.close(); } catch {}
    try { s.outCtx?.close(); } catch {}
    setStatus("idle");
  }, []);

  // Closing the view ends the call — a live mic must not outlive its UI.
  useEffect(() => stop, [stop]);

  const start = useCallback(async () => {
    if (!apiKey) {
      setError("Add a Google AI key in Jarvis settings first");
      setStatus("error");
      return;
    }
    stop();
    setError("");
    setEntries([]);
    setTokens(0);
    setStatus("connecting");

    // One promise per socket emit, always settled: an agent without the handler
    // (not restarted) would otherwise leave this pending forever — the call
    // would sit on "connecting" with no answer and no error.
    const emit = (event, payload) =>
      new Promise((resolve) => {
        let settled = false;
        const done = (value) => { if (!settled) { settled = true; resolve(value); } };
        const timer = setTimeout(() => done({ ok: false, error: "agent timeout — restart the agent?" }), 5000);
        try {
          busRef.current?.emit?.(event, payload, (res) => { clearTimeout(timer); done(res); });
        } catch (e) {
          clearTimeout(timer);
          done({ ok: false, error: e?.message || "bus unavailable" });
        }
      });

    try {
      const [{ GoogleGenAI, Modality }, manifestRes] = await Promise.all([
        import("@google/genai"),
        emit("jarvis:tools", {})
      ]);
      // A missing manifest (old agent) degrades to a plain voice call rather
      // than a dead one — the panel says why, the next agent restart restores tools.
      const declarations = liveToolDeclarations(manifestRes?.tools || []);
      if (!declarations.length) {
        push("tool", `no coordinator tools (${manifestRes?.error || "empty manifest"}) — voice only; restart the agent to get tools`);
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const inCtx = new AudioContext({ sampleRate: IN_RATE });
      await inCtx.resume?.().catch?.(() => {});
      const src = inCtx.createMediaStreamSource(stream);
      // ScriptProcessor over AudioWorklet on purpose: it works everywhere this
      // app runs (incl. WKWebView) without shipping a worklet module (ponytail:
      // swap when AudioWorklet is needed for echo control).
      const processor = inCtx.createScriptProcessor(CHUNK_SAMPLES, 1, 1);
      const mute = inCtx.createGain();
      mute.gain.value = 0; // pull the processor without hearing ourselves
      src.connect(processor);
      processor.connect(mute);
      mute.connect(inCtx.destination);

      const s = ref.current;
      s.stream = stream;
      s.inCtx = inCtx;
      s.processor = processor;
      s.mute = mute;
      s.playing = [];
      s.maxLevel = 0;
      // TEMP DIAGNOSTIC — if the gate never opens the call is mute with no clue
      // why. After 3s of "live" with no speech seen, say what the mic actually
      // delivered, so a too-high threshold or a dead mic is a number, not a guess.
      s.levelProbe = setTimeout(() => {
        if (ref.current === s && !s.speechSeen) {
          if (s.maxLevel === 0) push("tool", "no mic signal — check microphone permission");
          else if (s.maxLevel < SPEECH_RMS) push("tool", `mic very quiet (peak ${s.maxLevel.toFixed(3)} < threshold ${SPEECH_RMS}) — speak up or move closer`);
        }
      }, 3000);
      s.levelProbe.unref?.();

      const ai = new GoogleGenAI({ apiKey });
      const session = await ai.live.connect({
        model: model || JARVIS_LIVE_MODEL,
        callbacks: {
          onmessage: (m) => handleServer(m),
          onerror: (e) => { setError(e?.message || "live connection error"); setStatus("error"); },
          onclose: () => setStatus((cur) => (cur === "idle" ? cur : "idle"))
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: JARVIS_LIVE_SYSTEM_PROMPT,
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || "Puck" } } },
          tools: [{ functionDeclarations: declarations }],
          // Capped compression — see COMPRESSION_TRIGGER_TOKENS above.
          contextWindowCompression: {
            triggerTokens: COMPRESSION_TRIGGER_TOKENS,
            slidingWindow: { targetTokens: COMPRESSION_TARGET_TOKENS }
          },
          // Transcripts power the live panel; the text-token surcharge is
          // pennies next to per-minute audio. Drop these two lines and the
          // panel degrades to tool calls only.
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        }
      });
      s.session = session;
      if (!ref.current.session) return stop(); // stop() raced us — the view closed mid-connect

      // The cost gate from this file's header: idle silence never leaves the
      // socket, and end-of-speech is finalized with one audioStreamEnd.
      const gate = createSpeechGate({
        sendChunk: (pcm) => {
          try { session.sendRealtimeInput({ media: new Blob([pcm], { type: `audio/pcm;rate=${IN_RATE}` }) }); }
          catch { /* the socket can die between chunks; onclose reports it */ }
        },
        sendStreamEnd: () => session.sendRealtimeInput({ audioStreamEnd: true })
      });
      processor.onaudioprocess = (e) => {
        if (ref.current.session !== session) return;
        const floats = e.inputBuffer.getChannelData(0);
        let sum = 0;
        const pcm = new Int16Array(floats.length);
        for (let i = 0; i < floats.length; i++) {
          const v = Math.max(-1, Math.min(1, floats[i]));
          sum += Math.abs(v);
          pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
        }
        const level = sum / floats.length;
        if (level > (s.maxLevel || 0)) s.maxLevel = level;
        if (level >= SPEECH_RMS) s.speechSeen = true;
        gate.onChunk(pcm, level);
      };

      setStatus("live");
    } catch (err) {
      stop();
      setError(err?.message || String(err));
      setStatus("error");
    }

    function handleServer(msg) {
      const s = ref.current;
      const used = msg?.usageMetadata?.totalTokenCount;
      if (used > 0) setTokens((prev) => Math.max(prev, used));
      // Model audio: 24kHz PCM in base64, played back-to-back. Barge-in stops
      // whatever is scheduled so the user's voice wins.
      const parts = msg?.serverContent?.modelTurn?.parts || [];
      for (const part of parts) {
        const data = part?.inlineData?.data;
        if (!data) continue;
        if (msg.serverContent.interrupted) continue;
        playChunk(data);
      }
      if (msg.serverContent?.interrupted) {
        for (const node of s.playing || []) { try { node.stop(); } catch {} }
        s.playing = [];
      }
      const userText = msg?.serverContent?.inputTranscription?.text;
      const modelText = msg?.serverContent?.outputTranscription?.text;
      if (userText) push("user", userText);
      if (modelText) push("jarvis", modelText);

      // The conductor's hands: run the tool on the agent, answer the model.
      const calls = msg?.toolCall?.functionCalls;
      if (calls?.length && ref.current.session) {
        const functionResponses = calls.map((fc) => ({ fc, p: runTool(fc) }));
        void Promise.all(functionResponses.map(({ fc, p }) =>
          p.then((res) => ({
            id: fc.id,
            name: fc.name,
            response: { result: res?.ok ? (res.result || "ok") : `error: ${res?.error || "no answer"}` }
          }))
        )).then((responses) => {
          try { ref.current.session?.sendToolResponse({ functionResponses: responses }); } catch {}
        });
      }
    }

    async function runTool(fc) {
      push("tool", `${fc.name}(${JSON.stringify(fc.args || {})})`);
      const res = await emit("jarvis:tool", { name: fc.name, args: fc.args || {} });
      push("tool", `${fc.name} → ${res?.ok ? String(res.result).slice(0, 200) : res?.error}`);
      return res;
    }

    function playChunk(b64) {
      const s = ref.current;
      if (!s.outCtx) s.outCtx = new AudioContext({ sampleRate: OUT_RATE });
      const ctx = s.outCtx;
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const pcm = new Int16Array(bytes.buffer);
      const floats = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) floats[i] = pcm[i] / 0x8000;
      const buffer = ctx.createBuffer(1, floats.length, OUT_RATE);
      buffer.copyToChannel(floats, 0);
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      // Back-to-back scheduling: never overlap, never gap on a slow chunk.
      const at = Math.max(ctx.currentTime + 0.02, s.nextAt || 0);
      s.nextAt = at + buffer.duration;
      node.onended = () => { s.playing = (s.playing || []).filter((n) => n !== node); };
      node.connect(ctx.destination);
      node.start(at);
      s.playing.push(node);
    }
  }, [apiKey, voice, model, stop, push, busRef]);

  return { status, error, entries, tokens, start, stop };
}
