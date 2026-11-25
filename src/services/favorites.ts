import type { FavoriteEntry, Station } from '../types';

const FAVORITES_KEY = 'combustible_xiviot_favorites_v1';

export const QUICK_FAVORITE_TAGS = ['🏠 Casa', '💼 Trabajo', '🎓 Uni'];

export function getFavorites(): FavoriteEntry[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is FavoriteEntry =>
        Boolean(item && typeof item.id === 'string' && item.station)
    );
  } catch {
    return [];
  }
}

function persistFavorites(list: FavoriteEntry[]): void {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(list));
  } catch {
    // Ignore storage quota errors
  }
}

export function isFavorite(stationId: string): boolean {
  return getFavorites().some((f) => f.id === stationId);
}

export function getFavorite(stationId: string): FavoriteEntry | undefined {
  return getFavorites().find((f) => f.id === stationId);
}

export function saveFavorite(
  station: Station,
  tag: string,
  priceSource: 'online' | 'offline' = 'online'
): FavoriteEntry[] {
  const cleanTag = tag.trim() || '⭐ Favorita';
  const current = getFavorites();
  const idx = current.findIndex((f) => f.id === station.id);
  const entry: FavoriteEntry = {
    id: station.id,
    tag: cleanTag,
    savedAt: idx >= 0 ? current[idx].savedAt : Date.now(),
    priceUpdatedAt: Date.now(),
    priceSource,
    station,
  };

  if (idx >= 0) {
    current[idx] = entry;
  } else {
    current.unshift(entry);
  }
  persistFavorites(current);
  return current;
}

export function removeFavorite(stationId: string): FavoriteEntry[] {
  const next = getFavorites().filter((f) => f.id !== stationId);
  persistFavorites(next);
  return next;
}

export function syncFavoritesWithStations(
  stations: Station[],
  priceSource: 'online' | 'offline'
): FavoriteEntry[] {
  const current = getFavorites();
  if (current.length === 0 || stations.length === 0) return current;

  const byId = new Map<string, Station>();
  for (const st of stations) {
    byId.set(st.id, st);
  }

  let changed = false;
  const updated = current.map((fav) => {
    const fresh = byId.get(fav.id);
    if (!fresh) return fav;
    changed = true;
    return {
      ...fav,
      priceUpdatedAt: Date.now(),
      priceSource,
      station: fresh,
    };
  });

  if (changed) {
    persistFavorites(updated);
  }
  return updated;
}
