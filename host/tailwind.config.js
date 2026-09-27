export default {
  content: ["./index.html", "./ui/src/**/*.{js,jsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Sora", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
      // Map web semantic tokens → agent CSS vars (agent uses --bg-main/--text-main, web uses --bg/--text).
      // Lets ported web components (bg-bg, text-text, bg-surface-2, border-border...) render correctly.
      colors: {
        bg: "var(--bg-main)",
        surface: {
          DEFAULT: "var(--surface)",
          2: "var(--surface-2)",
          3: "var(--surface-3)",
        },
        text: {
          DEFAULT: "var(--text-main)",
          muted: "var(--text-muted)",
          subtle: "var(--text-subtle)",
        },
        border: {
          DEFAULT: "var(--border)",
          subtle: "var(--border-subtle)",
        },
        brand: {
          400: "var(--brand-400)",
          500: "var(--brand-500)",
          600: "var(--brand-600)",
        },
        danger: "var(--danger)",
        success: "var(--success)",
      },
    },
  },
  plugins: [],
};
