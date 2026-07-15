"use client";

import { useEffect, useRef } from "react";

// 2-way text clipboard sync with the agent host.
// Host polls its OS clipboard → pushes clipboard:sync → writeText here.
// Web copy/cut (text selected in-page) → clipboard:set → host writes OS clipboard.
// `lastText` on both ends prevents echo loops. No UI; runs silently while connected.
export function useClipboardSocket(socketRef, connected) {
  const lastText = useRef("");

  useEffect(() => {
    if (!connected) return;
    const socket = socketRef?.current;
    if (!socket) return;

    const onSync = async ({ text, origin }) => {
      if (origin === "web") return; // our own echo
      if (typeof text !== "string" || text === lastText.current) return;
      lastText.current = text;
      try {
        await navigator.clipboard?.writeText(text);
      } catch {
        // writeText needs a secure context + focused tab; fail silently
      }
    };

    const pushSelection = () => {
      const sel = window.getSelection?.();
      const text = sel?.toString?.() ?? "";
      if (!text || text === lastText.current) return;
      lastText.current = text;
      socket.emit("clipboard:set", { text, origin: "web" });
    };

    socket.on("clipboard:sync", onSync);
    document.addEventListener("copy", pushSelection);
    document.addEventListener("cut", pushSelection);

    return () => {
      socket.off("clipboard:sync", onSync);
      document.removeEventListener("copy", pushSelection);
      document.removeEventListener("cut", pushSelection);
    };
  }, [socketRef, connected]);
}
