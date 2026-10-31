import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: { vendor: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query'] },
      },
    },
  },
  server: {
    port: Number(process.env.PORT ?? 5173),
    // node_modules is a junction out of OneDrive, so its files sit outside the project root.
    fs: { strict: false },
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.KEEL_API_PORT ?? 8787}`, changeOrigin: false } },
  },
});
