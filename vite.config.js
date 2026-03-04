import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/cerebellar-extract/',
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-pdf': ['pdfjs-dist'],
          'vendor-react': ['react', 'react-dom'],
        },
      },
    },
  },
  optimizeDeps: {
    include: ['pdfjs-dist'],
  },
})
