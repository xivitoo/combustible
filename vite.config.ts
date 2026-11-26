import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

function normalizeBase(raw?: string): string {
  const val = (raw || '/').trim();
  if (!val || val === '/') return '/';
  const withLeading = val.startsWith('/') ? val : `/${val}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
}

function buildManifest(base: string) {
  return {
    id: base,
    name: 'Combustible by XivIoT',
    short_name: 'Combustible',
    description:
      'Precios oficiales de Gasolina 95, Diésel A, Gasolina 98 y GLP en España. Mapa interactivo, previsión a 7 días, gasolineras baratas y modo Offline.',
    lang: 'es-ES',
    start_url: base,
    scope: base,
    display: 'standalone',
    orientation: 'portrait',
    theme_color: '#1D2839',
    background_color: '#1D2839',
    categories: ['navigation', 'utilities', 'travel'],
    icons: [
      {
        src: `${base}pwa-192x192.png`,
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: `${base}pwa-512x512.png`,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: `${base}pwa-maskable-512x512.png`,
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}

function combustiblePwaPlugin(base: string): Plugin {
  return {
    name: 'combustible-pwa-plugin',
    configureServer(server) {
      server.middlewares.use(`${base}manifest.webmanifest`, (_req, res) => {
        res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
        res.end(JSON.stringify(buildManifest(base), null, 2));
      });
    },
    closeBundle(error?: Error) {
      if (error) return;
      const distDir = path.resolve(__dirname, 'dist');
      if (!fs.existsSync(distDir)) return;

      // 1. Emitir manifest.webmanifest con las rutas exactas del base path
      fs.writeFileSync(
        path.join(distDir, 'manifest.webmanifest'),
        JSON.stringify(buildManifest(base), null, 2),
        'utf8'
      );

      // 2. Recopilar assets compilados para precachear el App Shell
      const precacheUrls = new Set<string>([
        base,
        `${base}index.html`,
        `${base}manifest.webmanifest`,
        `${base}icon.svg`,
        `${base}pwa-192x192.png`,
        `${base}pwa-512x512.png`,
        `${base}apple-touch-icon.png`,
        `${base}assets/aistudio/combustible_36ce1819.jpg`,
      ]);

      const assetsDir = path.join(distDir, 'assets');
      if (fs.existsSync(assetsDir)) {
        for (const file of fs.readdirSync(assetsDir)) {
          if (/\.(js|css|woff2?|svg|png|jpg)$/.test(file)) {
            precacheUrls.add(`${base}assets/${file}`);
          }
        }
      }

      const swSourcePath = path.resolve(__dirname, 'public', 'sw.js');
      if (fs.existsSync(swSourcePath)) {
        let swContent = fs.readFileSync(swSourcePath, 'utf8');
        swContent = swContent
          .replace('__BASE_PATH__', JSON.stringify(base))
          .replace('__PRECACHE_URLS__', JSON.stringify([...precacheUrls]))
          .replace('__BUILD_VERSION__', JSON.stringify(`v-${Date.now()}`));
        fs.writeFileSync(path.join(distDir, 'sw.js'), swContent, 'utf8');
      }
    },
  };
}

export default defineConfig(() => {
  const base = normalizeBase(process.env.VITE_BASE_PATH);

  return {
    base,
    plugins: [
      tailwindcss(),
      combustiblePwaPlugin(base),
      {
        name: 'copy-unbundled-src-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) return;
          const distDir = path.resolve(__dirname, 'dist');
          const srcAssets = path.resolve(__dirname, 'src/assets');
          const distAssets = path.resolve(distDir, 'src/assets');
          if (fs.existsSync(distDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, { recursive: true, force: true });
          }
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
