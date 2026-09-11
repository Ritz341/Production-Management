/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // Same Apple HIG system-color approach as the SC220 inventory app,
        // for visual consistency across your internal tools.
        systemBlue: '#007AFF',
        systemGreen: '#34C759',
        systemRed: '#FF3B30',
        systemOrange: '#FF9500',
        systemGray: {
          50: '#F2F2F7',
          100: '#E5E5EA',
          400: '#8E8E93',
          700: '#3A3A3C',
          900: '#1C1C1E',
        },
      },
    },
  },
  plugins: [],
}
