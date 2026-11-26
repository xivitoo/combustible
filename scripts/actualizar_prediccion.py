#!/usr/bin/env python3
"""
Predicción determinista a 7 días del precio de carburantes en España:
- Gasolina 95 E5 (g95)
- Diésel A (goa)
- Gasolina 98 E5 (g98)
- GLP / Autogas (glp)

Fuentes gratuitas (sin API Key):
1. MITECO (Precios en surtidor de España)
2. Frankfurter API / BCE (Tipo de cambio EUR/USD)
3. FRED DCOILBRENTEU (Cotización diaria internacional del crudo en USD)

Archivos generados en OUTPUT_DIR (por defecto `public/data` para Vite + GitHub Pages;
cámbialo a `data` o `docs/data` si tu repositorio sirve directamente desde otra carpeta):
- historico_macro.csv
- ventana_14d.json.gz
- prediccion_actual.json
"""

from __future__ import annotations

import gzip
import io
import json
import math
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pandas as pd
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# ==============================================================================
# CONFIGURACIÓN DE RUTAS Y PARÁMETROS DEL MODELO
# ==============================================================================
OUTPUT_DIR = Path(os.environ.get("COMBUSTIBLE_DATA_DIR", "public/data"))

HIST_CSV_PATH = OUTPUT_DIR / "historico_macro.csv"
VENTANA_GZ_PATH = OUTPUT_DIR / "ventana_14d.json.gz"
PREDICTION_JSON_PATH = OUTPUT_DIR / "prediccion_actual.json"

MITECO_URL = (
    "https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/"
    "PreciosCarburantes/EstacionesTerrestres/"
)
FRANKFURTER_URL_TPL = "https://api.frankfurter.dev/v1/{start_date}..?base=EUR&symbols=USD"
FRED_CRUDE_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DCOILBRENTEU"

HTTP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (compatible; CombustibleByXivIoT/1.0; "
        "+https://xivitoo.github.io/combustible/)"
    ),
    "Accept": "application/json, text/csv, */*",
    "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
}

# Parámetros deterministas de retardo de transmisión (3 a 10 días) y amortiguación fiscal
FACTOR_AMORTIGUACION_FISCAL = 0.47  # Impuestos fijos IEH + IVA amortiguan el crudo
TRANSMISION_ALCISTA = 0.68
TRANSMISION_BAJISTA = 0.56

# Sensibilidad por carburante (GLP se traslada más lento y amortiguado)
SENSIBILIDAD_CARBURANTE = {
    "g95": 0.96,
    "goa": 1.04,
    "g98": 0.98,
    "glp": 0.55,
}

UMBRAL_TENDENCIA = 0.015  # €/L a 7 días para clasificar subida / estable / bajada
DIAS_VENTANA_ESTACIONES = 14

# Leve ajuste estacional por día de la semana en España (0=Lunes ... 6=Domingo)
AJUSTE_DIA_SEMANA = {
    0: -0.0020,
    1: -0.0010,
    2: 0.0000,
    3: 0.0010,
    4: 0.0020,
    5: 0.0005,
    6: -0.0005,
}


def build_http_session() -> requests.Session:
    """Crea una sesión HTTP con User-Agent y reintentos automáticos."""
    session = requests.Session()
    session.headers.update(HTTP_HEADERS)

    retry_strategy = Retry(
        total=4,
        connect=4,
        read=4,
        backoff_factor=1.5,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET"],
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry_strategy)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


def parse_spanish_float(raw: Any) -> float | None:
    """Convierte números con coma decimal española ('1,529') a float válido."""
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        val = float(raw)
        return val if math.isfinite(val) and val > 0 else None
    text = str(raw).strip()
    if not text:
        return None
    try:
        val = float(text.replace(",", "."))
        return val if math.isfinite(val) and val > 0 else None
    except ValueError:
        return None


