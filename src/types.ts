export type PrimaryFuelKey = 'g95' | 'da' | 'g98' | 'glp';

export type DataMode = 'loading' | 'online' | 'offline-cache' | 'offline-empty' | 'offline-backup';

export type TabId = 'explore' | 'cheap' | 'favorites';

export type SheetSnap = 'min' | 'mid' | 'full';

export type SortMode = 'cheapest-near' | 'nearest';

export interface Station {
  id: string;
  provinceId: string;
  provinceName: string;
  municipality: string;
  locality: string;
  address: string;
  cp: string;
  schedule: string;
  brand: string;
  saleType: string;
  lat: number;
  lng: number;
  prices: Record<string, number>;
}

export interface Province {
  id: string;
  name: string;
  ccaa: string;
  lat: number;
  lng: number;
  zoom: number;
}

export interface FavoriteEntry {
  id: string;
  tag: string;
  savedAt: number;
  priceUpdatedAt: number;
  priceSource: 'online' | 'offline';
  station: Station;
}

export interface ProvinceLoadResult {
  mode: DataMode;
  stations: Station[];
  fetchedAt: number | null;
  sourceDate: string | null;
  ageMinutes: number | null;
}

export interface FuelMeta {
  key: string;
  label: string;
  shortLabel: string;
}
