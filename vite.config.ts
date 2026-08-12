import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Listen on all interfaces (::, 0.0.0.0). Otherwise vite defaults to
    // only the IPv6 `localhost`, so http://127.0.0.1:5173 fails to connect.
    host: true,
    port: 5173,
  },
});
