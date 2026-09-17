"use client";

import { useSyncExternalStore } from "react";

const emptySubscribe = () => () => {};

// Inline script that runs from SSR HTML, then React drops the tag on later client
// renders — silences React 19's dev-only "script tag while rendering" warning
export default function ScriptOnce({ id, html }) {
  const show = useSyncExternalStore(emptySubscribe, () => false, () => true);
  if (!show) return null;
  return <script id={id} dangerouslySetInnerHTML={{ __html: html }} />;
}
