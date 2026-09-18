"use client";

// Voice dictation with two engines, picked in settings (voiceStore):
//   "browser" — Web Speech API. Streams interim + final transcripts to
//     `onText(fullTranscript)` so the caller can live-fill an input.
//   "ai"      — MediaRecorder + an OpenAI-compatible STT endpoint. Batch: the
//     transcript arrives once, after the user stops the recording.
// `active` = enabled && engine available; render mic buttons on that, not `supported`.
import { useCallback, useEffect, useRef, useState } from "react";
import { useVoiceStore } from "@/shared/stores/voiceStore";
import { transcribeBlob } from "@/shared/lib/voiceStt";

// Map app 2-letter locales to BCP-47 speech tags (best-effort; bare code works too).
export const SPEECH_LANG = {
  en: "en-US", vi: "vi-VN", zh: "zh-CN", ja: "ja-JP", ko: "ko-KR", es: "es-ES",
  fr: "fr-FR", de: "de-DE", pt: "pt-BR", ru: "ru-RU", ar: "ar-SA", hi: "hi-IN",
  id: "id-ID", th: "th-TH", tr: "tr-TR", it: "it-IT", nl: "nl-NL", pl: "pl-PL",
  uk: "uk-UA", fa: "fa-IR", ms: "ms-MY", sv: "sv-SE", he: "he-IL",
};
export const localeToSpeechLang = (locale) => SPEECH_LANG[locale] || locale || "en-US";

const VOICE_LANG_KEY = "voiceLang";

// Voice dictation language, persisted; falls back to the given UI locale.
export function useVoiceLang(fallbackLocale) {
  const [lang, setLang] = useState(fallbackLocale);
  useEffect(() => {
    const saved = typeof window !== "undefined" && localStorage.getItem(VOICE_LANG_KEY);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- SSR-safe read after mount
    if (saved && SPEECH_LANG[saved]) setLang(saved);
  }, []);
  const update = useCallback((code) => {
    setLang(code);
    try { localStorage.setItem(VOICE_LANG_KEY, code); } catch {}
  }, []);
  return [lang, update];
}

// Fatal errors: user must act — don't auto-restart on these.
const FATAL = new Set(["not-allowed", "service-not-allowed", "audio-capture", "language-not-supported"]);

// AI-mode silence detection: end the take once the user stops talking, so it
// feels like the browser engine — no second tap needed to get the transcript.
const RMS_SPEECH = 6;       // avg |sample-128| above this counts as speech
const SILENCE_STOP_MS = 1500;
const MONITOR_MS = 100;

