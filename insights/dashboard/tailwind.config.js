/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Driven by CSS vars (RGB channels) so the identity "signature colors" can retheme the UI
        // live. Channels (not hex) keep Tailwind's `/opacity` modifiers working. Defaults in main.css.
        brand: {
          violet: 'rgb(var(--brand-violet) / <alpha-value>)',
          pink: 'rgb(var(--brand-pink) / <alpha-value>)'
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'ui-sans-serif', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace']
      },
      backgroundImage: {
        'brand-gradient': 'linear-gradient(135deg, rgb(var(--brand-violet)) 0%, rgb(var(--brand-pink)) 100%)'
      },
      borderRadius: {
        '2xl': '1rem'
      }
    }
  },
  plugins: []
}
