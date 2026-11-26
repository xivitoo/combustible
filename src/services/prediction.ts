export type PredictionTrend = 'subida' | 'estable' | 'bajada';
export type PredictionConfidence = 'alta' | 'media' | 'baja';

export interface StationPrediction {
  p_g95: number | null;
  p_goa: number | null;
  p_g98: number | null;
  p_glp: number | null;
  var_g95: number | null;
  var_goa: number | null;
  var_g98: number | null;
  var_glp: number | null;
  rango_g95: [number, number] | null;
  rango_goa: [number, number] | null;
  rango_g98: [number, number] | null;
  rango_glp: [number, number] | null;
  tendencia: PredictionTrend;
  variacion_est: number;
  confianza: PredictionConfidence;
  mensaje: string;
}

export interface FuelPredictionPayload {
  fecha_actualizacion: string;
  fecha_datos: string;
  tendencia_macro: PredictionTrend;
  variacion_mercado_7d_pct: number;
  media_nacional_g95?: number | null;
  media_nacional_goa?: number | null;
  media_nacional_g98?: number | null;
  media_nacional_glp?: number | null;
  estaciones: Record<string, StationPrediction>;
}

let cachedPromise: Promise<FuelPredictionPayload | null> | null = null;

export function loadFuelPredictions(): Promise<FuelPredictionPayload | null> {
  if (cachedPromise) return cachedPromise;

  const base = import.meta.env.BASE_URL || '/';
  const url = `${base}data/prediccion_actual.json`;

  cachedPromise = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
        cache: 'no-cache',
      });
      if (!res.ok) return null;
      const data = (await res.json()) as FuelPredictionPayload;
      if (!data || typeof data.estaciones !== 'object') return null;
      return data;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  })();

  return cachedPromise;
}
