// Tailwind config for the admin dashboard. Dark-by-default + a tighter
// utility-first scale than clients/app. Colors lifted from
// clients/app/tailwind.config.js for visual continuity (Charlie's
// trained eye); spacing/typography tightened for dense info displays.

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class', // we force dark by default; left a hook for v1 light toggle
  theme: {
    extend: {
      colors: {
        // Surface scale — slate-ish neutrals tuned for long sessions.
        ink: {
          900: '#0b1020', // app bg
          800: '#0f152a',
          700: '#161d36',
          600: '#1f2742',
          500: '#2a3252',
          400: '#3b4470',
          300: '#5c668f',
          200: '#9aa3c3',
          100: '#cdd4ea',
        },
        // Accent — green like a healthy supervisor heartbeat.
        accent: {
          500: '#7ee787',
          600: '#56d364',
          700: '#3aa84b',
        },
        // Warnings + errors — amber/red, sober not punchy.
        warn: { 500: '#f2c965' },
        error: { 500: '#f47174' },
        // Thriva product accent retained for cross-tool affinity.
        thriva: { primary: '#a8dadc' },
      },
      fontFamily: {
        sans: [
          'JetBrains Mono',
          'Fira Code',
          'Menlo',
          'Monaco',
          'Consolas',
          'monospace',
        ],
        body: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'sans-serif',
        ],
      },
      fontSize: {
        // Tighter scale than product app — dense table cells.
        xs: ['0.6875rem', { lineHeight: '1rem' }],
        sm: ['0.8125rem', { lineHeight: '1.125rem' }],
      },
      borderRadius: {
        // Sharper corners than clients/app/ (utility-first aesthetic).
        DEFAULT: '0.25rem',
        md: '0.375rem',
        lg: '0.5rem',
      },
    },
  },
  plugins: [],
};
