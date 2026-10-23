import type { Config } from 'tailwindcss';

// Dark-only. Colours come from src/tokens.css (the one token layer); Tailwind maps a few names
// onto those CSS variables so utilities compose with the component CSS. No colour literals here.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: 'var(--canvas)',
        panel: 'var(--panel)',
        'surface-raised': 'var(--surface-raised)',
        ink: 'var(--ink)',
        muted: 'var(--muted)',
        faint: 'var(--faint)',
        accent: 'var(--accent)',
        'accent-text': 'var(--accent-text)',
        line: 'var(--line)',
      },
      fontFamily: {
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
} satisfies Config;