def parse_spanish_coord(raw: Any) -> float | None:
    """Convierte coordenadas con coma decimal española (pueden ser negativas) a float."""
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    try:
        val = float(text.replace(",", "."))
        return val if math.isfinite(val) else None
    except ValueError:
        return None


def fetch_miteco_stations(session: requests.Session) -> tuple[list[dict[str, Any]], str]:
    """Descarga y limpia Gasolina 95, Diésel A, Gasolina 98 y GLP del MITECO."""
    resp = session.get(MITECO_URL, timeout=(12, 45))
    resp.raise_for_status()
    payload = resp.json()

    raw_list = payload.get("ListaEESSPrecio") or []
    fecha_miteco = str(payload.get("Fecha") or "")

    stations: list[dict[str, Any]] = []
    for item in raw_list:
        ideess = str(item.get("IDEESS") or "").strip()
        if not ideess:
            continue

        p_g95 = parse_spanish_float(item.get("Precio Gasolina 95 E5"))
        p_goa = parse_spanish_float(item.get("Precio Gasoleo A"))
        p_g98 = parse_spanish_float(item.get("Precio Gasolina 98 E5"))
        p_glp = parse_spanish_float(item.get("Precio Gases licuados del petróleo"))

        if p_g95 is None and p_goa is None and p_g98 is None and p_glp is None:
            continue

        lat = parse_spanish_coord(item.get("Latitud"))
        lng = parse_spanish_coord(item.get("Longitud (WGS84)") or item.get("Longitud"))
        if lat is None or lng is None or (lat == 0 and lng == 0):
            continue

        stations.append(
            {
                "ideess": ideess,
                "rotulo": str(item.get("Rótulo") or "").strip(),
                "provincia": str(item.get("Provincia") or "").strip(),
                "municipio": str(item.get("Municipio") or "").strip(),
                "lat": round(lat, 6),
                "lng": round(lng, 6),
                "p_g95": round(p_g95, 3) if p_g95 is not None else None,
                "p_goa": round(p_goa, 3) if p_goa is not None else None,
                "p_g98": round(p_g98, 3) if p_g98 is not None else None,
                "p_glp": round(p_glp, 3) if p_glp is not None else None,
            }
        )

    if not stations:
        raise RuntimeError("La respuesta del MITECO no devolvió estaciones válidas.")

    return stations, fecha_miteco


def fetch_macro_series_15d(session: requests.Session, today_utc: datetime) -> pd.DataFrame:
    """
    Descarga y cruza los últimos 15 días hábiles de crudo en USD (FRED)
    y EUR/USD (Frankfurter BCE).
    """
    start_date = (today_utc - timedelta(days=26)).strftime("%Y-%m-%d")
    fx_url = FRANKFURTER_URL_TPL.format(start_date=start_date)

    fx_resp = session.get(fx_url, timeout=(10, 25))
    fx_resp.raise_for_status()
    fx_json = fx_resp.json()
    rates_dict = fx_json.get("rates") or {}
    if not rates_dict:
        raise RuntimeError("Frankfurter API no devolvió tipos de cambio EUR/USD.")

    fx_rows = [
        {"fecha": pd.to_datetime(d), "eur_usd": float(vals["USD"])}
        for d, vals in rates_dict.items()
        if isinstance(vals, dict) and "USD" in vals
    ]
    df_fx = pd.DataFrame(fx_rows).sort_values("fecha").reset_index(drop=True)

    crude_resp = session.get(FRED_CRUDE_CSV_URL, timeout=(10, 30))
    crude_resp.raise_for_status()
    df_crude_raw = pd.read_csv(io.StringIO(crude_resp.text))

    date_col = "observation_date" if "observation_date" in df_crude_raw.columns else df_crude_raw.columns[0]
    val_col = "DCOILBRENTEU" if "DCOILBRENTEU" in df_crude_raw.columns else df_crude_raw.columns[1]

    df_crude = df_crude_raw[[date_col, val_col]].rename(
        columns={date_col: "fecha", val_col: "crudo_usd"}
    )
    df_crude = df_crude[df_crude["crudo_usd"].astype(str).str.strip() != "."].copy()
    df_crude["crudo_usd"] = pd.to_numeric(df_crude["crudo_usd"], errors="coerce")
    df_crude["fecha"] = pd.to_datetime(df_crude["fecha"], errors="coerce")
    df_crude = df_crude.dropna(subset=["fecha", "crudo_usd"]).sort_values("fecha")

    df_crude = df_crude.tail(25).reset_index(drop=True)

    df_merged = pd.merge_asof(
        df_crude,
        df_fx,
        on="fecha",
        direction="backward",
    )
    df_merged["eur_usd"] = df_merged["eur_usd"].bfill().ffill()
    df_merged = df_merged.dropna(subset=["crudo_usd", "eur_usd"]).tail(15).reset_index(drop=True)

    if len(df_merged) < 5:
        raise RuntimeError("No hay suficientes días hábiles combinados en las series macro.")

    df_merged["crudo_eur"] = df_merged["crudo_usd"] / df_merged["eur_usd"]
    return df_merged


