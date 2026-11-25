import { PROVINCES } from '../data/provinces';
import type { Province } from '../types';

export interface GeoCoords {
  lat: number;
  lng: number;
  accuracy?: number;
}

export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function estimateDriveMinutes(km: number): number {
  if (km <= 0.4) return 1;
  if (km <= 3.5) return Math.max(2, Math.round(km * 2.4));
  if (km <= 18) return Math.round(km * 1.55 + 2);
  return Math.round(km * 0.85 + 12);
}

export function findNearestProvince(lat: number, lng: number): Province {
  let best = PROVINCES[0];
  let bestDist = Infinity;
  for (const prov of PROVINCES) {
    const d = haversineKm(lat, lng, prov.lat, prov.lng);
    if (d < bestDist) {
      bestDist = d;
      best = prov;
    }
  }
  return best;
}

export async function isGeolocationGranted(): Promise<boolean> {
  if (!('geolocation' in navigator)) return false;
  if (!('permissions' in navigator) || !navigator.permissions?.query) {
    return false;
  }
  try {
    const status = await navigator.permissions.query({ name: 'geolocation' });
    return status.state === 'granted';
  } catch {
    return false;
  }
}

export function requestCurrentPosition(timeoutMs = 9000): Promise<GeoCoords> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('Geolocalización no disponible'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
      },
      (err) => reject(err),
      {
        enableHighAccuracy: true,
        timeout: timeoutMs,
        maximumAge: 60_000,
      }
    );
  });
}
