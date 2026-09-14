/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Barlow Condensed"', 'sans-serif'],
        body: ['Inter', 'sans-serif'],
      },
      colors: {
        // Pulled from actual shop-floor signage, not a generic tech palette.
        charcoal: '#1D2126',
        steel: '#3D444C',
        steelLight: '#5A6270',
        paper: '#F7F5F0',
        paperDim: '#EDEAE2',
        safety: '#F2B705',
        safetyDark: '#C9950A',
        andonGreen: '#2E7D46',
        andonGreenBg: '#E4F1E7',
        andonRed: '#C1272D',
        andonRedBg: '#FBE7E7',
        andonBlue: '#2A5C8A',
        andonBlueBg: '#E4EDF4',
      },
    },
  },
  plugins: [],
}