def update_macro_history_csv(
    today_str: str,
    crudo_usd: float,
    eur_usd: float,
    crudo_eur: float,
    media_g95: float | None,
    media_goa: float | None,
    media_g98: float | None,
    media_glp: float | None,
) -> None:
    """Añade o actualiza la fila de hoy en historico_macro.csv."""
    new_row = pd.DataFrame(
        [
            {
                "fecha": today_str,
                "crudo_usd": round(crudo_usd, 2),
                "eur_usd": round(eur_usd, 4),
                "crudo_eur": round(crudo_eur, 2),
                "media_nacional_g95": round(media_g95, 4) if media_g95 is not None else "",
                "media_nacional_goa": round(media_goa, 4) if media_goa is not None else "",
                "media_nacional_g98": round(media_g98, 4) if media_g98 is not None else "",
                "media_nacional_glp": round(media_glp, 4) if media_glp is not None else "",
            }
        ]
    )

    if HIST_CSV_PATH.exists():
        try:
            df_existing = pd.read_csv(HIST_CSV_PATH, dtype={"fecha": str})
            df_existing = df_existing[df_existing["fecha"] != today_str]
            df_out = pd.concat([df_existing, new_row], ignore_index=True)
        except Exception:
            df_out = new_row
    else:
        df_out = new_row

    df_out = df_out.sort_values("fecha").reset_index(drop=True)
    df_out.to_csv(HIST_CSV_PATH, index=False)


def load_and_update_window_14d(
    today_str: str,
    stations: list[dict[str, Any]],
) -> dict[str, dict[str, list[float | None]]]:
    """
    Carga ventana_14d.json.gz (si existe), inserta el día actual [g95, goa, g98, glp],
    purga todo lo anterior a 14 días y guarda de nuevo comprimido en gzip.
    """
    days_data: dict[str, dict[str, list[float | None]]] = {}

    if VENTANA_GZ_PATH.exists():
        try:
            with gzip.open(VENTANA_GZ_PATH, "rt", encoding="utf-8") as fh:
                raw = json.load(fh)
            if isinstance(raw, dict) and isinstance(raw.get("days"), dict):
                days_data = raw["days"]
        except Exception:
            days_data = {}

    today_snapshot: dict[str, list[float | None]] = {}
    for st in stations:
        today_snapshot[st["ideess"]] = [
            st["p_g95"],
            st["p_goa"],
            st["p_g98"],
            st["p_glp"],
        ]
    days_data[today_str] = today_snapshot

    cutoff_date = (
        datetime.strptime(today_str, "%Y-%m-%d") - timedelta(days=DIAS_VENTANA_ESTACIONES - 1)
    ).strftime("%Y-%m-%d")
    pruned_days = {
        day_key: day_vals
        for day_key, day_vals in sorted(days_data.items())
        if day_key >= cutoff_date
    }

    payload_out = {
        "updated_at": today_str,
        "days": pruned_days,
    }
    with gzip.open(VENTANA_GZ_PATH, "wt", encoding="utf-8", compresslevel=6) as fh:
        json.dump(payload_out, fh, ensure_ascii=False, separators=(",", ":"))

    return pruned_days


