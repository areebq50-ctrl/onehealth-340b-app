/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        teal: {
          DEFAULT: '#0E7C7B',
          50: '#E6F3F3',
          100: '#CCE7E6',
          600: '#0E7C7B',
          700: '#0B6362',
          800: '#084A49',
        },
        coral: {
          DEFAULT: '#E8604C',
          50: '#FDEEEC',
          100: '#FBDDD9',
          600: '#E8604C',
          700: '#D14831',
        },
        navy: {
          DEFAULT: '#1A2B3C',
        },
        surface: {
          DEFAULT: '#FFFFFF',
          alt: '#F8FAFB',
        },
        success: '#2E7D32',
        warning: '#F59E0B',
        danger: '#DC2626',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
