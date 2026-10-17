import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        magnet: {
          50:  "#faf5ff",
          100: "#f3e8ff",
          200: "#e9d5ff",
          300: "#d8b4fe",
          400: "#c084fc",
          500: "#a855f7",
          600: "#9333ea",
          700: "#7e22ce",
          800: "#6b21a8",
          900: "#581c87",
          950: "#1a0030",
        },
        surface: {
          DEFAULT: "#08000f",
          light: "#100820",
          lighter: "#1c1030",
        },
      },
      fontFamily: {
        // The variables come from next/font in layout.tsx. Naming the families
        // directly (as this did) only worked if the font happened to be
        // installed locally — it never loaded over the network, so it never was.
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        // Same face as body, by choice — see the note in layout.tsx.
        display: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
