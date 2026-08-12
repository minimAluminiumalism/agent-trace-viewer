/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Role palette — matches Docent MessageBox.tsx exactly
        role: {
          system: { bg: '#fff7ed', border: '#fdba74', dot: '#f97316' },   // orange
          user:   { bg: '#f9fafb', border: '#d1d5db', dot: '#9ca3af' },   // gray
          assist: { bg: '#eff6ff', border: '#93c5fd', dot: '#3b82f6' },   // blue
          tool:   { bg: '#f0fdf4', border: '#86efac', dot: '#22c55e' },   // green
          error:  { bg: '#fef2f2', border: '#fca5a5', dot: '#ef4444' },   // red
          reason: { bg: '#faf5ff', border: '#d8b4fe', dot: '#a855f7' },   // purple
        },
      },
    },
  },
  plugins: [],
};
