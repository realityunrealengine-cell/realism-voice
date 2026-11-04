/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter Variable"', '"Segoe UI Variable"', '"Segoe UI"', 'system-ui', 'sans-serif'],
      },
      colors: {
        base: {
          950: '#05060c',
          900: '#090b16',
          850: '#0d1020',
          800: '#121629',
          700: '#1a1f38',
        },
        accent: {
          blue: '#5b7cfa',
          violet: '#8b5cf6',
          pink: '#c06bff',
        },
      },
      boxShadow: {
        glass: '0 10px 40px -12px rgba(0,0,0,0.6), inset 0 1px 0 0 rgba(255,255,255,0.04)',
        glow: '0 0 0 1px rgba(139,92,246,0.35), 0 8px 30px -6px rgba(91,124,250,0.45)',
      },
      backgroundImage: {
        'accent-gradient': 'linear-gradient(135deg, #5b7cfa 0%, #8b5cf6 55%, #c06bff 100%)',
      },
      keyframes: {
        pulseRing: {
          '0%': { boxShadow: '0 0 0 0 rgba(52,211,153,0.6)' },
          '100%': { boxShadow: '0 0 0 6px rgba(52,211,153,0)' },
        },
        floaty: {
          '0%,100%': { transform: 'translate(0,0) scale(1)' },
          '50%': { transform: 'translate(30px,-20px) scale(1.08)' },
        },
      },
      animation: {
        pulseRing: 'pulseRing 1.2s ease-out infinite',
        floaty: 'floaty 18s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
