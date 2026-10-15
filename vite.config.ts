import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';

const IMG_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
};

/**
 * Dev-only: serve local image files referenced by trace files
 * (e.g. Devin transcripts store absolute paths to pasted screenshots).
 * GET /local-img?path=/abs/file.png — image extensions only.
 */
function localImagePlugin(): Plugin {
  return {
    name: 'local-image',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/local-img')) return next();
        const p = new URL(req.url, 'http://localhost').searchParams.get('path') ?? '';
        const mime = IMG_MIME[extname(p).toLowerCase()];
        if (!mime || !existsSync(p) || !statSync(p).isFile()) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        res.setHeader('Content-Type', mime);
        createReadStream(p).pipe(res);
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), localImagePlugin()],
  server: {
    // Listen on all interfaces (::, 0.0.0.0). Otherwise vite defaults to
    // only the IPv6 `localhost`, so http://127.0.0.1:5173 fails to connect.
    host: true,
    port: 5173,
  },
});
