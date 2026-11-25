import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const MINETUR_BASE =
  'https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos

interface CacheItem {
  body: string;
  fetchedAt: number;
}

const memoryCache = new Map<string, CacheItem>();

async function startServer() {
  const app = express();

  app.get('/api/fuel/stations', async (req, res) => {
    const rawProvince =
      typeof req.query.provincia === 'string' ? req.query.provincia.trim() : '';

    if (rawProvince && !/^\d{2}$/.test(rawProvince)) {
      res.status(400).json({ error: 'Código de provincia inválido' });
      return;
    }

    const cacheKey = rawProvince || 'all';
    const cached = memoryCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=600');
      res.setHeader('X-Proxy-Cache', 'HIT');
      res.status(200).send(cached.body);
      return;
    }

    const targetUrl = rawProvince
      ? `${MINETUR_BASE}/FiltroProvincia/${rawProvince}`
      : MINETUR_BASE;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      const upstream = await fetch(targetUrl, {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Combustible-XivIoT-DevProxy/1.0',
        },
      });

      if (!upstream.ok) {
        res.status(502).json({ error: 'Servicio externo no disponible' });
        return;
      }

      const body = await upstream.text();
      memoryCache.set(cacheKey, { body, fetchedAt: Date.now() });

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=600');
      res.setHeader('X-Proxy-Cache', 'MISS');
      res.status(200).send(body);
    } catch {
      res.status(502).json({ error: 'No se pudo conectar con la fuente oficial' });
    } finally {
      clearTimeout(timeout);
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Combustible by XivIoT running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