def compute_macro_signal(df_macro: pd.DataFrame) -> dict[str, Any]:
    """Calcula la señal macroeconómica a partir de los últimos 15 días hábiles."""
    crude_eur = df_macro["crudo_eur"].astype(float).reset_index(drop=True)
    n = len(crude_eur)

    recent_avg = float(crude_eur.iloc[-2:].mean())
    base_start = max(0, n - 10)
    base_end = max(base_start + 1, n - 5)
    prior_7d_avg = float(crude_eur.iloc[base_start:base_end].mean())

    var_7d_pct = ((recent_avg - prior_7d_avg) / prior_7d_avg) * 100.0
    var_14d_pct = ((float(crude_eur.iloc[-1]) - float(crude_eur.iloc[0])) / float(crude_eur.iloc[0])) * 100.0

    weighted_pct = 0.72 * var_7d_pct + 0.28 * var_14d_pct

    daily_returns_pct = crude_eur.pct_change().dropna() * 100.0
    vol_pct = float(daily_returns_pct.std()) if len(daily_returns_pct) >= 3 else 1.5
    vol_pct = max(0.8, min(4.5, vol_pct))

    if weighted_pct > 2.2:
        tendencia_macro = "subida"
    elif weighted_pct < -2.2:
        tendencia_macro = "bajada"
    else:
        tendencia_macro = "estable"

    return {
        "crudo_usd": float(df_macro["crudo_usd"].iloc[-1]),
        "eur_usd": float(df_macro["eur_usd"].iloc[-1]),
        "crudo_eur": float(crude_eur.iloc[-1]),
        "var_7d_pct": var_7d_pct,
        "var_14d_pct": var_14d_pct,
        "weighted_pct": weighted_pct,
        "vol_pct": vol_pct,
        "tendencia_macro": tendencia_macro,
    }


def compute_station_slope_eur_per_day(points: list[tuple[int, float]]) -> float | None:
    """Calcula la pendiente lineal (€/L por día) si hay al menos 3 días."""
    n = len(points)
    if n < 3:
        return None

    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    mean_x = sum(xs) / n
    mean_y = sum(ys) / n

    num = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
    den = sum((x - mean_x) ** 2 for x in xs)
    if den <= 1e-9:
        return 0.0

    slope = num / den
    return max(-0.010, min(0.010, slope))


def build_actionable_message(tendencia: str, variacion_est: float) -> str:
    """Genera un mensaje breve y accionable en español para mostrar al usuario."""
    cents = abs(variacion_est) * 100.0
    low = max(1, int(math.floor(cents)))
    high = max(low + 1, int(math.ceil(cents + 0.5)))

    if tendencia == "subida":
        return f"Reposta hoy: se espera una subida de ~{low}-{high} cént./L esta semana"
    if tendencia == "bajada":
        return f"Espera si puedes: posible bajada de ~{low}-{high} cént./L en 7 días"
    return "Precios estables esta semana: variación estimada menor de 1,5 cént./L"


