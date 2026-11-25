/**
 * Cloudflare Worker — Proxy oficial de carburantes para Combustible by XivIoT
 * - Cabeceras CORS abiertas para GitHub Pages y cualquier origen web
 * - Caché en Edge de 10 minutos (600 segundos) para respuesta instantánea
 * - Soporta filtro opcional ?provincia=28 (código INE/Ministerio de 2 dígitos)
 */

const MINETUR_BASE =
  'https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres';
const EDGE_CACHE_SECONDS = 600; // 10 minutos

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Origin',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json; charset=utf-8',
        },
      });
    }

    const url = new URL(request.url);
    const provincia = url.searchParams.get('provincia')?.trim() || '';

    if (provincia && !/^\d{2}$/.test(provincia)) {
      return new Response(JSON.stringify({ error: 'Invalid province code' }), {
        status: 400,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json; charset=utf-8',
        },
      });
    }

    const upstreamUrl = provincia
      ? `${MINETUR_BASE}/FiltroProvincia/${provincia}`
      : MINETUR_BASE;

    // Clave normalizada para la caché en Edge de Cloudflare
    const cacheKey = new Request(
      `https://cache.combustible.local/stations?provincia=${provincia || 'all'}`,
      { method: 'GET' }
    );

    const cache = caches.default;
    const cached = await cache.match(cacheKey);

    if (cached) {
      const headers = new Headers(cached.headers);
      Object.entries(CORS_HEADERS).forEach(([k, v]) => headers.set(k, v));
      headers.set('X-Edge-Cache', 'HIT');
      return new Response(request.method === 'HEAD' ? null : cached.body, {
        status: cached.status,
        headers,
      });
    }

    try {
      const upstreamResponse = await fetch(upstreamUrl, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Combustible-XivIoT-Worker/1.0',
        },
        cf: {
          cacheEverything: true,
          cacheTtl: EDGE_CACHE_SECONDS,
        },
      });

      if (!upstreamResponse.ok) {
        return new Response(
          JSON.stringify({
            error: 'Upstream unavailable',
            status: upstreamResponse.status,
          }),
          {
            status: 502,
            headers: {
              ...CORS_HEADERS,
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store',
            },
          }
        );
      }

      const bodyBuffer = await upstreamResponse.arrayBuffer();

      const responseHeaders = new Headers({
        ...CORS_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `public, max-age=${EDGE_CACHE_SECONDS}, s-maxage=${EDGE_CACHE_SECONDS}`,
        'X-Edge-Cache': 'MISS',
      });

      const cacheableResponse = new Response(bodyBuffer, {
        status: 200,
        headers: responseHeaders,
      });

      ctx.waitUntil(cache.put(cacheKey, cacheableResponse.clone()));

      return new Response(request.method === 'HEAD' ? null : bodyBuffer, {
        status: 200,
        headers: responseHeaders,
      });
    } catch (err) {
      return new Response(
        JSON.stringify({
          error: 'Upstream fetch failed',
          detail: err instanceof Error ? err.message : 'Unknown error',
        }),
        {
          status: 502,
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        }
      );
    }
  },
};
