import type { PrimaryFuelKey, ProvinceLoadResult, Station } from '../types';

const CACHE_PREFIX = 'combustible_prov_cache_v1_';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos

interface CachedProvincePayload {
  fetchedAt: number;
  sourceDate: string | null;
  stations: Station[];
}

export function parseEsNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const num = Number.parseFloat(trimmed.replace(',', '.'));
  return Number.isFinite(num) ? num : null;
}

const RAW_FUEL_MAP: Record<string, string> = {
  g95: 'Precio Gasolina 95 E5',
  g95p: 'Precio Gasolina 95 E5 Premium',
  g95e10: 'Precio Gasolina 95 E10',
  da: 'Precio Gasoleo A',
  dap: 'Precio Gasoleo Premium',
  db: 'Precio Gasoleo B',
  dr: 'Precio Diésel Renovable',
  g98: 'Precio Gasolina 98 E5',
  g98e10: 'Precio Gasolina 98 E10',
  gr: 'Precio Gasolina Renovable',
  glp: 'Precio Gases licuados del petróleo',
  gnc: 'Precio Gas Natural Comprimido',
  gnl: 'Precio Gas Natural Licuado',
  bio: 'Precio Biodiesel',
  et: 'Precio Bioetanol',
  h2: 'Precio Hidrogeno',
  adb: 'Precio Adblue',
};

const COMPACT_FUEL_KEYS = Object.keys(RAW_FUEL_MAP);

export function normalizeRawOrCompactStation(raw: Record<string, unknown>): Station | null {
  // Soporta formato compacto (public/data/stations.json)
  if (typeof raw.id === 'string' && typeof raw.lat === 'number' && typeof raw.lng === 'number') {
    const prices: Record<string, number> = {};
    for (const k of COMPACT_FUEL_KEYS) {
      const val = raw[k];
      if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
        prices[k] = val;
      }
    }
    if (Object.keys(prices).length === 0) return null;
    return {
      id: raw.id,
      provinceId: String(raw.p || '').padStart(2, '0'),
      provinceName: String(raw.pn || ''),
      municipality: String(raw.m || ''),
      locality: String(raw.l || ''),
      address: String(raw.d || ''),
      cp: String(raw.cp || ''),
      schedule: String(raw.h || ''),
      brand: String(raw.r || 'Estación independiente'),
      saleType: String(raw.tv || 'P'),
      lat: raw.lat,
      lng: raw.lng,
      prices,
    };
  }

  // Formato oficial JSON del Ministerio
  const lat = parseEsNumber(raw['Latitud']);
  const lng = parseEsNumber(raw['Longitud (WGS84)']);
  const id = String(raw['IDEESS'] || '').trim();
  if (!id || lat === null || lng === null || (lat === 0 && lng === 0)) {
    return null;
  }

  const prices: Record<string, number> = {};
  for (const [shortKey, rawKey] of Object.entries(RAW_FUEL_MAP)) {
    const val = parseEsNumber(raw[rawKey]);
    if (val !== null && val > 0) {
      prices[shortKey] = val;
    }
  }

  if (Object.keys(prices).length === 0) return null;

  return {
    id,
    provinceId: String(raw['IDProvincia'] || '').trim().padStart(2, '0'),
    provinceName: String(raw['Provincia'] || '').trim(),
    municipality: String(raw['Municipio'] || '').trim(),
    locality: String(raw['Localidad'] || '').trim(),
    address: String(raw['Dirección'] || '').trim(),
    cp: String(raw['C.P.'] || '').trim(),
    schedule: String(raw['Horario'] || '').trim(),
    brand: String(raw['Rótulo'] || '').trim() || 'Estación independiente',
    saleType: String(raw['Tipo Venta'] || 'P').trim(),
    lat,
    lng,
    prices,
  };
}

function parseStationsPayload(
  payload: unknown,
  provinceId?: string
): { stations: Station[]; sourceDate: string | null } {
  const obj = payload as Record<string, unknown> | null;
  const rawList = Array.isArray(obj?.ListaEESSPrecio)
    ? obj.ListaEESSPrecio
    : Array.isArray(obj?.stations)
      ? obj.stations
      : [];

  const stations: Station[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const st = normalizeRawOrCompactStation(item as Record<string, unknown>);
    if (!st) continue;
    if (provinceId && st.provinceId !== provinceId) continue;
    stations.push(st);
  }

  const sourceDate =
    typeof obj?.Fecha === 'string'
      ? obj.Fecha
      : typeof obj?.fecha === 'string'
        ? obj.fecha
        : null;

  return { stations, sourceDate };
}