def predict_for_fuel(
    price: float,
    fuel_key: str,
    macro: dict[str, Any],
    slope_per_day: float | None,
    weekday_adj: float,
    national_avg: float | None,
) -> tuple[float, list[float]]:
    """Calcula variación estimada (€/L) y horquilla [min, max] para un carburante."""
    pct = macro["weighted_pct"]
    transmision = TRANSMISION_ALCISTA if pct >= 0 else TRANSMISION_BAJISTA
    sens = SENSIBILIDAD_CARBURANTE[fuel_key]

    macro_delta = (
        price
        * (pct / 100.0)
        * FACTOR_AMORTIGUACION_FISCAL
        * transmision
        * sens
    )

    if slope_per_day is not None:
        station_delta = slope_per_day * 3.5
        combined_delta = 0.65 * macro_delta + 0.35 * station_delta
    else:
        reversion = 0.0
        if national_avg and national_avg > 0:
            diff_ratio = (price - national_avg) / national_avg
            if abs(diff_ratio) > 0.06:
                reversion = -diff_ratio * 0.04
        combined_delta = macro_delta + reversion

    day_adj = weekday_adj * (0.4 if fuel_key == "glp" else 1.0)
    total_delta = combined_delta + day_adj
    projected = price + total_delta

    band_scale = 0.65 if fuel_key == "glp" else 1.0
    half_band = max(
        0.006 if fuel_key == "glp" else 0.008,
        min(0.026, (0.007 + macro["vol_pct"] * 0.0035 + abs(total_delta) * 0.18) * band_scale),
    )
    if slope_per_day is None:
        half_band += 0.002 if fuel_key == "glp" else 0.003

    r_min = round(max(0.35, projected - half_band), 3)
    r_max = round(max(r_min + 0.004, projected + half_band), 3)
    return round(total_delta, 3), [r_min, r_max]


