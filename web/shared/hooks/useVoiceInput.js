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
const MONITOR_MS = 80;

function getRecognition() {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function useVoiceInput({
  lang = "en-US",
  onText,
  onError,
  onFinish,
} = {}) {
  const mode = useVoiceStore((s) => s.mode);
  const enabled = useVoiceStore((s) => s.enabled);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [volume, setVolume] = useState(0);
  const [error, setError] = useState(null);

  const onFinishRef = useRef(onFinish);
  useEffect(() => { onFinishRef.current = onFinish; }, [onFinish]);
  const onErrorRef = useRef(onError);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  const onTextRef = useRef(onText);
  useEffect(() => { onTextRef.current = onText; }, [onText]);

  const wantOnRef = useRef(false);   // user intends to keep dictating (survives auto-onend)
  const langRef = useRef(lang);
  useEffect(() => {
    langRef.current = lang;
    if (wantOnRef.current) { try { recognitionRef.current?.stop(); } catch {} }
  }, [lang]);

  const recognitionRef = useRef(null);
  const aiRef = useRef(null);         // { stream, rec, chunks, stopped, ctx, timer } while AI-recording
  const baseRef = useRef("");        // text already committed before this dictation

  const supported = typeof window !== "undefined" && (
    mode === "ai"
      ? !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder)
      : !!getRecognition()
  );
  const active = enabled && supported;

  // AI engine: record while "listening", transcribe once on stop.
  const stopAi = useCallback(async () => {
    wantOnRef.current = false;
    const sess = aiRef.current;
    aiRef.current = null;
    if (!sess) {
      setListening(false);
      setTranscribing(false);
      setVolume(0);
      return;
    }
    clearInterval(sess.timer);
    setVolume(0);
    setTranscribing(true);
    try { if (sess.rec.state !== "inactive") sess.rec.stop(); } catch {}
    await sess.stopped;
    sess.stream.getTracks().forEach((t) => t.stop());
    try { sess.ctx.close(); } catch {}
    try {
      const blob = new Blob(sess.chunks, { type: sess.rec.mimeType || "audio/webm" });
      const text = await transcribeBlob(useVoiceStore.getState(), blob, langRef.current);
      const combined = `${baseRef.current}${text}`.replace(/\s+/g, " ").trimStart();
      onTextRef.current?.(combined);
      if (text?.trim()) {
        onFinishRef.current?.(combined);
      }
    } catch (err) {
      setError("network");
      onErrorRef.current?.("network");
    } finally {
      setListening(false);
      setTranscribing(false);
      setVolume(0);
    }
  }, []);

  const startAi = useCallback(async (currentText = "") => {
    baseRef.current = currentText ? currentText.replace(/\s*$/, "") + " " : "";
    setError(null);
    wantOnRef.current = true;
    setVolume(0);
    setTranscribing(false);
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
      const timer = setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += Math.abs(buf[i] - 128);
        const rms = sum / buf.length;
        setVolume(Math.min(1, Math.max(0, (rms - 2) / 20)));
      }, MONITOR_MS);
      aiRef.current = { stream, rec, chunks, stopped, ctx, timer };
      rec.start();
      setListening(true);
    } catch (err) {
      wantOnRef.current = false;
      const code = err?.name === "NotAllowedError" || err?.name === "SecurityError" ? "not-allowed" : "audio-capture";
      setError(code);
      onErrorRef.current?.(code);
    }
  }, []);

  const cancel = useCallback(() => {
    wantOnRef.current = false;
    const sess = aiRef.current;
    aiRef.current = null;
    if (sess) {
      clearInterval(sess.timer);
      try { if (sess.rec.state !== "inactive") sess.rec.stop(); } catch {}
      sess.stream.getTracks().forEach((t) => t.stop());
      try { sess.ctx.close(); } catch {}
    }
    try { recognitionRef.current?.abort(); } catch {}
    setListening(false);
    setTranscribing(false);
    setVolume(0);
  }, []);

  const stop = useCallback(() => {
    wantOnRef.current = false;
    if (mode === "ai") { void stopAi(); return; }
    try { recognitionRef.current?.stop(); } catch {}
  }, [mode, stopAi]);

  const spawn = useCallback(function spawnRec() {
    const SR = getRecognition();
    if (!SR) return;
    const rec = new SR();
    rec.lang = langRef.current;
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (e) => {
      if (!wantOnRef.current) return;
      let final = "";
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const chunk = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += chunk;
        else interim += chunk;
      }
      if (final) baseRef.current = `${baseRef.current}${final} `.replace(/\s+/g, " ");
      const combined = `${baseRef.current}${interim}`.replace(/\s+/g, " ").trimStart();
      onTextRef.current?.(combined);
    };

    rec.onend = () => {
      recognitionRef.current = null;
      if (wantOnRef.current) {
        try { spawnRec(); } catch {
          setListening(false);
        }
      } else {
        setListening(false);
        setVolume(0);
        const final = baseRef.current.trim();
        if (final) onFinishRef.current?.(final);
      }
    };

    rec.onerror = (e) => {
      const code = e?.error || "error";
      if (code === "no-speech" || code === "aborted") return;
      setError(code);
      onErrorRef.current?.(code);
      if (FATAL.has(code)) {
        wantOnRef.current = false;
        setListening(false);
      }
    };

    recognitionRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch (err) {
      console.warn("[voice] start failed:", err);
      if (!recognitionRef.current) {
        setListening(false);
        wantOnRef.current = false;
      }
    }
  }, []);

  const start = useCallback((currentText = "") => {
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

  return {
    supported,
    active,
    listening,
    transcribing,
    volume,
    error,
    start,
    stop,
    cancel,
    toggle,
  };
}
