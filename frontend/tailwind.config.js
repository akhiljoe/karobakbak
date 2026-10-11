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
        /*
         * Genuinely cramped, as distinct from merely short.
         *
         * `short` compresses spacing on ordinary laptops. Hiding content at that
         * threshold means a 695px window — which is a very common laptop —
         * never sees it at all. This is the lower bar, for viewports where the
         * primary button really would be pushed out of reach. Set at 700 because
         * a 695px window is exactly where the sample stops fitting.
         */
        tiny: { raw: '(max-height: 700px)' },
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
        // The friends drawer, entering from the left edge it is pinned to.
        'slide-in-left': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(0)' },
        },
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
        /*
         * The editorial pages (About, How it works, Premium) are built from
         * these. Every one is ambient and slow, or a single entrance — nothing
         * is scroll-driven, and the global `prefers-reduced-motion` rule in
         * index.css flattens all of it to a static page.
         */
        // Entrance: content arrives from below, once.
        rise: {
          '0%': { opacity: '0', transform: 'translateY(24px)', filter: 'blur(6px)' },
          '100%': { opacity: '1', transform: 'none', filter: 'blur(0)' },
        },
        // A rule drawing itself left to right. Needs `origin-left`.
        draw: {
          '0%': { transform: 'scaleX(0)' },
          '100%': { transform: 'scaleX(1)' },
        },
        // The ambient warm/sage blobs behind the page.
        drift: {
          '0%, 100%': { transform: 'translate3d(0,0,0) scale(1)' },
          '50%': { transform: 'translate3d(14px,-22px,0) scale(1.08)' },
        },
        // A dot breathing a ring, for "live". Distinct from `pulse-ring`,
        // which scales an element rather than spreading a shadow.
        'dot-pulse': {
          '0%': { boxShadow: '0 0 0 0 rgba(127,176,105,.5)' },
          '70%': { boxShadow: '0 0 0 8px rgba(127,176,105,0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(127,176,105,0)' },
        },
        'dot-pulse-amber': {
          '0%': { boxShadow: '0 0 0 0 rgba(255,180,32,.45)' },
          '70%': { boxShadow: '0 0 0 8px rgba(255,180,32,0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(255,180,32,0)' },
        },
        'glow-pulse': {
          '0%, 100%': { boxShadow: '0 0 0 4px rgba(255,180,32,.05)' },
          '50%': { boxShadow: '0 0 0 9px rgba(255,180,32,.09)' },
        },
        // The match diagram on "How it works": two dots approach, hold a
        // dashed thread between them, drift apart. One six-second loop.
        'approach-l': {
          '0%': { transform: 'translateX(-46px)', opacity: '.3' },
          '34%, 66%': { transform: 'translateX(-13px)', opacity: '1' },
          '100%': { transform: 'translateX(-46px)', opacity: '.3' },
        },
        'approach-r': {
          '0%': { transform: 'translateX(46px)', opacity: '.3' },
          '34%, 66%': { transform: 'translateX(13px)', opacity: '1' },
          '100%': { transform: 'translateX(46px)', opacity: '.3' },
        },
        thread: {
          '0%, 22%': { transform: 'scaleX(0)', opacity: '0' },
          '40%, 62%': { transform: 'scaleX(1)', opacity: '1' },
          '82%, 100%': { transform: 'scaleX(0)', opacity: '0' },
        },
        // The field of unverified dots above the Premium hero.
        'swap-soft': {
          '0%, 100%': { opacity: '.2' },
          '50%': { opacity: '1' },
        },
        // The caret after the About wordmark.
        blink: {
          '0%, 49%': { opacity: '1' },
          '50%, 100%': { opacity: '0' },
        },
        /*
         * The 300ms reveal on an FAQ answer.
         *
         * Opacity and a short lift only — no height animation. `<details>` has
         * no animatable height between closed and open, and faking one means
         * measuring the content and driving it from JavaScript, which is how a
         * native disclosure widget turns into a component that breaks
         * find-in-page. The content appears instantly and fades in place.
         */
        'answer-in': {
          from: { opacity: '0', transform: 'translateY(-4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.3s ease-out both',
        'slide-in-left': 'slide-in-left 0.22s cubic-bezier(0.22,1,0.36,1) both',
        'msg-in': 'msg-in 0.28s cubic-bezier(0.22,1,0.36,1) both',
        'pop-in': 'pop-in 0.4s cubic-bezier(0.22,1,0.36,1) both',
        'pulse-ring': 'pulse-ring 2s ease-out infinite',
        'float-slow': 'float-slow 5s ease-in-out infinite',
        float: 'float 6s ease-in-out infinite',
        'shimmer': 'shimmer 1.6s linear infinite',
        /*
         * `shimmer` at 1.6s reads as a thing loading. The display headlines use
         * the same sweep at 7s, where it reads as light moving across metal —
         * same keyframes, an entirely different meaning, so it gets its own
         * name rather than an override at every call site.
         */
        'shimmer-slow': 'shimmer 7s linear infinite',
        rise: 'rise 0.7s cubic-bezier(0.2,0.8,0.2,1) both',
        draw: 'draw 1.1s cubic-bezier(0.2,0.8,0.2,1) both',
        drift: 'drift 26s ease-in-out infinite',
        'dot-pulse': 'dot-pulse 2.8s ease-out infinite',
        'dot-pulse-amber': 'dot-pulse-amber 2.8s ease-out infinite',
        'glow-pulse': 'glow-pulse 4.5s ease-in-out infinite',
        'approach-l': 'approach-l 6s ease-in-out infinite',
        'approach-r': 'approach-r 6s ease-in-out infinite',
        thread: 'thread 6s ease-in-out infinite',
        'swap-soft': 'swap-soft 5s ease-in-out infinite',
        blink: 'blink 1.1s steps(1) infinite',
        'answer-in': 'answer-in 0.3s cubic-bezier(0.22,1,0.36,1) both',
      },
    },
  },
  plugins: [],
};