function readProvinceCache(provinceId: string): CachedProvincePayload | null {
  try {
    const raw = localStorage.getItem(`${CACHE_PREFIX}${provinceId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedProvincePayload;
    if (!parsed || !Array.isArray(parsed.stations) || typeof parsed.fetchedAt !== 'number') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeProvinceCache(provinceId: string, payload: CachedProvincePayload): void {
  try {
    localStorage.setItem(`${CACHE_PREFIX}${provinceId}`, JSON.stringify(payload));
  } catch {
    // Si la cuota está llena, limpia cachés de otras provincias y reintenta
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && key.startsWith(CACHE_PREFIX) && key !== `${CACHE_PREFIX}${provinceId}`) {
          localStorage.removeItem(key);
        }
      }
      localStorage.setItem(`${CACHE_PREFIX}${provinceId}`, JSON.stringify(payload));
    } catch {
      // Ignorar si sigue sin espacio
    }
  }
}

function buildOnlineEndpoints(provinceId: string): string[] {
  const proxyEnv = (import.meta.env.VITE_FUEL_PROXY_URL || '').trim();
  const urls: string[] = [];

  if (proxyEnv) {
    const sep = proxyEnv.includes('?') ? '&' : '?';
    urls.push(`${proxyEnv}${sep}provincia=${encodeURIComponent(provinceId)}`);
  }

  // En desarrollo / servidor Node integrado
  urls.push(`/api/fuel/stations?provincia=${encodeURIComponent(provinceId)}`);
  return urls;
}

async function fetchJsonWithTimeout(url: string, timeoutMs = 10_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json') && !contentType.includes('text/plain')) {
      throw new Error('Respuesta no válida');
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function loadProvinceStations(provinceId: string): Promise<ProvinceLoadResult> {
  const normalizedProv = provinceId.padStart(2, '0');
  const cached = readProvinceCache(normalizedProv);

  if (navigator.onLine) {
    const endpoints = buildOnlineEndpoints(normalizedProv);
    for (const url of endpoints) {
      try {
        const payload = await fetchJsonWithTimeout(url, 10_000);
        const { stations, sourceDate } = parseStationsPayload(payload, normalizedProv);
        if (stations.length > 0) {
          const fetchedAt = Date.now();
          writeProvinceCache(normalizedProv, {
            fetchedAt,
            sourceDate,
            stations,
          });
          return {
            mode: 'online',
            stations,
            fetchedAt,
            sourceDate,
            ageMinutes: 0,
          };
        }
      } catch {
        // Probar siguiente origen Online o pasar a caché Offline
      }
    }
  }

  // Si falla o no hay internet: mostrar últimos precios si se consultaron hace < 10 min
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    const ageMinutes = Math.max(1, Math.round((Date.now() - cached.fetchedAt) / 60_000));
    return {
      mode: 'offline-cache',
      stations: cached.stations,
      fetchedAt: cached.fetchedAt,
      sourceDate: cached.sourceDate,
      ageMinutes,
    };
  }

  return {
    mode: 'offline-empty',
    stations: [],
    fetchedAt: cached?.fetchedAt || null,
    sourceDate: cached?.sourceDate || null,
    ageMinutes: cached
      ? Math.max(1, Math.round((Date.now() - cached.fetchedAt) / 60_000))
      : null,
  };
}

export async function loadStaticBackupProvince(provinceId: string): Promise<ProvinceLoadResult> {
  const normalizedProv = provinceId.padStart(2, '0');
  const base = import.meta.env.BASE_URL || '/';
  const url = `${base}data/stations.json`;
  const payload = await fetchJsonWithTimeout(url, 15_000);
  const { stations, sourceDate } = parseStationsPayload(payload, normalizedProv);
  return {
    mode: 'offline-backup',
    stations,
    fetchedAt: Date.now(),
    sourceDate,
    ageMinutes: null,
  };
}

export async function findStationByIdGlobally(stationId: string): Promise<Station | null> {
  const cleanId = stationId.trim();
  if (!cleanId) return null;

  // 1. Buscar en cachés locales recientes
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(CACHE_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as CachedProvincePayload;
      const found = parsed.stations?.find((s) => s.id === cleanId);
      if (found) return found;
    }
  } catch {
    // Continuar con respaldo estático
  }

  // 2. Buscar en respaldo estático completo si existe
  try {
    const base = import.meta.env.BASE_URL || '/';
    const payload = await fetchJsonWithTimeout(`${base}data/stations.json`, 15_000);
    const { stations } = parseStationsPayload(payload);
    return stations.find((s) => s.id === cleanId) || null;
  } catch {
    return null;
  }
}

export function filterStationsByFuel(stations: Station[], fuel: PrimaryFuelKey): Station[] {
  return stations.filter((s) => {
    const p = s.prices[fuel];
    return typeof p === 'number' && Number.isFinite(p) && p > 0;
  });
}
