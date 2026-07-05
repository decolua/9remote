"use client";

// Voice dictation via the browser's Web Speech API (SpeechRecognition).
// Streams interim + final transcripts to `onText(fullTranscript)` so the caller
// can live-fill an input as the user speaks. No external deps, no server round-trip.
//
// ponytail: ceiling = Web Speech API only (Chrome/Safari/Edge; not Firefox).
// Upgrade path: swap the engine for a server STT (Whisper) if broader support needed.
import { useCallback, useEffect, useRef, useState } from "react";

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

function getRecognition() {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function useVoiceInput({ lang = "en-US", onText, onError } = {}) {
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
  const baseRef = useRef("");        // text already committed before this dictation
  const onTextRef = useRef(onText);
  useEffect(() => { onTextRef.current = onText; }, [onText]);

  const supported = typeof window !== "undefined" && !!getRecognition();

  const stop = useCallback(() => {
    wantOnRef.current = false;
    try { recognitionRef.current?.stop(); } catch {}
  }, []);

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
      const combined = `${baseRef.current}${interim}`.replace(/\s+/g, " ").trimStart();
      onTextRef.current?.(combined);
    };
    rec.onend = () => {
      recognitionRef.current = null;
      // Chrome auto-ends on silence; if the user hasn't stopped, keep going.
      if (wantOnRef.current) { try { spawnRec(); } catch { setListening(false); } }
      else setListening(false);
    };
    rec.onerror = (e) => {
      const code = e?.error || "error";
      console.warn("[voice] recognition error:", code, e?.message);
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
    if (!getRecognition()) return;
    baseRef.current = currentText ? currentText.replace(/\s*$/, "") + " " : "";
    setError(null);
    wantOnRef.current = true;
    spawn();
  }, [spawn]);

  const toggle = useCallback((currentText = "") => {
    if (listening) stop();
    else start(currentText);
  }, [listening, start, stop]);

  useEffect(() => () => { wantOnRef.current = false; try { recognitionRef.current?.abort(); } catch {} }, []);

  return { supported, listening, error, start, stop, toggle };
}
