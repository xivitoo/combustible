#!/usr/bin/env node
/**
 * Script Node.js sin dependencias externas para descargar y compactar
 * el respaldo estático de estaciones del Ministerio en public/data/stations.json.
 *
 * Uso:
 *   node scripts/update-stations.mjs            # Fuerza actualización
 *   node scripts/update-stations.mjs --if-stale # Solo actualiza si falta o supera MAX_AGE_HOURS
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const OUTPUT_PATH = path.join(ROOT_DIR, 'public', 'data', 'stations.json');
const ENDPOINT =
  'https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres';

const MAX_AGE_HOURS = Number(process.env.STATIONS_MAX_AGE_HOURS || 6);
const ifStale = process.argv.includes('--if-stale');

function parseEsNumber(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number.parseFloat(trimmed.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function isFileFresh(filePath, maxAgeHours) {
  if (!fs.existsSync(filePath)) return false;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < 1024) return false;
    const ageMs = Date.now() - stat.mtimeMs;
    return ageMs < maxAgeHours * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

function compactStation(raw) {
  const lat = parseEsNumber(raw['Latitud']);
  const lng = parseEsNumber(raw['Longitud (WGS84)']);
  if (lat === null || lng === null || (lat === 0 && lng === 0)) return null;

  const entry = {
    id: String(raw['IDEESS'] || '').trim(),
    p: String(raw['IDProvincia'] || '').trim().padStart(2, '0'),
    pn: String(raw['Provincia'] || '').trim(),
    m: String(raw['Municipio'] || '').trim(),
    l: String(raw['Localidad'] || '').trim(),
    d: String(raw['Dirección'] || '').trim(),
    cp: String(raw['C.P.'] || '').trim(),
    h: String(raw['Horario'] || '').trim(),
    r: String(raw['Rótulo'] || '').trim() || 'Estación independiente',
    tv: String(raw['Tipo Venta'] || 'P').trim(),
    lat: Number(lat.toFixed(6)),
    lng: Number(lng.toFixed(6)),
  };

  const fuelMap = {
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

  let hasAnyFuel = false;
  for (const [shortKey, rawKey] of Object.entries(fuelMap)) {
    const val = parseEsNumber(raw[rawKey]);
    if (val !== null && val > 0) {
      entry[shortKey] = val;
      hasAnyFuel = true;
    }
  }

  return hasAnyFuel && entry.id ? entry : null;
}

async function main() {
  if (ifStale && isFileFresh(OUTPUT_PATH, MAX_AGE_HOURS)) {
    console.log(
      `[update-stations] Respaldo vigente (< ${MAX_AGE_HOURS}h), omitiendo descarga.`
    );
    return;
  }

  console.log('[update-stations] Descargando estaciones oficiales...');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  try {
    const res = await fetch(ENDPOINT, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Combustible-XivIoT-Backup/1.0',
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} al descargar estaciones`);
    }

    const payload = await res.json();
    const list = Array.isArray(payload?.ListaEESSPrecio)
      ? payload.ListaEESSPrecio
      : [];

    if (list.length === 0) {
      throw new Error('La respuesta no contiene estaciones válidas');
    }

    const stations = [];
    for (const raw of list) {
      const compacted = compactStation(raw);
      if (compacted) stations.push(compacted);
    }

    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    const output = {
      fecha: payload.Fecha || new Date().toISOString(),
      generatedAt: Date.now(),
      count: stations.length,
      stations,
    };

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output), 'utf8');
    const sizeKb = Math.round(fs.statSync(OUTPUT_PATH).size / 1024);
    console.log(
      `[update-stations] Guardadas ${stations.length} estaciones (${sizeKb} KB) en public/data/stations.json`
    );
  } catch (err) {
    if (fs.existsSync(OUTPUT_PATH)) {
      console.warn(
        `[update-stations] Falló la descarga (${err.message}); se conserva el respaldo anterior.`
      );
      return;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

main().catch((err) => {
  console.error('[update-stations] Error fatal:', err);
  process.exit(1);
});
