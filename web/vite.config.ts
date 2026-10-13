import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // Not 5173: other local Vite apps use it. Fail if the port is busy.
    port: 4318,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:4317' },
  },
});
