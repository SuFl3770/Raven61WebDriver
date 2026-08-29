import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base: '' keeps the build relocatable (GitHub Pages, file://, sub-paths).
export default defineConfig({
  base: '',
  plugins: [react()],
  server: { port: 5173 },
})
