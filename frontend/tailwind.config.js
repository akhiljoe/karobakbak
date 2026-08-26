/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      screens: {
        /*
          Short viewports, not narrow ones.

          Every other breakpoint here is about width, and width was never the
          problem: the landing screen overflowed by 82px on a 1536x695 laptop
          while fitting comfortably on a taller phone. Compressing by width
          would have squeezed the wrong screens and left that one broken.

          760px catches the common laptop heights (695-720 after browser
          chrome) and landscape phones, and leaves tall screens with their
          generous spacing intact.
        */
        short: { raw: '(max-height: 760px)' },
      },
      colors: {
        // Warm ink palette — deep charcoal base, warm cream text, amber accent
        ink: {
          50: '#f7f5f3',
          100: '#ede9e3',
          200: '#d9d1c4',
          300: '#b8ab97',
          400: '#8a7d68',
          500: '#6b5f4d',
          600: '#524739',
          700: '#3d352a',
          800: '#2a241c',
          900: '#1c1812',
          950: '#13100b',
        },
        amber: {
          50: '#fff8eb',
          100: '#ffefc6',
          200: '#ffdd88',
          300: '#ffc94a',
          400: '#ffb420',
          500: '#f59e0b',
          600: '#d97c02',
          700: '#b45c04',
          800: '#92480a',
          900: '#793c0c',
        },
        /*
         * Warm light palette, for the support page.
         *
         * The rest of the product is dark (). This is the one surface that
         * is not, and the difference is deliberate: asking for money in the same
         * dark chrome as the chat reads as part of the product, and it is not.
         */
        coffee: {
          50: '#fbf6f0',
          100: '#f5e9da',
          200: '#e8d0b3',
          300: '#d9b285',
          400: '#c8905a',
          500: '#b5733e',
          600: '#9c5a2e',
          700: '#7d4527',
          800: '#5f3520',
          900: '#3d2316',
          950: '#241308',
        },
        cream: {
          50: '#fefcf9',
          100: '#fdf8ef',
          200: '#faedd3',
          300: '#f4d9a6',
          400: '#edbf6f',
          500: '#e6a344',
          600: '#d98a2f',
          700: '#b86a25',
          800: '#935322',
          900: '#784521',
        },
        sage: {
          400: '#7fb069',
          500: '#5a9251',
          600: '#42723f',
        },
        rose: {
          400: '#f47272',
          500: '#e25555',
          600: '#c0392b',
        },
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
        display: ['"Fraunces"', 'Georgia', 'serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        // 1.250 minor third scale
        '2xs': ['0.625rem', { lineHeight: '0.875rem' }],
        xs: ['0.75rem', { lineHeight: '1rem' }],
        sm: ['0.875rem', { lineHeight: '1.25rem' }],
        base: ['1rem', { lineHeight: '1.5rem' }],
        lg: ['1.125rem', { lineHeight: '1.75rem' }],
        xl: ['1.25rem', { lineHeight: '1.75rem' }],
        '2xl': ['1.5rem', { lineHeight: '2rem' }],
        '3xl': ['1.875rem', { lineHeight: '2.25rem' }],
        '4xl': ['2.25rem', { lineHeight: '2.5rem' }],
        '5xl': ['3rem', { lineHeight: '3.25rem' }],
        '6xl': ['3.75rem', { lineHeight: '4rem' }],
      },
      borderRadius: {
        '4.5': '1.125rem',
      },
      boxShadow: {
        'soft': '0 1px 2px rgba(19,16,11,0.04), 0 4px 16px rgba(19,16,11,0.06)',
        'lift': '0 8px 32px rgba(19,16,11,0.18)',
        'glow': '0 0 0 1px rgba(255,180,32,0.25), 0 8px 32px rgba(245,158,11,0.18)',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'msg-in': {
          '0%': { opacity: '0', transform: 'translateY(8px) scale(0.98)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'pop-in': {
          '0%': { opacity: '0', transform: 'scale(0.9)' },
          '60%': { opacity: '1', transform: 'scale(1.04)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        'pulse-ring': {
          '0%': { transform: 'scale(0.8)', opacity: '0.6' },
          '100%': { transform: 'scale(2.2)', opacity: '0' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-12px)' },
        },
        'float-slow': {
          '0%,100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-6px)' },
        },
        'shimmer': {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.3s ease-out both',
        'msg-in': 'msg-in 0.28s cubic-bezier(0.22,1,0.36,1) both',
        'pop-in': 'pop-in 0.4s cubic-bezier(0.22,1,0.36,1) both',
        'pulse-ring': 'pulse-ring 2s ease-out infinite',
        'float-slow': 'float-slow 5s ease-in-out infinite',
        float: 'float 6s ease-in-out infinite',
        'shimmer': 'shimmer 1.6s linear infinite',
      },
    },
  },
  plugins: [],
};