def run() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    now_utc = datetime.now(timezone.utc)
    today_str = now_utc.strftime("%Y-%m-%d")
    weekday_adj = AJUSTE_DIA_SEMANA.get(now_utc.weekday(), 0.0)

    session = build_http_session()

    print("1/4 Descargando precios oficiales del MITECO...")
    stations, fecha_miteco = fetch_miteco_stations(session)

    def calc_avg(key: str) -> float | None:
        vals = [s[key] for s in stations if s[key] is not None]
        return sum(vals) / len(vals) if vals else None

    media_g95 = calc_avg("p_g95")
    media_goa = calc_avg("p_goa")
    media_g98 = calc_avg("p_g98")
    media_glp = calc_avg("p_glp")

    print("2/4 Descargando EUR/USD (BCE) y cotización energética internacional...")
    df_macro = fetch_macro_series_15d(session, now_utc)
    macro = compute_macro_signal(df_macro)

    print("3/4 Actualizando histórico macro y ventana deslizante de 14 días...")
    update_macro_history_csv(
        today_str=today_str,
        crudo_usd=macro["crudo_usd"],
        eur_usd=macro["eur_usd"],
        crudo_eur=macro["crudo_eur"],
        media_g95=media_g95,
        media_goa=media_goa,
        media_g98=media_g98,
        media_glp=media_glp,
    )
    pruned_days = load_and_update_window_14d(today_str, stations)

    sorted_day_keys = sorted(pruned_days.keys())
    day_base = datetime.strptime(sorted_day_keys[0], "%Y-%m-%d")
    day_offsets = {
        k: (datetime.strptime(k, "%Y-%m-%d") - day_base).days for k in sorted_day_keys
    }

    series_by_fuel: dict[str, dict[str, list[tuple[int, float]]]] = {
        "g95": {},
        "goa": {},
        "g98": {},
        "glp": {},
    }
    fuel_idx = [("g95", 0), ("goa", 1), ("g98", 2), ("glp", 3)]

    for day_key in sorted_day_keys:
        offset = day_offsets[day_key]
        day_map = pruned_days[day_key]
        for ideess, tuple_vals in day_map.items():
            if not isinstance(tuple_vals, list):
                continue
            for fkey, idx in fuel_idx:
                if idx < len(tuple_vals) and tuple_vals[idx] is not None:
                    series_by_fuel[fkey].setdefault(ideess, []).append((offset, float(tuple_vals[idx])))

    print("4/4 Generando predicción a 7 días para G95, Diésel A, G98 y GLP...")
    estaciones_out: dict[str, dict[str, Any]] = {}

    for st in stations:
        ideess = st["ideess"]

        slopes = {
            fkey: compute_station_slope_eur_per_day(series_by_fuel[fkey].get(ideess, []))
            for fkey, _ in fuel_idx
        }

        avgs = {
            "g95": media_g95,
            "goa": media_goa,
            "g98": media_g98,
            "glp": media_glp,
        }

        deltas: dict[str, float | None] = {"g95": None, "goa": None, "g98": None, "glp": None}
        rangos: dict[str, list[float] | None] = {"g95": None, "goa": None, "g98": None, "glp": None}
        valid_deltas: list[float] = []

        for fkey, _ in fuel_idx:
            price = st[f"p_{fkey}"]
            if price is not None:
                d_val, r_val = predict_for_fuel(
                    price, fkey, macro, slopes[fkey], weekday_adj, avgs[fkey]
                )
                deltas[fkey] = d_val
                rangos[fkey] = r_val
                valid_deltas.append(d_val)

        variacion_est = round(sum(valid_deltas) / len(valid_deltas), 3) if valid_deltas else 0.0
        if variacion_est > UMBRAL_TENDENCIA:
            tendencia = "subida"
        elif variacion_est < -UMBRAL_TENDENCIA:
            tendencia = "bajada"
        else:
            tendencia = "estable"

        history_days = max(
            (len(series_by_fuel[fkey].get(ideess, [])) for fkey, _ in fuel_idx),
            default=0,
        )
        main_slope = next((slopes[k] for k in ("g95", "goa", "g98", "glp") if slopes[k] is not None), None)
        signals_agree = (
            main_slope is not None
            and (
                (macro["weighted_pct"] >= 1.0 and main_slope >= -0.0005)
                or (macro["weighted_pct"] <= -1.0 and main_slope <= 0.0005)
                or (abs(macro["weighted_pct"]) < 1.5 and abs(main_slope) <= 0.002)
            )
        )

        if history_days >= 7 and signals_agree:
            confianza = "alta"
        elif history_days >= 3 or abs(macro["weighted_pct"]) >= 2.8:
            confianza = "media"
        else:
            confianza = "baja"

        estaciones_out[ideess] = {
            "p_g95": st["p_g95"],
            "p_goa": st["p_goa"],
            "p_g98": st["p_g98"],
            "p_glp": st["p_glp"],
            "var_g95": deltas["g95"],
            "var_goa": deltas["goa"],
            "var_g98": deltas["g98"],
            "var_glp": deltas["glp"],
            "rango_g95": rangos["g95"],
            "rango_goa": rangos["goa"],
            "rango_g98": rangos["g98"],
            "rango_glp": rangos["glp"],
            "tendencia": tendencia,
            "variacion_est": variacion_est,
            "confianza": confianza,
            "mensaje": build_actionable_message(tendencia, variacion_est),
        }

    prediction_payload = {
        "fecha_actualizacion": now_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "fecha_datos": today_str,
        "fecha_miteco": fecha_miteco,
        "dias_historico_estaciones": len(sorted_day_keys),
        "tendencia_macro": macro["tendencia_macro"],
        "variacion_mercado_7d_pct": round(macro["var_7d_pct"], 2),
        "eur_usd": round(macro["eur_usd"], 4),
        "media_nacional_g95": round(media_g95, 3) if media_g95 is not None else None,
        "media_nacional_goa": round(media_goa, 3) if media_goa is not None else None,
        "media_nacional_g98": round(media_g98, 3) if media_g98 is not None else None,
        "media_nacional_glp": round(media_glp, 3) if media_glp is not None else None,
        "total_estaciones": len(estaciones_out),
        "estaciones": estaciones_out,
    }

    with open(PREDICTION_JSON_PATH, "w", encoding="utf-8") as fh:
        json.dump(prediction_payload, fh, ensure_ascii=False, separators=(",", ":"))

    print(
        f"Listo: {len(estaciones_out)} estaciones procesadas | "
        f"Mercado 7d: {macro['var_7d_pct']:+.2f}% ({macro['tendencia_macro']}) | "
        f"Ventana: {len(sorted_day_keys)} días"
    )


if __name__ == "__main__":
    run()
