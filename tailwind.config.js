/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Geist Variable', 'Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono Variable', 'JetBrains Mono', 'Cascadia Code', 'Consolas', 'monospace']
      },
      colors: {
        // Sibyl palette — Eagle dark/OLED surfaces with a themeable accent.
        sibyl: {
          bg: '#000000', // void
          surface: '#0a0a0b',
          'surface-2': '#141416', // raised
          sunken: '#050506',
          border: '#23232a',
          muted: '#9696a3',
          faint: '#868692',
          secondary: '#b8b8c0',
          text: '#f5f5f7',
          // Accent trio is driven by CSS variables (set per accent theme) so a
          // theme switch repaints every `sibyl-accent` utility. Channels are
          // space-separated RGB so opacity modifiers (e.g. /20) keep working.
          accent: 'rgb(var(--sibyl-accent) / <alpha-value>)',
          'accent-2': 'rgb(var(--sibyl-accent-2) / <alpha-value>)',
          glow: 'rgb(var(--sibyl-glow) / <alpha-value>)'
        }
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' }
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' }
        },
        'pulse-glow': {
          '0%, 100%': { opacity: '0.6' },
          '50%': { opacity: '1' }
        }
      },
      animation: {
        'fade-in': 'fade-in 0.25s ease-out',
        shimmer: 'shimmer 1.5s infinite',
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite'
      }
    }
  },
  plugins: []
}
