"use client";

// Overrides Next's internal global error boundary. Without this, prerender of
// /_global-error throws "Cannot read properties of null (reading 'useContext')"
// under Next 16 + Turbopack monorepo root.
export default function GlobalError({ error, reset }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", color: "#333" }}>
        <h2>Something went wrong</h2>
        <p>{error?.message ?? "Unexpected error"}</p>
        <button onClick={() => reset()}>Try again</button>
      </body>
    </html>
  );
}
