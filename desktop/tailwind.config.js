/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        primary: "#007bff",
        "bg-dark": "#0f1923",
      },
      fontFamily: {
        display: ["Inter", "sans-serif"],
      },
    },
  },
};