function getRecognition() {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function useVoiceInput({ lang = "en-US", onText, onError } = {}) {
  const mode = useVoiceStore((s) => s.mode);
  const enabled = useVoiceStore((s) => s.enabled);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState(null);
  const onErrorRef = useRef(onError);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  const wantOnRef = useRef(false);   // user intends to keep dictating (survives auto-onend)
  const langRef = useRef(lang);
  useEffect(() => {
    langRef.current = lang;
    // Switching language mid-dictation: restart so the new lang takes effect now.
    if (wantOnRef.current) { try { recognitionRef.current?.stop(); } catch {} }
  }, [lang]);
  const recognitionRef = useRef(null);
  const aiRef = useRef(null);         // { stream, rec, chunks, stopped, ctx, timer } while AI-recording
  const baseRef = useRef("");        // text already committed before this dictation
  const onTextRef = useRef(onText);
  useEffect(() => { onTextRef.current = onText; }, [onText]);

  const supported = typeof window !== "undefined" && (
    mode === "ai"
      ? !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder)
      : !!getRecognition()
  );
  const active = enabled && supported;

  // AI engine: record while "listening", transcribe once on stop (auto on
  // silence, or when the user taps again). The button keeps pulsing through
  // transcription — it ends when the text lands.
  const stopAi = useCallback(async (via = "manual") => {
    console.log("[voice][TEMP DIAGNOSTIC] stopAi", { via });
    wantOnRef.current = false;
    const sess = aiRef.current;
    aiRef.current = null;
    if (!sess) { setListening(false); return; }
    clearInterval(sess.timer);
    try { if (sess.rec.state !== "inactive") sess.rec.stop(); } catch {}
    await sess.stopped;
    sess.stream.getTracks().forEach((t) => t.stop());
    try { sess.ctx.close(); } catch {}
    console.log("[voice][TEMP DIAGNOSTIC] recorder stopped", { bytes: sess.chunks.reduce((n, c) => n + c.size, 0) });
    try {
      const blob = new Blob(sess.chunks, { type: sess.rec.mimeType || "audio/webm" });
      const text = await transcribeBlob(useVoiceStore.getState(), blob, langRef.current);
      console.log("[voice][TEMP DIAGNOSTIC] transcript", { len: text.length, text });
      onTextRef.current?.(`${baseRef.current}${text}`.replace(/\s+/g, " ").trimStart());
    } catch (err) {
      console.warn("[voice][TEMP DIAGNOSTIC] AI transcription failed:", err?.name, err?.message);
      setError("network");
      onErrorRef.current?.("network");
    } finally {
      setListening(false);
    }
  }, []);

  const startAi = useCallback(async (currentText = "") => {
    baseRef.current = currentText ? currentText.replace(/\s*$/, "") + " " : "";
    setError(null);
    wantOnRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const stopped = new Promise((resolve) => { rec.onstop = resolve; });
      const ctx = new AudioContext();
      try { await ctx.resume(); } catch {}
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      let lastSpokeAt = 0;
      let spoke = false;
      const timer = setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += Math.abs(buf[i] - 128);
        const rms = sum / buf.length;
        if (rms > RMS_SPEECH) {
          if (!spoke) console.log("[voice][TEMP DIAGNOSTIC] speech detected", { rms: rms.toFixed(1) });
          spoke = true;
          lastSpokeAt = Date.now();
        } else if (lastSpokeAt && Date.now() - lastSpokeAt > SILENCE_STOP_MS) {
          console.log("[voice][TEMP DIAGNOSTIC] silence → auto stop", { rms: rms.toFixed(1) });
          void stopAi("silence");
        }
      }, MONITOR_MS);
      aiRef.current = { stream, rec, chunks, stopped, ctx, timer };
      rec.start();
      console.log("[voice][TEMP DIAGNOSTIC] AI recording started", { mimeType: rec.mimeType, lang: langRef.current });
      setListening(true);
    } catch (err) {
      console.warn("[voice][TEMP DIAGNOSTIC] AI start failed:", err?.name, err?.message);
      wantOnRef.current = false;
      // Reuse the Web Speech error codes the callers already display.
      const code = err?.name === "NotAllowedError" || err?.name === "SecurityError" ? "not-allowed" : "audio-capture";
      setError(code);
      onErrorRef.current?.(code);
    }
  }, [stopAi]);

  const stop = useCallback(() => {
    console.log("[voice][TEMP DIAGNOSTIC] stop", { mode, hasRecognition: !!recognitionRef.current });
    wantOnRef.current = false;
    if (mode === "ai") { void stopAi("manual"); return; }
    try { recognitionRef.current?.stop(); } catch {}
  }, [mode, stopAi]);

  const spawn = useCallback(function spawnRec() {
    const SR = getRecognition();
    if (!SR) return;
    // Reusing a live instance is unreliable across browsers — always make a fresh one.
    const rec = new SR();
    rec.lang = langRef.current;
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (e) => {
      // User already stopped (e.g. hit Send) — ignore late results so we don't refill cleared input.
      if (!wantOnRef.current) return;
      let final = "";
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const chunk = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += chunk;
        else interim += chunk;
      }
      if (final) baseRef.current = `${baseRef.current}${final} `.replace(/\s+/g, " ");
      if (final) console.log("[voice][TEMP DIAGNOSTIC] browser final result", { len: final.length, final });
      const combined = `${baseRef.current}${interim}`.replace(/\s+/g, " ").trimStart();
      onTextRef.current?.(combined);
    };
    rec.onend = () => {
      recognitionRef.current = null;
      console.log("[voice][TEMP DIAGNOSTIC] browser onend", { willRespawn: wantOnRef.current });
      // Chrome auto-ends on silence; if the user hasn't stopped, keep going.
      if (wantOnRef.current) { try { spawnRec(); } catch { setListening(false); } }
      else setListening(false);
    };
    rec.onerror = (e) => {
      const code = e?.error || "error";
      console.warn("[voice][TEMP DIAGNOSTIC] browser recognition error:", code, e?.message);
      if (code === "no-speech" || code === "aborted") return; // onend will retry
      setError(code);
      onErrorRef.current?.(code);
      if (FATAL.has(code)) { wantOnRef.current = false; setListening(false); }
    };

    recognitionRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch (err) {
      // start() throws if a session is already live — harmless; else surface.
      console.warn("[voice] start failed:", err);
      if (!recognitionRef.current) { setListening(false); wantOnRef.current = false; }
    }
  }, []);

  const start = useCallback((currentText = "") => {
    console.log("[voice][TEMP DIAGNOSTIC] start", { mode, engineAvailable: mode === "ai" ? "mediaRecorder" : !!getRecognition() });
    if (mode === "ai") { void startAi(currentText); return; }
    if (!getRecognition()) return;
    baseRef.current = currentText ? currentText.replace(/\s*$/, "") + " " : "";
    setError(null);
    wantOnRef.current = true;
    spawn();
  }, [mode, startAi, spawn]);

  const toggle = useCallback((currentText = "") => {
    if (listening) stop();
    else start(currentText);
  }, [listening, start, stop]);

  useEffect(() => () => {
    wantOnRef.current = false;
    try { recognitionRef.current?.abort(); } catch {}
    const sess = aiRef.current;
    if (sess) {
      aiRef.current = null;
      clearInterval(sess.timer);
      try { if (sess.rec.state !== "inactive") sess.rec.stop(); } catch {}
      sess.stream.getTracks().forEach((t) => t.stop());
      try { sess.ctx.close(); } catch {}
    }
  }, []);

  return { supported, active, listening, error, start, stop, toggle };
}
