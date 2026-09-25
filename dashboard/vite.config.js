import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The pipeline runs in the Express process on :4000 — proxy so the
    // dashboard needs no CORS setup and works the same in dev and prod.
    proxy: {
      '/api': 'http://localhost:4000',
      '/media': 'http://localhost:4000'
    }
  }
});
