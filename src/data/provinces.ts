import type { FuelMeta, PrimaryFuelKey, Province } from '../types';

export const PRIMARY_FUELS: Array<{
  key: PrimaryFuelKey;
  label: string;
  shortLabel: string;
}> = [
  { key: 'g95', label: 'Gasolina 95', shortLabel: 'G95' },
  { key: 'da', label: 'Diésel A', shortLabel: 'Diésel A' },
  { key: 'g98', label: 'Gasolina 98', shortLabel: 'G98' },
  { key: 'glp', label: 'GLP', shortLabel: 'GLP' },
];

export const ALL_FUEL_META: FuelMeta[] = [
  { key: 'g95', label: 'Gasolina 95 E5', shortLabel: 'G95' },
  { key: 'da', label: 'Diésel A (Gasóleo A)', shortLabel: 'Diésel A' },
  { key: 'g98', label: 'Gasolina 98 E5', shortLabel: 'G98' },
  { key: 'glp', label: 'GLP (Autogás)', shortLabel: 'GLP' },
  { key: 'dap', label: 'Diésel Premium', shortLabel: 'Diésel+' },
  { key: 'g95p', label: 'Gasolina 95 Premium', shortLabel: 'G95+' },
  { key: 'g95e10', label: 'Gasolina 95 E10', shortLabel: 'G95 E10' },
  { key: 'g98e10', label: 'Gasolina 98 E10', shortLabel: 'G98 E10' },
  { key: 'dr', label: 'Diésel Renovable', shortLabel: 'Diésel R.' },
  { key: 'gr', label: 'Gasolina Renovable', shortLabel: 'Gasolina R.' },
  { key: 'db', label: 'Gasóleo B', shortLabel: 'Gasóleo B' },
  { key: 'gnc', label: 'Gas Natural Comprimido (GNC)', shortLabel: 'GNC' },
  { key: 'gnl', label: 'Gas Natural Licuado (GNL)', shortLabel: 'GNL' },
  { key: 'bio', label: 'Biodiésel', shortLabel: 'Biodiésel' },
  { key: 'et', label: 'Bioetanol', shortLabel: 'Bioetanol' },
  { key: 'h2', label: 'Hidrógeno', shortLabel: 'H₂' },
  { key: 'adb', label: 'AdBlue', shortLabel: 'AdBlue' },
];

export const PROVINCES: Province[] = [
  { id: '01', name: 'Álava / Araba', ccaa: 'País Vasco', lat: 42.8467, lng: -2.6716, zoom: 10.5 },
  { id: '02', name: 'Albacete', ccaa: 'Castilla-La Mancha', lat: 38.9943, lng: -1.8585, zoom: 9.5 },
  { id: '03', name: 'Alicante / Alacant', ccaa: 'Comunidad Valenciana', lat: 38.3452, lng: -0.481, zoom: 10 },
  { id: '04', name: 'Almería', ccaa: 'Andalucía', lat: 36.834, lng: -2.4637, zoom: 9.8 },
  { id: '33', name: 'Asturias', ccaa: 'Asturias', lat: 43.3614, lng: -5.8593, zoom: 9.8 },
  { id: '05', name: 'Ávila', ccaa: 'Castilla y León', lat: 40.6567, lng: -4.6812, zoom: 9.8 },
  { id: '06', name: 'Badajoz', ccaa: 'Extremadura', lat: 38.8794, lng: -6.9707, zoom: 9.2 },
  { id: '07', name: 'Illes Balears', ccaa: 'Baleares', lat: 39.5696, lng: 2.6502, zoom: 9.8 },
  { id: '08', name: 'Barcelona', ccaa: 'Cataluña', lat: 41.3874, lng: 2.1686, zoom: 10.5 },
  { id: '48', name: 'Bizkaia', ccaa: 'País Vasco', lat: 43.263, lng: -2.935, zoom: 10.6 },
  { id: '09', name: 'Burgos', ccaa: 'Castilla y León', lat: 42.3439, lng: -3.6969, zoom: 9.5 },
  { id: '10', name: 'Cáceres', ccaa: 'Extremadura', lat: 39.4753, lng: -6.3724, zoom: 9.4 },
  { id: '11', name: 'Cádiz', ccaa: 'Andalucía', lat: 36.5271, lng: -6.2886, zoom: 10 },
  { id: '39', name: 'Cantabria', ccaa: 'Cantabria', lat: 43.4623, lng: -3.8099, zoom: 10.2 },
  { id: '12', name: 'Castellón / Castelló', ccaa: 'Comunidad Valenciana', lat: 39.9864, lng: -0.0513, zoom: 10 },
  { id: '51', name: 'Ceuta', ccaa: 'Ceuta', lat: 35.8894, lng: -5.3213, zoom: 13 },
  { id: '13', name: 'Ciudad Real', ccaa: 'Castilla-La Mancha', lat: 38.9848, lng: -3.9274, zoom: 9.5 },
  { id: '14', name: 'Córdoba', ccaa: 'Andalucía', lat: 37.8882, lng: -4.7794, zoom: 9.8 },
  { id: '15', name: 'A Coruña', ccaa: 'Galicia', lat: 43.3623, lng: -8.4115, zoom: 9.8 },
  { id: '16', name: 'Cuenca', ccaa: 'Castilla-La Mancha', lat: 40.0704, lng: -2.1374, zoom: 9.5 },
  { id: '20', name: 'Gipuzkoa', ccaa: 'País Vasco', lat: 43.3183, lng: -1.9812, zoom: 10.8 },
  { id: '17', name: 'Girona', ccaa: 'Cataluña', lat: 41.9794, lng: 2.8214, zoom: 10 },
  { id: '18', name: 'Granada', ccaa: 'Andalucía', lat: 37.1773, lng: -3.5986, zoom: 9.8 },
  { id: '19', name: 'Guadalajara', ccaa: 'Castilla-La Mancha', lat: 40.6332, lng: -3.1674, zoom: 9.8 },
  { id: '21', name: 'Huelva', ccaa: 'Andalucía', lat: 37.2614, lng: -6.9447, zoom: 9.8 },
  { id: '22', name: 'Huesca', ccaa: 'Aragón', lat: 42.1362, lng: -0.4087, zoom: 9.5 },
  { id: '23', name: 'Jaén', ccaa: 'Andalucía', lat: 37.7796, lng: -3.7849, zoom: 9.8 },
  { id: '24', name: 'León', ccaa: 'Castilla y León', lat: 42.5987, lng: -5.5671, zoom: 9.5 },
  { id: '25', name: 'Lleida', ccaa: 'Cataluña', lat: 41.6176, lng: 0.62, zoom: 9.6 },
  { id: '27', name: 'Lugo', ccaa: 'Galicia', lat: 43.0097, lng: -7.5568, zoom: 9.8 },
  { id: '28', name: 'Madrid', ccaa: 'Madrid', lat: 40.4168, lng: -3.7038, zoom: 10.6 },
  { id: '29', name: 'Málaga', ccaa: 'Andalucía', lat: 36.7213, lng: -4.4214, zoom: 10.2 },
  { id: '52', name: 'Melilla', ccaa: 'Melilla', lat: 35.2923, lng: -2.9381, zoom: 13.2 },
  { id: '30', name: 'Murcia', ccaa: 'Región de Murcia', lat: 37.9922, lng: -1.1307, zoom: 10 },
  { id: '31', name: 'Navarra', ccaa: 'Navarra', lat: 42.8125, lng: -1.6458, zoom: 9.8 },
  { id: '32', name: 'Ourense', ccaa: 'Galicia', lat: 42.3358, lng: -7.8639, zoom: 9.8 },
  { id: '34', name: 'Palencia', ccaa: 'Castilla y León', lat: 42.0095, lng: -4.5288, zoom: 9.8 },
  { id: '35', name: 'Las Palmas', ccaa: 'Canarias', lat: 28.1235, lng: -15.4363, zoom: 9.8 },
  { id: '36', name: 'Pontevedra', ccaa: 'Galicia', lat: 42.431, lng: -8.6444, zoom: 10.2 },
  { id: '26', name: 'La Rioja', ccaa: 'La Rioja', lat: 42.4627, lng: -2.445, zoom: 10.2 },
  { id: '37', name: 'Salamanca', ccaa: 'Castilla y León', lat: 40.9701, lng: -5.6635, zoom: 9.6 },
  { id: '38', name: 'Santa Cruz de Tenerife', ccaa: 'Canarias', lat: 28.4636, lng: -16.2518, zoom: 9.8 },
  { id: '40', name: 'Segovia', ccaa: 'Castilla y León', lat: 40.9429, lng: -4.1088, zoom: 10 },
  { id: '41', name: 'Sevilla', ccaa: 'Andalucía', lat: 37.3891, lng: -5.9845, zoom: 10.2 },
  { id: '42', name: 'Soria', ccaa: 'Castilla y León', lat: 41.7666, lng: -2.479, zoom: 9.8 },
  { id: '43', name: 'Tarragona', ccaa: 'Cataluña', lat: 41.1189, lng: 1.2445, zoom: 10 },
  { id: '44', name: 'Teruel', ccaa: 'Aragón', lat: 40.3456, lng: -1.1065, zoom: 9.5 },
  { id: '45', name: 'Toledo', ccaa: 'Castilla-La Mancha', lat: 39.8628, lng: -4.0273, zoom: 9.6 },
  { id: '46', name: 'Valencia / València', ccaa: 'Comunidad Valenciana', lat: 39.4699, lng: -0.3763, zoom: 10.2 },
  { id: '47', name: 'Valladolid', ccaa: 'Castilla y León', lat: 41.6523, lng: -4.7245, zoom: 9.8 },
  { id: '49', name: 'Zamora', ccaa: 'Castilla y León', lat: 41.5035, lng: -5.7468, zoom: 9.8 },
  { id: '50', name: 'Zaragoza', ccaa: 'Aragón', lat: 41.6488, lng: -0.8891, zoom: 9.5 },
];

export function getProvinceById(id: string | null | undefined): Province | undefined {
  if (!id) return undefined;
  const normalized = id.trim().padStart(2, '0');
  return PROVINCES.find((p) => p.id === normalized);
}

export function formatPrice(price: number, decimals = 3): string {
  return `${price.toFixed(decimals).replace('.', ',')} €`;
}

export function formatShortPrice(price: number): string {
  return `${price.toFixed(2).replace('.', ',')} €`;
}

export function formatDistance(km: number): string {
  if (km < 1) {
    return `${Math.round(km * 1000)} m`;
  }
  return `${km.toFixed(1).replace('.', ',')} km`;
}
