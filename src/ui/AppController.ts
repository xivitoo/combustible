import {
  ALL_FUEL_META,
  PRIMARY_FUELS,
  PROVINCES,
  formatDistance,
  formatPrice,
  getProvinceById,
} from '../data/provinces';
import { CanvasMap } from '../map/CanvasMap';
import { initPWA, type PWAState } from '../pwa';
import {
  QUICK_FAVORITE_TAGS,
  getFavorite,
  getFavorites,
  removeFavorite,
  saveFavorite,
  syncFavoritesWithStations,
} from '../services/favorites';
import {
  filterStationsByFuel,
  findStationByIdGlobally,
  loadProvinceStations,
  loadStaticBackupProvince,
} from '../services/fuelData';
import {
  estimateDriveMinutes,
  findNearestProvince,
  haversineKm,
  isGeolocationGranted,
  requestCurrentPosition,
  type GeoCoords,
} from '../services/geo';
import type {
  DataMode,
  FavoriteEntry,
  PrimaryFuelKey,
  Province,
  SheetSnap,
  SortMode,
  Station,
  TabId,
} from '../types';
import { BRAND_LOGO_SVG, iconSvg } from './icons';

const STORAGE_PROVINCE_KEY = 'combustible_province_id_v1';
const STORAGE_THEME_KEY = 'combustible_theme_v1';
const STORAGE_FUEL_KEY = 'combustible_fuel_v1';

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export class AppController {
  private root: HTMLElement;
  private map: CanvasMap | null = null;

  private isDark = false;
  private activeProvince: Province | null = null;
  private showProvinceGate = false;
  private provinceSearchQuery = '';

  private activeFuel: PrimaryFuelKey = 'g95';
  private allStations: Station[] = [];
  private fuelStations: Station[] = [];
  private dataMode: DataMode = 'loading';
  private ageMinutes: number | null = null;

  private activeTab: TabId = 'explore';
  private sortMode: SortMode = 'cheapest-near';
  private searchQuery = '';
  private sheetSnap: SheetSnap = 'mid';
  private selectedStation: Station | null = null;

  private userLocation: GeoCoords | null = null;
  private gpsLoading = false;

  private favorites: FavoriteEntry[] = [];
  private customTagDraft = '';
  private linkCopiedId: string | null = null;

  private pwaState: PWAState = { canInstall: false, isInstalled: false, isIOS: false };
  private pwaPromptFn: (() => Promise<boolean>) | null = null;
  private showIOSGuide = false;

  private p30 = 0;
  private p75 = 0;

  private mapCanvasEl: HTMLCanvasElement | null = null;
  private topControlsEl: HTMLElement | null = null;
  private sheetEl: HTMLElement | null = null;
  private sheetBodyEl: HTMLElement | null = null;
  private sheetHeaderTitleEl: HTMLElement | null = null;
  private sheetHeaderMetaEl: HTMLElement | null = null;
  private provinceModalEl: HTMLElement | null = null;
  private iosModalEl: HTMLElement | null = null;
  private bootOverlayEl: HTMLElement | null = null;
  private isBootstrapping = false;

  private sheetDragStartY = 0;
  private sheetDragCurrentDelta = 0;
  private isDraggingSheet = false;
  private skipNextHandleClick = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.initTheme();
    this.initFuel();
    this.favorites = getFavorites();
  }

  public async mount(): Promise<void> {
    const params = new URLSearchParams(window.location.search);
    const deepStationId = params.get('estacion')?.trim() || '';

    const savedProvinceId = localStorage.getItem(STORAGE_PROVINCE_KEY);
    const savedProvince = getProvinceById(savedProvinceId);

    if (savedProvince || deepStationId) {
      this.activeProvince = savedProvince || null;
      this.isBootstrapping = true;
    }

    this.renderShell();
    this.bindShellEvents();

    const pwa = initPWA((state) => {
      this.pwaState = state;
      this.renderTopControls();
    });
    this.pwaPromptFn = pwa.promptInstall;

    if (this.mapCanvasEl) {
      this.map = new CanvasMap({
        canvas: this.mapCanvasEl,
        onSelectStation: (station) => this.selectStation(station, true),
        onMapInteract: () => this.handleMapInteract(),
      });
      this.map.setTheme(this.isDark);
    }

    // Comprobar geolocalización en segundo plano sin bloquear la carga inicial
    this.initGrantedGpsInBackground(Boolean(deepStationId));

    if (deepStationId) {
      await this.handleDeepLinkStation(deepStationId, savedProvince);
      this.isBootstrapping = false;
      this.renderBootOverlay();
      return;
    }

    if (savedProvince) {
      this.activeProvince = savedProvince;
      this.showProvinceGate = false;
      this.renderProvinceGate();
      this.map?.setView(savedProvince.lat, savedProvince.lng, savedProvince.zoom, false);
      await this.loadActiveProvince();
      this.isBootstrapping = false;
      this.renderBootOverlay();
    } else {
      this.isBootstrapping = false;
      this.renderBootOverlay();
      this.showProvinceGate = true;
      this.renderProvinceGate();
      this.map?.setView(40.2, -3.7, 6.2, false);
    }

    window.addEventListener('online', () => {
      if (this.activeProvince) {
        this.loadActiveProvince();
      }
    });
    window.addEventListener('offline', () => {
      if (this.activeProvince) {
        this.loadActiveProvince();
      }
    });
  }

  private async initGrantedGpsInBackground(isDeepLink: boolean): Promise<void> {
    const gpsGranted = await isGeolocationGranted();
    if (!gpsGranted) return;
    try {
      const coords = await requestCurrentPosition(5000);
      this.userLocation = coords;
      this.map?.setUserLocation(coords);
      if (!isDeepLink && !this.selectedStation && this.activeProvince) {
        this.map?.setView(coords.lat, coords.lng, 12.4, true);
      }
      if (!this.isBootstrapping && !this.selectedStation) {
        this.renderSheetContent();
      }
    } catch {
      // Continuar sin GPS
    }
  }

  private async handleDeepLinkStation(
    stationId: string,
    fallbackProvince?: Province
  ): Promise<void> {
    if (fallbackProvince) {
      this.activeProvince = fallbackProvince;
      this.showProvinceGate = false;
      this.renderProvinceGate();
      await this.loadActiveProvince();
      const foundInProv = this.allStations.find((s) => s.id === stationId);
      if (foundInProv) {
        this.focusAndSelectStation(foundInProv);
        return;
      }
    }

    const foundGlobal = await findStationByIdGlobally(stationId);
    if (foundGlobal) {
      const targetProv = getProvinceById(foundGlobal.provinceId) || fallbackProvince || PROVINCES[29];
      this.selectProvince(targetProv, false);
      await this.loadActiveProvince();
      const liveMatch = this.allStations.find((s) => s.id === stationId) || foundGlobal;
      this.focusAndSelectStation(liveMatch);
      return;
    }

    if (!fallbackProvince) {
      this.showProvinceGate = true;
      this.renderProvinceGate();
    }
  }

  private focusAndSelectStation(station: Station): void {
    if (!station.prices[this.activeFuel]) {
      const available = PRIMARY_FUELS.find((f) => typeof station.prices[f.key] === 'number');
      if (available) {
        this.activeFuel = available.key;
        this.recomputeFuelStations();
        this.renderTopControls();
      }
    }
    this.selectStation(station, true);
    this.map?.setView(station.lat, station.lng, 14.2, true);
  }

  private initTheme(): void {
    const saved = localStorage.getItem(STORAGE_THEME_KEY);
    if (saved === 'dark') {
      this.isDark = true;
    } else if (saved === 'light') {
      this.isDark = false;
    } else {
      this.isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    document.documentElement.classList.toggle('dark', this.isDark);
  }

  private toggleTheme(): void {
    this.isDark = !this.isDark;
    localStorage.setItem(STORAGE_THEME_KEY, this.isDark ? 'dark' : 'light');
    document.documentElement.classList.toggle('dark', this.isDark);
    this.map?.setTheme(this.isDark);
    this.renderTopControls();
  }

  private initFuel(): void {
    const saved = localStorage.getItem(STORAGE_FUEL_KEY) as PrimaryFuelKey | null;
    if (saved && PRIMARY_FUELS.some((f) => f.key === saved)) {
      this.activeFuel = saved;
    }
  }

  private setFuel(fuel: PrimaryFuelKey): void {
    if (this.activeFuel === fuel) return;
    this.activeFuel = fuel;
    localStorage.setItem(STORAGE_FUEL_KEY, fuel);
    this.recomputeFuelStations();
    this.renderTopControls();
    this.renderSheetContent();
  }

  private selectProvince(province: Province, shouldLoad = true): void {
    this.activeProvince = province;
    localStorage.setItem(STORAGE_PROVINCE_KEY, province.id);
    this.showProvinceGate = false;
    this.selectedStation = null;
    this.searchQuery = '';
    this.renderProvinceGate();
    this.renderTopControls();
    this.renderTabBars();

    if (
      this.userLocation &&
      findNearestProvince(this.userLocation.lat, this.userLocation.lng).id === province.id
    ) {
      this.map?.setView(this.userLocation.lat, this.userLocation.lng, 12.2, true);
    } else {
      this.map?.setView(province.lat, province.lng, province.zoom, true);
    }

    if (shouldLoad) {
      this.loadActiveProvince();
    }
  }

  private async loadActiveProvince(): Promise<void> {
    if (!this.activeProvince) return;
    this.dataMode = 'loading';
    this.renderTopControls();
    this.renderSheetContent();

    const result = await loadProvinceStations(this.activeProvince.id);
    this.dataMode = result.mode;
    this.ageMinutes = result.ageMinutes;
    this.allStations = result.stations;

    if (result.mode === 'online' || result.mode === 'offline-cache') {
      this.favorites = syncFavoritesWithStations(
        this.allStations,
        result.mode === 'online' ? 'online' : 'offline'
      );
    }

    this.recomputeFuelStations();
    this.renderTopControls();
    this.renderSheetContent();
  }

  private async loadStaticBackup(): Promise<void> {
    if (!this.activeProvince) return;
    this.dataMode = 'loading';
    this.renderTopControls();
    this.renderSheetContent();

    try {
      const result = await loadStaticBackupProvince(this.activeProvince.id);
      this.dataMode = result.mode;
      this.ageMinutes = null;
      this.allStations = result.stations;
      this.favorites = syncFavoritesWithStations(this.allStations, 'offline');
      this.recomputeFuelStations();
    } catch {
      this.dataMode = 'offline-empty';
    }

    this.renderTopControls();
    this.renderSheetContent();
  }

  private recomputeFuelStations(): void {
    this.fuelStations = filterStationsByFuel(this.allStations, this.activeFuel);

    const prices = this.fuelStations
      .map((s) => s.prices[this.activeFuel])
      .sort((a, b) => a - b);
    if (prices.length > 0) {
      this.p30 = prices[Math.floor((prices.length - 1) * 0.28)];
      this.p75 = prices[Math.floor((prices.length - 1) * 0.78)];
    } else {
      this.p30 = this.p75 = 0;
    }

    const favIds = new Set(this.favorites.map((f) => f.id));
    this.map?.setData(
      this.fuelStations,
      this.activeFuel,
      this.selectedStation?.id || null,
      favIds
    );
  }

  private async triggerLocateUser(detectProvinceToo = false): Promise<void> {
    if (this.gpsLoading) return;
    this.gpsLoading = true;
    this.renderTopControls();
    if (this.showProvinceGate) {
      this.updateProvinceGpsButton();
    }

    try {
      const coords = await requestCurrentPosition(9000);
      this.userLocation = coords;
      this.map?.setUserLocation(coords);

      if (detectProvinceToo || !this.activeProvince) {
        const nearest = findNearestProvince(coords.lat, coords.lng);
        this.selectProvince(nearest, true);
        this.map?.setView(coords.lat, coords.lng, 12.8, true);
      } else {
        this.map?.setView(coords.lat, coords.lng, 13.2, true);
        this.renderSheetContent();
      }
    } catch {
      // Silencioso si el usuario deniega GPS
    } finally {
      this.gpsLoading = false;
      this.renderTopControls();
      if (this.showProvinceGate) {
        this.updateProvinceGpsButton();
      }
    }
  }

  private handleMapInteract(): void {
    if (window.innerWidth < 1024 && this.sheetSnap !== 'min') {
      this.setSheetSnap('min');
    }
  }

  private selectStation(station: Station, expandSheet = false): void {
    this.selectedStation = station;
    this.customTagDraft = getFavorite(station.id)?.tag || '';
    this.linkCopiedId = null;
    this.map?.setSelectedStation(station.id);

    if (expandSheet && window.innerWidth < 1024 && this.sheetSnap === 'min') {
      this.setSheetSnap('mid');
    }
    this.renderTabBars();
    this.renderSheetContent();
  }

  private setSheetSnap(snap: SheetSnap): void {
    this.sheetSnap = snap;
    this.applySheetTransform();
  }

  private applySheetTransform(): void {
    if (!this.sheetEl) return;
    if (window.innerWidth >= 1024) {
      this.sheetEl.style.transform = '';
      return;
    }
    const map: Record<SheetSnap, string> = {
      min: 'translateY(calc(100% - 76px))',
      mid: 'translateY(42%)',
      full: 'translateY(0%)',
    };
    this.sheetEl.style.transform = map[this.sheetSnap];
  }

  private renderShell(): void {
    this.root.innerHTML = `
      <div class="relative h-[100dvh] w-full overflow-hidden bg-slate-100 dark:bg-[#1e2432] lg:flex">
        <!-- Panel lateral en Desktop / Hoja inferior en Móvil -->
        <aside
          id="sheet-container"
          class="sheet-transition fixed inset-x-0 bottom-[64px] z-30 flex h-[calc(100dvh-204px)] flex-col rounded-t-3xl border-t border-slate-200/80 bg-white/95 shadow-2xl backdrop-blur-xl dark:border-[#343e52] dark:bg-[#242c3c]/95 lg:static lg:inset-auto lg:h-full lg:w-[410px] lg:shrink-0 lg:rounded-none lg:border-t-0 lg:border-r lg:shadow-none"
          style="transform: translateY(42%);"
        >
          <!-- Tirador móvil -->
          <div id="sheet-drag-handle" class="flex cursor-grab select-none flex-col items-center pt-2.5 pb-2 active:cursor-grabbing lg:hidden">
            <div class="h-1.5 w-11 rounded-full bg-slate-300 dark:bg-[#49556d]"></div>
            <div class="mt-2 flex w-full items-center justify-between px-5">
              <span id="sheet-header-title" class="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">Explorar estaciones</span>
              <span id="sheet-header-meta" class="text-xs text-slate-500 dark:text-slate-300 tabular-nums shrink-0"></span>
            </div>
          </div>

          <!-- Cabecera Desktop: solo el logo, sin títulos ni descripciones -->
          <div class="hidden lg:flex items-center border-b border-slate-200/80 px-5 py-3.5 dark:border-[#343e52]">
            <a href="./" aria-label="Combustible by XivIoT" class="inline-flex items-center">
              ${BRAND_LOGO_SVG}
            </a>
          </div>

          <!-- Contenido scrollable con scroll nativo -->
          <div id="sheet-body" class="native-scroll flex-1 overflow-y-auto px-4 pb-6 pt-1 lg:px-5 lg:pt-4"></div>

          <!-- Barra inferior de 3 pestañas en Desktop -->
          <nav
            id="tab-bar-desktop"
            aria-label="Navegación principal"
            class="hidden lg:grid grid-cols-3 border-t border-slate-200/80 bg-white/95 dark:border-[#343e52] dark:bg-[#242c3c]/95"
          ></nav>
        </aside>

        <!-- Área principal del mapa Canvas 2D (sin logo encima del mapa) -->
        <main class="relative h-full w-full flex-1 overflow-hidden">
          <canvas id="fuel-map-canvas" class="map-canvas block h-full w-full"></canvas>

          <!-- Controles flotantes superiores sobre el mapa -->
          <div
            id="top-controls"
            class="pointer-events-none absolute inset-x-0 top-0 z-20 pt-safe"
          ></div>

          <!-- Controles accesibles de zoom (+/-) en el mapa -->
          <div class="pointer-events-auto absolute right-3 top-[154px] z-20 flex flex-col gap-1.5 lg:top-auto lg:bottom-6 lg:right-5">
            <button
              type="button"
              id="map-zoom-in"
              aria-label="Acercar mapa"
              class="flex h-11 w-11 items-center justify-center rounded-xl bg-white/92 text-lg font-bold text-slate-800 shadow-md ring-1 ring-slate-900/10 backdrop-blur-md transition hover:bg-white active:scale-95 dark:bg-[#242c3c]/92 dark:text-slate-100 dark:ring-white/10 dark:hover:bg-[#2e384d]"
            >+</button>
            <button
              type="button"
              id="map-zoom-out"
              aria-label="Alejar mapa"
              class="flex h-11 w-11 items-center justify-center rounded-xl bg-white/92 text-lg font-bold text-slate-800 shadow-md ring-1 ring-slate-900/10 backdrop-blur-md transition hover:bg-white active:scale-95 dark:bg-[#242c3c]/92 dark:text-slate-100 dark:ring-white/10 dark:hover:bg-[#2e384d]"
            >−</button>
          </div>
        </main>

        <!-- Barra inferior fija móvil (3 pestañas nativas) -->
        <nav
          id="tab-bar-mobile"
          aria-label="Navegación principal"
          class="pb-safe fixed inset-x-0 bottom-0 z-40 grid h-[calc(64px+env(safe-area-inset-bottom,0px))] grid-cols-3 items-center border-t border-slate-200/90 bg-white/95 backdrop-blur-xl dark:border-[#343e52] dark:bg-[#242c3c]/95 lg:hidden"
        ></nav>

        <!-- Selector de provincia -->
        <div id="province-gate" class="hidden"></div>

        <!-- Guía de instalación iOS Safari -->
        <div id="ios-install-modal" class="hidden"></div>

        <!-- Pantalla de carga inicial al recuperar provincia guardada -->
        <div id="boot-loading-overlay" class="hidden"></div>
      </div>
    `;

    this.mapCanvasEl = this.root.querySelector('#fuel-map-canvas');
    this.topControlsEl = this.root.querySelector('#top-controls');
    this.sheetEl = this.root.querySelector('#sheet-container');
    this.sheetBodyEl = this.root.querySelector('#sheet-body');
    this.sheetHeaderTitleEl = this.root.querySelector('#sheet-header-title');
    this.sheetHeaderMetaEl = this.root.querySelector('#sheet-header-meta');
    this.provinceModalEl = this.root.querySelector('#province-gate');
    this.iosModalEl = this.root.querySelector('#ios-install-modal');
    this.bootOverlayEl = this.root.querySelector('#boot-loading-overlay');

    this.applySheetTransform();
    this.renderBootOverlay();
    this.renderTopControls();
    this.renderTabBars();
    this.renderSheetContent();
  }

  private renderBootOverlay(): void {
    if (!this.bootOverlayEl) return;
    if (!this.isBootstrapping) {
      this.bootOverlayEl.className = 'hidden';
      this.bootOverlayEl.innerHTML = '';
      return;
    }

    const subtitle = this.activeProvince
      ? `Cargando ${escapeHtml(this.activeProvince.name)}…`
      : 'Cargando estación…';

    this.bootOverlayEl.className =
      'fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-slate-50/96 backdrop-blur-md dark:bg-[#1e2432]/96';
    this.bootOverlayEl.innerHTML = `
      <div class="flex h-16 w-16 items-center justify-center rounded-2xl shadow-lg">
        ${BRAND_LOGO_SVG.replace('class="h-8 w-8"', 'class="h-14 w-14"')}
      </div>
      <div class="flex items-center gap-2.5 text-sm font-semibold text-slate-700 dark:text-slate-200">
        <span class="h-4 w-4 animate-spin rounded-full border-2 border-emerald-600 border-t-transparent dark:border-emerald-300 dark:border-t-transparent"></span>
        <span>${subtitle}</span>
      </div>
    `;
  }

  private bindShellEvents(): void {
    this.root.querySelector('#map-zoom-in')?.addEventListener('click', () => {
      this.map?.zoomIn();
    });
    this.root.querySelector('#map-zoom-out')?.addEventListener('click', () => {
      this.map?.zoomOut();
    });

    const handle = this.root.querySelector('#sheet-drag-handle') as HTMLElement | null;
    if (handle && this.sheetEl) {
      let movedDuringTouch = false;

      handle.addEventListener(
        'touchstart',
        (e) => {
          if (window.innerWidth >= 1024) return;
          this.isDraggingSheet = true;
          movedDuringTouch = false;
          this.sheetDragStartY = e.touches[0].clientY;
          this.sheetDragCurrentDelta = 0;
          this.sheetEl?.classList.remove('sheet-transition');
        },
        { passive: true }
      );

      handle.addEventListener(
        'touchmove',
        (e) => {
          if (!this.isDraggingSheet || !this.sheetEl) return;
          const dy = e.touches[0].clientY - this.sheetDragStartY;
          if (Math.abs(dy) > 6) movedDuringTouch = true;
          this.sheetDragCurrentDelta = dy;

          const sheetH = this.sheetEl.getBoundingClientRect().height || window.innerHeight * 0.72;
          const basePx =
            this.sheetSnap === 'min'
              ? sheetH - 76
              : this.sheetSnap === 'mid'
                ? sheetH * 0.42
                : 0;
          const clampedPx = Math.max(0, Math.min(sheetH - 76, basePx + dy));
          this.sheetEl.style.transform = `translateY(${clampedPx}px)`;
        },
        { passive: true }
      );

      handle.addEventListener('touchend', () => {
        if (!this.isDraggingSheet || !this.sheetEl) return;
        this.isDraggingSheet = false;
        this.sheetEl.classList.add('sheet-transition');

        if (!movedDuringTouch) {
          this.skipNextHandleClick = true;
          setTimeout(() => {
            this.skipNextHandleClick = false;
          }, 350);
          const order: SheetSnap[] = ['min', 'mid', 'full'];
          const next = order[(order.indexOf(this.sheetSnap) + 1) % order.length];
          this.setSheetSnap(next);
          return;
        }

        const sheetH = this.sheetEl.getBoundingClientRect().height || window.innerHeight * 0.72;
        const basePx =
          this.sheetSnap === 'min'
            ? sheetH - 76
            : this.sheetSnap === 'mid'
              ? sheetH * 0.42
              : 0;
        const finalPx = basePx + this.sheetDragCurrentDelta;
        const ratio = finalPx / sheetH;

        if (ratio > 0.64) {
          this.setSheetSnap('min');
        } else if (ratio > 0.21) {
          this.setSheetSnap('mid');
        } else {
          this.setSheetSnap('full');
        }
      });

      handle.addEventListener('click', () => {
        if (window.innerWidth >= 1024 || this.skipNextHandleClick) return;
        const order: SheetSnap[] = ['min', 'mid', 'full'];
        const next = order[(order.indexOf(this.sheetSnap) + 1) % order.length];
        this.setSheetSnap(next);
      });
    }

    window.addEventListener('resize', () => {
      this.applySheetTransform();
    });
  }

  private renderTopControls(): void {
    if (!this.topControlsEl) return;

    const provLabel = this.activeProvince ? this.activeProvince.name : 'Elegir provincia';
    const showInstallBtn =
      !this.pwaState.isInstalled && (this.pwaState.canInstall || this.pwaState.isIOS);

    const statusText = this.getStatusLineText();

    this.topControlsEl.innerHTML = `
      <div class="mx-auto flex w-full max-w-4xl flex-col gap-2 px-3 pt-3 sm:px-4">
        <!-- Fila 1: Selector de provincia y acciones rápidas (sin logo sobre el mapa) -->
        <div class="flex items-center justify-between gap-2">
          <button
            type="button"
            data-action="open-province"
            class="pointer-events-auto flex min-h-[44px] max-w-[190px] items-center gap-1.5 rounded-xl bg-white/92 px-3.5 text-xs font-semibold text-slate-900 shadow-md ring-1 ring-slate-900/5 backdrop-blur-md transition hover:bg-white active:scale-[0.98] dark:bg-[#242c3c]/92 dark:text-slate-100 dark:ring-white/10 dark:hover:bg-[#2e384d] dark:active:bg-[#354057] sm:max-w-[240px] sm:text-sm"
          >
            <span class="truncate">${escapeHtml(provLabel)}</span>
            ${iconSvg('chevron-down', 'h-4 w-4 shrink-0 text-slate-500 dark:text-slate-300')}
          </button>

          <div class="pointer-events-auto flex items-center gap-1.5 sm:gap-2">
            <button
              type="button"
              data-action="locate"
              aria-label="Centrar en mi ubicación GPS"
              class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl shadow-md ring-1 backdrop-blur-md transition active:scale-95 ${
                this.userLocation
                  ? 'bg-emerald-600 text-white ring-emerald-500/40 hover:bg-emerald-700 dark:bg-emerald-300 dark:text-slate-900 dark:hover:bg-emerald-200'
                  : 'bg-white/92 text-slate-700 ring-slate-900/5 hover:bg-white dark:bg-[#242c3c]/92 dark:text-slate-200 dark:ring-white/10 dark:hover:bg-[#2e384d]'
              }"
            >
              ${iconSvg('locate', `h-5 w-5 ${this.gpsLoading ? 'animate-spin' : ''}`)}
            </button>

            <button
              type="button"
              data-action="toggle-theme"
              aria-label="Cambiar modo claro u oscuro"
              class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/92 text-slate-700 shadow-md ring-1 ring-slate-900/5 backdrop-blur-md transition hover:bg-white active:scale-95 dark:bg-[#242c3c]/92 dark:text-amber-200 dark:ring-white/10 dark:hover:bg-[#2e384d]"
            >
              ${iconSvg(this.isDark ? 'sun' : 'moon', 'h-5 w-5')}
            </button>

            ${
              showInstallBtn
                ? `<button
                    type="button"
                    data-action="install-pwa"
                    class="flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-xl bg-emerald-700 px-3 text-xs font-semibold text-white shadow-md transition hover:bg-emerald-800 active:scale-95 whitespace-nowrap dark:bg-emerald-300 dark:text-slate-900 dark:hover:bg-emerald-200"
                  >
                    ${iconSvg('download', 'h-4 w-4')}
                    <span class="hidden sm:inline">Instalar</span>
                  </button>`
                : ''
            }
          </div>
        </div>

        <!-- Selector rápido de carburante en 1 toque -->
        <div
          role="tablist"
          aria-label="Tipo de combustible"
          class="pointer-events-auto grid grid-cols-4 gap-1 rounded-2xl bg-white/92 p-1 shadow-md ring-1 ring-slate-900/5 backdrop-blur-md dark:bg-[#242c3c]/92 dark:ring-white/10"
        >
          ${PRIMARY_FUELS.map((f) => {
            const active = f.key === this.activeFuel;
            return `
              <button
                type="button"
                role="tab"
                aria-selected="${active ? 'true' : 'false'}"
                data-fuel="${f.key}"
                class="min-h-[44px] rounded-xl px-1.5 text-center text-xs font-semibold transition whitespace-nowrap sm:text-sm ${
                  active
                    ? 'bg-emerald-700 text-white shadow-sm dark:bg-emerald-300 dark:text-slate-900'
                    : 'text-slate-700 hover:bg-slate-100/80 dark:text-slate-200 dark:hover:bg-[#313b4f]'
                }"
              >
                ${f.label}
              </button>
            `;
          }).join('')}
        </div>

        <!-- Estado Online / Offline (sin mencionar API) -->
        ${
          statusText
            ? `<div class="pointer-events-auto flex items-center justify-between gap-2 self-start rounded-xl bg-white/92 px-3 py-1.5 text-xs font-medium shadow-sm ring-1 ring-slate-900/5 backdrop-blur-md dark:bg-[#242c3c]/92 dark:ring-white/10">
                <span class="${
                  this.dataMode === 'online'
                    ? 'text-emerald-700 dark:text-emerald-300'
                    : this.dataMode === 'loading'
                      ? 'text-slate-600 dark:text-slate-300'
                      : 'text-amber-700 dark:text-amber-200'
                }">${statusText}</span>
                ${
                  this.dataMode === 'offline-empty' || this.dataMode === 'offline-cache'
                    ? `<button type="button" data-action="retry-online" class="min-h-[28px] px-1 font-semibold text-emerald-700 underline underline-offset-2 dark:text-emerald-300 whitespace-nowrap">Reintentar</button>`
                    : ''
                }
                ${
                  this.dataMode === 'offline-empty'
                    ? `<button type="button" data-action="load-backup" class="min-h-[28px] px-1 font-semibold text-slate-800 underline underline-offset-2 dark:text-sky-200 whitespace-nowrap">Ver respaldo Offline</button>`
                    : ''
                }
              </div>`
            : ''
        }
      </div>
    `;

    this.topControlsEl
      .querySelector('[data-action="open-province"]')
      ?.addEventListener('click', () => {
        this.showProvinceGate = true;
        this.provinceSearchQuery = '';
        this.renderProvinceGate();
      });

    this.topControlsEl
      .querySelector('[data-action="locate"]')
      ?.addEventListener('click', () => this.triggerLocateUser(false));

    this.topControlsEl
      .querySelector('[data-action="toggle-theme"]')
      ?.addEventListener('click', () => this.toggleTheme());

    this.topControlsEl
      .querySelector('[data-action="install-pwa"]')
      ?.addEventListener('click', () => this.handleInstallClick());

    this.topControlsEl
      .querySelector('[data-action="retry-online"]')
      ?.addEventListener('click', () => this.loadActiveProvince());

    this.topControlsEl
      .querySelector('[data-action="load-backup"]')
      ?.addEventListener('click', () => this.loadStaticBackup());

    this.topControlsEl.querySelectorAll('[data-fuel]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-fuel') as PrimaryFuelKey | null;
        if (key) this.setFuel(key);
      });
    });
  }

  private getStatusLineText(): string {
    if (!this.activeProvince) return '';
    if (this.dataMode === 'loading') return 'Cargando precios Online…';
    if (this.dataMode === 'online') {
      return `Online · ${this.fuelStations.length} estaciones`;
    }
    if (this.dataMode === 'offline-cache') {
      const mins = this.ageMinutes ?? 1;
      return `Offline · Últimos precios (hace ${mins} min)`;
    }
    if (this.dataMode === 'offline-backup') {
      return `Offline · Respaldo guardado (${this.fuelStations.length} estaciones)`;
    }
    return 'Offline · No estás conectado';
  }

  private async handleInstallClick(): Promise<void> {
    if (this.pwaState.canInstall && this.pwaPromptFn) {
      await this.pwaPromptFn();
      return;
    }
    if (this.pwaState.isIOS) {
      this.showIOSGuide = true;
      this.renderIOSGuide();
    }
  }

  private renderIOSGuide(): void {
    if (!this.iosModalEl) return;
    if (!this.showIOSGuide) {
      this.iosModalEl.className = 'hidden';
      this.iosModalEl.innerHTML = '';
      return;
    }
    this.iosModalEl.className =
      'fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm';
    this.iosModalEl.innerHTML = `
      <div class="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-[#343e52] dark:bg-[#242c3c]">
        <h2 class="text-lg font-bold text-slate-900 dark:text-slate-100">Instalar Combustible by XivIoT</h2>
        <p class="mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          1. Pulsa el botón <strong>Compartir</strong> en Safari.<br/>
          2. Desliza y selecciona <strong>Añadir a pantalla de inicio</strong>.
        </p>
        <button
          type="button"
          id="close-ios-guide"
          class="mt-5 min-h-[44px] w-full rounded-xl bg-emerald-700 px-4 text-sm font-semibold text-white transition hover:bg-emerald-800 dark:bg-emerald-300 dark:text-slate-900 dark:hover:bg-emerald-200"
        >
          Entendido
        </button>
      </div>
    `;
    this.iosModalEl
      .querySelector('#close-ios-guide')
      ?.addEventListener('click', () => {
        this.showIOSGuide = false;
        this.renderIOSGuide();
      });
  }

  private renderTabBars(): void {
    const tabs: Array<{ id: TabId; label: string; icon: 'compass' | 'award' | 'star' }> = [
      { id: 'explore', label: 'Explorar', icon: 'compass' },
      { id: 'cheap', label: 'Baratas', icon: 'award' },
      { id: 'favorites', label: 'Favoritas', icon: 'star' },
    ];

    const html = tabs
      .map((t) => {
        const active = this.activeTab === t.id && !this.selectedStation;
        return `
          <button
            type="button"
            data-tab="${t.id}"
            class="flex min-h-[52px] flex-col items-center justify-center gap-0.5 px-2 transition ${
              active
                ? 'text-emerald-700 dark:text-emerald-300'
                : 'text-slate-500 hover:text-slate-800 dark:text-slate-300/75 dark:hover:text-slate-100'
            }"
          >
            ${iconSvg(t.id === 'favorites' && active ? 'star-filled' : t.icon, 'h-5 w-5')}
            <span class="text-[11px] font-semibold tracking-tight whitespace-nowrap">${t.label}</span>
          </button>
        `;
      })
      .join('');

    ['#tab-bar-mobile', '#tab-bar-desktop'].forEach((selector) => {
      const nav = this.root.querySelector(selector);
      if (!nav) return;
      nav.innerHTML = html;
      nav.querySelectorAll('[data-tab]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-tab') as TabId | null;
          if (!id) return;
          this.activeTab = id;
          this.selectedStation = null;
          this.map?.setSelectedStation(null);
          if (window.innerWidth < 1024 && this.sheetSnap === 'min') {
            this.setSheetSnap('mid');
          }
          this.renderTabBars();
          this.renderSheetContent();
        });
      });
    });
  }

  private renderProvinceGate(): void {
    if (!this.provinceModalEl) return;
    if (!this.showProvinceGate) {
      this.provinceModalEl.className = 'hidden';
      this.provinceModalEl.innerHTML = '';
      return;
    }

    const canDismiss = Boolean(this.activeProvince);

    this.provinceModalEl.className =
      'fixed inset-0 z-50 flex flex-col bg-slate-50/98 backdrop-blur-md dark:bg-[#1e2432]/98';
    this.provinceModalEl.innerHTML = `
      <div class="mx-auto flex h-full w-full max-w-3xl flex-col px-4 py-5 sm:px-6">
        <!-- Cabecera superior: solo el logo, sin títulos ni descripciones -->
        <header class="flex items-center justify-between gap-4">
          <div class="inline-flex items-center">
            ${BRAND_LOGO_SVG}
          </div>
          ${
            canDismiss
              ? `<button
                  type="button"
                  id="close-province-gate"
                  aria-label="Cerrar selector"
                  class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-[#343e52] dark:bg-[#242c3c] dark:text-slate-200 dark:hover:bg-[#2e384d]"
                >
                  ${iconSvg('x', 'h-5 w-5')}
                </button>`
              : ''
          }
        </header>

        <div class="mt-4 flex flex-col gap-2.5 sm:flex-row">
          <div class="relative flex-1">
            <span class="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-slate-400">
              ${iconSvg('search', 'h-4 w-4')}
            </span>
            <input
              id="province-search-input"
              type="search"
              value="${escapeHtml(this.provinceSearchQuery)}"
              placeholder="Buscar provincia (Madrid, Valencia, Sevilla…)"
              class="min-h-[46px] w-full rounded-xl border border-slate-200 bg-white pl-10 pr-4 text-sm text-slate-900 outline-none focus:border-emerald-600 focus:bg-white dark:border-[#343e52] dark:bg-[#242c3c] dark:text-slate-100 dark:focus:border-emerald-300 dark:focus:bg-[#2a3346]"
            />
          </div>

          <button
            type="button"
            id="detect-province-gps"
            class="flex min-h-[46px] shrink-0 items-center justify-center gap-2 rounded-xl bg-emerald-700 px-4 text-sm font-semibold text-white transition hover:bg-emerald-800 active:scale-[0.98] whitespace-nowrap dark:bg-emerald-300 dark:text-slate-900 dark:hover:bg-emerald-200"
          >
            ${iconSvg('locate', `h-4 w-4 ${this.gpsLoading ? 'animate-spin' : ''}`)}
            <span>${this.gpsLoading ? 'Localizando…' : 'Detectar por GPS'}</span>
          </button>
        </div>

        <div id="province-list-container" class="native-scroll mt-4 flex-1 overflow-y-auto pb-6"></div>
      </div>
    `;

    this.renderProvinceListOnly();

    this.provinceModalEl
      .querySelector('#close-province-gate')
      ?.addEventListener('click', () => {
        this.showProvinceGate = false;
        this.renderProvinceGate();
      });

    const input = this.provinceModalEl.querySelector('#province-search-input') as HTMLInputElement | null;
    input?.addEventListener('input', (e) => {
      this.provinceSearchQuery = (e.target as HTMLInputElement).value;
      this.renderProvinceListOnly();
    });

    this.provinceModalEl
      .querySelector('#detect-province-gps')
      ?.addEventListener('click', () => this.triggerLocateUser(true));
  }

  private updateProvinceGpsButton(): void {
    const btn = this.provinceModalEl?.querySelector('#detect-province-gps');
    if (!btn) return;
    btn.innerHTML = `
      ${iconSvg('locate', `h-4 w-4 ${this.gpsLoading ? 'animate-spin' : ''}`)}
      <span>${this.gpsLoading ? 'Localizando…' : 'Detectar por GPS'}</span>
    `;
  }

  private renderProvinceListOnly(): void {
    const container = this.provinceModalEl?.querySelector('#province-list-container');
    if (!container) return;

    const q = this.provinceSearchQuery.trim().toLowerCase();
    const filtered = PROVINCES.filter(
      (p) => p.name.toLowerCase().includes(q) || p.ccaa.toLowerCase().includes(q)
    );

    container.innerHTML = `
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        ${filtered
          .map((p) => {
            const isSelected = this.activeProvince?.id === p.id;
            return `
              <button
                type="button"
                data-province-id="${p.id}"
                class="flex min-h-[54px] items-center justify-between rounded-xl border px-4 py-2.5 text-left transition active:scale-[0.99] ${
                  isSelected
                    ? 'border-emerald-600 bg-emerald-50/70 dark:border-emerald-300 dark:bg-emerald-400/15'
                    : 'border-slate-200/90 bg-white hover:border-slate-300 hover:bg-slate-50 dark:border-[#343e52] dark:bg-[#242c3c] dark:hover:border-[#49556d] dark:hover:bg-[#2d374b]'
                }"
              >
                <div class="min-w-0">
                  <div class="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">${escapeHtml(p.name)}</div>
                  <div class="text-xs text-slate-500 dark:text-slate-300/80 truncate">${escapeHtml(p.ccaa)}</div>
                </div>
                ${iconSvg('chevron-right', 'h-4 w-4 shrink-0 text-slate-400')}
              </button>
            `;
          })
          .join('')}
      </div>
      ${
        filtered.length === 0
          ? `<p class="py-10 text-center text-sm text-slate-500 dark:text-slate-300">No se encontraron provincias con "${escapeHtml(this.provinceSearchQuery)}".</p>`
          : ''
      }
    `;

    container.querySelectorAll('[data-province-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-province-id');
        const prov = getProvinceById(id);
        if (prov) this.selectProvince(prov, true);
      });
    });
  }

  private getPriceTextColorClass(price: number): string {
    if (!price || this.p30 === 0) return 'text-slate-900 dark:text-slate-100';
    if (price <= this.p30) return 'text-emerald-700 dark:text-emerald-300';
    if (price <= this.p75) return 'text-sky-700 dark:text-sky-300';
    return 'text-rose-700 dark:text-rose-300';
  }

  private updateMobileSheetHeader(title: string, meta: string): void {
    if (this.sheetHeaderTitleEl) this.sheetHeaderTitleEl.textContent = title;
    if (this.sheetHeaderMetaEl) this.sheetHeaderMetaEl.textContent = meta;
  }

  private renderSheetContent(): void {
    if (!this.sheetBodyEl) return;

    if (!this.activeProvince) {
      this.updateMobileSheetHeader('Selecciona una provincia', '');
      this.sheetBodyEl.innerHTML = `
        <div class="py-8 text-center">
          <p class="text-sm text-slate-600 dark:text-slate-300">Elige una provincia para empezar a consultar precios.</p>
          <button
            type="button"
            id="empty-select-province"
            class="mt-4 min-h-[44px] rounded-xl bg-emerald-700 px-5 text-sm font-semibold text-white hover:bg-emerald-800 dark:bg-emerald-300 dark:text-slate-900 dark:hover:bg-emerald-200"
          >
            Elegir provincia
          </button>
        </div>
      `;
      this.sheetBodyEl
        .querySelector('#empty-select-province')
        ?.addEventListener('click', () => {
          this.showProvinceGate = true;
          this.renderProvinceGate();
        });
      return;
    }

    if (this.selectedStation) {
      this.renderStationDetail(this.selectedStation);
      return;
    }

    if (this.activeTab === 'explore') {
      this.renderExploreTab();
    } else if (this.activeTab === 'cheap') {
      this.renderCheapTab();
    } else {
      this.renderFavoritesTab();
    }
  }

  private renderOfflineBannerIfNeeded(): string {
    if (this.dataMode !== 'offline-empty') return '';
    return `
      <div class="mt-4 rounded-2xl border border-amber-300/70 bg-amber-50/70 p-4 dark:border-amber-300/30 dark:bg-amber-300/10">
        <p class="text-sm font-semibold text-amber-900 dark:text-amber-200">
          Offline · No estás conectado
        </p>
        <p class="mt-1 text-xs leading-relaxed text-amber-800/90 dark:text-amber-100/80">
          No hay conexión Online ni precios consultados en los últimos 10 minutos para esta provincia.
        </p>
        <div class="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            data-action="sheet-retry"
            class="min-h-[44px] rounded-xl bg-emerald-700 px-4 text-xs font-semibold text-white transition hover:bg-emerald-800 dark:bg-emerald-300 dark:text-slate-900 dark:hover:bg-emerald-200"
          >
            Reintentar Online
          </button>
          <button
            type="button"
            data-action="sheet-backup"
            class="min-h-[44px] rounded-xl border border-slate-300 bg-white px-4 text-xs font-semibold text-slate-800 transition hover:bg-slate-50 dark:border-[#3c485f] dark:bg-[#2a3346] dark:text-slate-100 dark:hover:bg-[#343f56]"
          >
            Ver respaldo Offline
          </button>
        </div>
      </div>
    `;
  }

  private renderExploreTab(): void {
    if (!this.sheetBodyEl) return;
    const fuelLabel =
      PRIMARY_FUELS.find((f) => f.key === this.activeFuel)?.label || 'Gasolina 95';

    this.updateMobileSheetHeader(
      this.userLocation ? 'Cercanas · Explorar' : 'Explorar provincia',
      `${fuelLabel} · ${this.fuelStations.length}`
    );

    this.sheetBodyEl.innerHTML = `
      <div class="space-y-3">
        <!-- Buscador sin perder el foco ni cambiar a blanco en modo oscuro -->
        <div class="relative">
          <span class="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-slate-400">
            ${iconSvg('search', 'h-4 w-4')}
          </span>
          <input
            id="station-search-input"
            type="search"
            value="${escapeHtml(this.searchQuery)}"
            placeholder="Buscar municipio, calle o marca…"
            class="min-h-[44px] w-full rounded-xl border border-slate-200 bg-slate-50 pl-10 pr-4 text-sm text-slate-900 outline-none focus:border-emerald-600 focus:bg-white dark:border-[#343e52] dark:bg-[#1e2432] dark:text-slate-100 dark:focus:border-emerald-300 dark:focus:bg-[#293245]"
          />
        </div>

        ${
          this.userLocation
            ? `<div class="grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1 dark:bg-[#1e2432]">
                <button
                  type="button"
                  data-sort="cheapest-near"
                  class="min-h-[40px] rounded-lg px-2 text-xs font-semibold transition whitespace-nowrap ${
                    this.sortMode === 'cheapest-near'
                      ? 'bg-white text-slate-900 shadow-sm dark:bg-[#313c52] dark:text-white'
                      : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
                  }"
                >
                  Más baratas cerca
                </button>
                <button
                  type="button"
                  data-sort="nearest"
                  class="min-h-[40px] rounded-lg px-2 text-xs font-semibold transition whitespace-nowrap ${
                    this.sortMode === 'nearest'
                      ? 'bg-white text-slate-900 shadow-sm dark:bg-[#313c52] dark:text-white'
                      : 'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white'
                  }"
                >
                  Más cercanas
                </button>
              </div>`
            : `<button
                type="button"
                data-action="ask-gps"
                class="flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-slate-50/70 px-3 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 active:bg-slate-200/70 dark:border-[#343e52] dark:bg-[#1e2432] dark:text-slate-200 dark:hover:bg-[#2d364a] dark:active:bg-[#354057]"
              >
                ${iconSvg('locate', 'h-4 w-4 text-emerald-600 dark:text-emerald-300')}
                <span>Activar GPS para ver distancia y tiempo en coche</span>
              </button>`
        }

        <div id="explore-list-container"></div>
      </div>
    `;

    this.renderExploreListOnly();

    const searchEl = this.sheetBodyEl.querySelector('#station-search-input') as HTMLInputElement | null;
    searchEl?.addEventListener('input', (e) => {
      this.searchQuery = (e.target as HTMLInputElement).value;
      this.renderExploreListOnly();
    });

    this.sheetBodyEl.querySelectorAll('[data-sort]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-sort') as SortMode | null;
        if (mode) {
          this.sortMode = mode;
          this.renderExploreTab();
        }
      });
    });

    this.sheetBodyEl
      .querySelector('[data-action="ask-gps"]')
      ?.addEventListener('click', () => this.triggerLocateUser(false));
  }

  private renderExploreListOnly(): void {
    const container = this.sheetBodyEl?.querySelector('#explore-list-container');
    if (!container) return;

    const fuelLabel =
      PRIMARY_FUELS.find((f) => f.key === this.activeFuel)?.label || 'Gasolina 95';

    const q = this.searchQuery.trim().toLowerCase();
    const list = this.fuelStations.filter((s) => {
      if (!q) return true;
      return (
        s.brand.toLowerCase().includes(q) ||
        s.municipality.toLowerCase().includes(q) ||
        s.locality.toLowerCase().includes(q) ||
        s.address.toLowerCase().includes(q)
      );
    });

    const withDist = list.map((s) => ({
      station: s,
      price: s.prices[this.activeFuel],
      distKm: this.userLocation
        ? haversineKm(this.userLocation.lat, this.userLocation.lng, s.lat, s.lng)
        : null,
    }));

    if (this.userLocation) {
      if (this.sortMode === 'nearest') {
        withDist.sort((a, b) => (a.distKm ?? 9999) - (b.distKm ?? 9999));
      } else {
        withDist.sort((a, b) => {
          const aNear = (a.distKm ?? 9999) <= 12;
          const bNear = (b.distKm ?? 9999) <= 12;
          if (aNear !== bNear) return aNear ? -1 : 1;
          if (a.price !== b.price) return a.price - b.price;
          return (a.distKm ?? 9999) - (b.distKm ?? 9999);
        });
      }
    } else {
      withDist.sort((a, b) => a.price - b.price);
    }

    const visibleItems = withDist.slice(0, 60);

    container.innerHTML = `
      ${this.renderOfflineBannerIfNeeded()}
      ${
        this.dataMode === 'loading'
          ? `<div class="py-10 text-center text-sm text-slate-500 dark:text-slate-300">Cargando gasolineras…</div>`
          : visibleItems.length === 0 && this.dataMode !== 'offline-empty'
            ? `<div class="py-10 text-center text-sm text-slate-500 dark:text-slate-300">No hay estaciones disponibles con ${fuelLabel} para esta búsqueda.</div>`
            : `<div class="divide-y divide-slate-100 dark:divide-[#343e52]">
                ${visibleItems
                  .map((item) => {
                    const st = item.station;
                    const isFav = Boolean(getFavorite(st.id));
                    const distMeta =
                      item.distKm !== null
                        ? `${formatDistance(item.distKm)} · ~${estimateDriveMinutes(item.distKm)} min`
                        : escapeHtml(st.municipality || st.locality);
                    return `
                      <button
                        type="button"
                        data-station-id="${escapeHtml(st.id)}"
                        class="flex min-h-[64px] w-full items-center justify-between gap-3 py-3 text-left transition hover:bg-slate-50/80 active:bg-slate-100/70 dark:hover:bg-[#2d364a] dark:active:bg-[#354057]"
                      >
                        <div class="min-w-0 flex-1">
                          <div class="flex items-center gap-1.5">
                            <span class="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">${escapeHtml(st.brand)}</span>
                            ${isFav ? `<span class="text-amber-400 shrink-0">${iconSvg('star-filled', 'h-3.5 w-3.5')}</span>` : ''}
                          </div>
                          <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-300/80 truncate">
                            ${escapeHtml(st.address)} · ${escapeHtml(st.locality || st.municipality)}
                          </p>
                          <p class="mt-0.5 text-xs font-medium text-slate-600 dark:text-slate-300 tabular-nums">
                            ${distMeta}
                          </p>
                        </div>
                        <div class="shrink-0 text-right">
                          <span class="font-mono-num text-base font-bold ${this.getPriceTextColorClass(item.price)}">
                            ${formatPrice(item.price)}
                          </span>
                          <div class="text-[11px] text-slate-400 dark:text-slate-400">por litro</div>
                        </div>
                      </button>
                    `;
                  })
                  .join('')}
              </div>`
      }
    `;

    this.bindStationListActions();
  }

  private renderCheapTab(): void {
    if (!this.sheetBodyEl) return;
    const fuelLabel =
      PRIMARY_FUELS.find((f) => f.key === this.activeFuel)?.label || 'Gasolina 95';

    const sorted = [...this.fuelStations].sort(
      (a, b) => a.prices[this.activeFuel] - b.prices[this.activeFuel]
    );
    const avg =
      sorted.length > 0
        ? sorted.reduce((acc, s) => acc + s.prices[this.activeFuel], 0) / sorted.length
        : 0;

    const top = sorted.slice(0, 50);
    this.updateMobileSheetHeader(
      `Más baratas · ${fuelLabel}`,
      top.length > 0 ? `Desde ${formatPrice(top[0].prices[this.activeFuel])}` : ''
    );

    this.sheetBodyEl.innerHTML = `
      <div class="space-y-3">
        ${
          sorted.length > 0
            ? `<div class="flex items-baseline justify-between border-b border-slate-200 pb-3 dark:border-[#343e52]">
                <div>
                  <span class="text-xs text-slate-500 dark:text-slate-300">Mejor precio en ${escapeHtml(this.activeProvince?.name || '')}</span>
                  <div class="font-mono-num text-2xl font-bold text-emerald-700 dark:text-emerald-300">
                    ${formatPrice(sorted[0].prices[this.activeFuel])}
                  </div>
                </div>
                <div class="text-right">
                  <span class="text-xs text-slate-500 dark:text-slate-300">Media provincial</span>
                  <div class="font-mono-num text-sm font-semibold text-slate-700 dark:text-slate-200">
                    ${formatPrice(avg)}
                  </div>
                </div>
              </div>`
            : ''
        }

        ${this.renderOfflineBannerIfNeeded()}

        ${
          this.dataMode === 'loading'
            ? `<div class="py-10 text-center text-sm text-slate-500 dark:text-slate-300">Calculando ranking…</div>`
            : top.length === 0 && this.dataMode !== 'offline-empty'
              ? `<div class="py-10 text-center text-sm text-slate-500 dark:text-slate-300">Sin datos de ${fuelLabel} en esta provincia.</div>`
              : `<div class="divide-y divide-slate-100 dark:divide-[#343e52]">
                  ${top
                    .map((st, idx) => {
                      const price = st.prices[this.activeFuel];
                      const distKm = this.userLocation
                        ? haversineKm(this.userLocation.lat, this.userLocation.lng, st.lat, st.lng)
                        : null;
                      return `
                        <button
                          type="button"
                          data-station-id="${escapeHtml(st.id)}"
                          class="flex min-h-[62px] w-full items-center gap-3 py-3 text-left transition hover:bg-slate-50/80 active:bg-slate-100/70 dark:hover:bg-[#2d364a] dark:active:bg-[#354057]"
                        >
                          <span class="font-mono-num w-7 shrink-0 text-sm font-bold text-slate-400 dark:text-slate-400">
                            ${String(idx + 1).padStart(2, '0')}.
                          </span>
                          <div class="min-w-0 flex-1">
                            <div class="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                              ${escapeHtml(st.brand)}
                            </div>
                            <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-300/80 truncate">
                              ${escapeHtml(st.address)} · ${escapeHtml(st.municipality || st.locality)}
                            </p>
                            ${
                              distKm !== null
                                ? `<p class="mt-0.5 text-xs text-slate-500 dark:text-slate-300 tabular-nums">${formatDistance(distKm)} · ~${estimateDriveMinutes(distKm)} min</p>`
                                : ''
                            }
                          </div>
                          <span class="font-mono-num shrink-0 text-base font-bold ${this.getPriceTextColorClass(price)}">
                            ${formatPrice(price)}
                          </span>
                        </button>
                      `;
                    })
                    .join('')}
                </div>`
        }
      </div>
    `;

    this.bindStationListActions();
  }

  private renderFavoritesTab(): void {
    if (!this.sheetBodyEl) return;
    this.favorites = getFavorites();
    const fuelLabel =
      PRIMARY_FUELS.find((f) => f.key === this.activeFuel)?.label || 'Gasolina 95';

    this.updateMobileSheetHeader(
      'Mis gasolineras favoritas',
      `${this.favorites.length} guardadas`
    );

    if (this.favorites.length === 0) {
      this.sheetBodyEl.innerHTML = `
        <div class="py-10 text-center">
          <div class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-500 dark:bg-[#313c52] dark:text-slate-300">
            ${iconSvg('star', 'h-6 w-6')}
          </div>
          <h3 class="mt-3 text-base font-semibold text-slate-900 dark:text-slate-100">Sin favoritas todavía</h3>
          <p class="mx-auto mt-1 max-w-xs text-sm text-slate-500 dark:text-slate-300">
            Abre cualquier gasolinera del mapa y guárdala como <strong>Casa</strong>, <strong>Trabajo</strong>, <strong>Uni</strong> o una etiqueta propia para ver sus precios al instante.
          </p>
        </div>
      `;
      return;
    }

    const keyThree = this.favorites.slice(0, 3);
    const others = this.favorites.slice(3);

    const renderFavRow = (fav: FavoriteEntry) => {
      const liveMatch = this.allStations.find((s) => s.id === fav.id);
      const st = liveMatch || fav.station;
      const price = st.prices[this.activeFuel];
      const statusLabel = liveMatch
        ? this.dataMode === 'online'
          ? 'Online'
          : 'Offline'
        : fav.priceSource === 'online'
          ? 'Online'
          : 'Offline';

      const distKm = this.userLocation
        ? haversineKm(this.userLocation.lat, this.userLocation.lng, st.lat, st.lng)
        : null;

      return `
        <div class="flex min-h-[72px] items-center justify-between gap-2 py-3">
          <button
            type="button"
            data-fav-open="${escapeHtml(fav.id)}"
            class="min-w-0 flex-1 rounded-lg py-1 text-left transition hover:bg-slate-50/70 dark:hover:bg-[#2d364a]"
          >
            <div class="flex items-center gap-2 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
              <span>${escapeHtml(fav.tag)}</span>
              <span aria-hidden="true">·</span>
              <span class="text-slate-500 dark:text-slate-300">${statusLabel}</span>
            </div>
            <div class="mt-0.5 text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
              ${escapeHtml(st.brand)}
            </div>
            <p class="text-xs text-slate-500 dark:text-slate-300/80 truncate">
              ${escapeHtml(st.address)} · ${escapeHtml(st.municipality || st.locality)}${
                distKm !== null ? ` · ${formatDistance(distKm)}` : ''
              }
            </p>
          </button>

          <div class="flex items-center gap-2 shrink-0">
            <div class="text-right">
              ${
                typeof price === 'number'
                  ? `<div class="font-mono-num text-base font-bold text-slate-900 dark:text-slate-100">${formatPrice(price)}</div>
                     <div class="text-[11px] text-slate-400 dark:text-slate-400">${fuelLabel}</div>`
                  : `<div class="text-xs font-medium text-slate-400">Sin ${fuelLabel}</div>`
              }
            </div>
            <button
              type="button"
              data-fav-remove="${escapeHtml(fav.id)}"
              aria-label="Quitar de favoritas"
              class="flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 hover:bg-slate-100 hover:text-rose-600 dark:hover:bg-[#313c52] dark:hover:text-rose-300"
            >
              ${iconSvg('trash', 'h-4 w-4')}
            </button>
          </div>
        </div>
      `;
    };

    this.sheetBodyEl.innerHTML = `
      <div class="space-y-4">
        <div>
          <h3 class="text-xs font-semibold tracking-tight text-slate-500 dark:text-slate-300">
            Tus ${keyThree.length === 1 ? 'estación clave' : `${keyThree.length} gasolineras clave`} · ${fuelLabel}
          </h3>
          <div class="mt-1 divide-y divide-slate-100 dark:divide-[#343e52]">
            ${keyThree.map(renderFavRow).join('')}
          </div>
        </div>

        ${
          others.length > 0
            ? `<div>
                <h3 class="text-xs font-semibold tracking-tight text-slate-500 dark:text-slate-300">
                  Más guardadas
                </h3>
                <div class="mt-1 divide-y divide-slate-100 dark:divide-[#343e52]">
                  ${others.map(renderFavRow).join('')}
                </div>
              </div>`
            : ''
        }
      </div>
    `;

    this.sheetBodyEl.querySelectorAll('[data-fav-open]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-fav-open');
        const fav = this.favorites.find((f) => f.id === id);
        if (!fav) return;
        const live = this.allStations.find((s) => s.id === fav.id);
        if (live) {
          this.focusAndSelectStation(live);
        } else {
          const targetProv = getProvinceById(fav.station.provinceId);
          if (targetProv && targetProv.id !== this.activeProvince?.id) {
            this.selectProvince(targetProv, false);
            await this.loadActiveProvince();
            const refreshed = this.allStations.find((s) => s.id === fav.id) || fav.station;
            this.focusAndSelectStation(refreshed);
          } else {
            this.focusAndSelectStation(fav.station);
          }
        }
      });
    });

    this.sheetBodyEl.querySelectorAll('[data-fav-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-fav-remove');
        if (!id) return;
        this.favorites = removeFavorite(id);
        this.map?.setFavorites(new Set(this.favorites.map((f) => f.id)));
        this.renderFavoritesTab();
      });
    });
  }

  private renderStationDetail(station: Station): void {
    if (!this.sheetBodyEl) return;

    const fav = getFavorite(station.id);
    const isFav = Boolean(fav);
    const distKm = this.userLocation
      ? haversineKm(this.userLocation.lat, this.userLocation.lng, station.lat, station.lng)
      : null;

    const is24h = /24\s*h/i.test(station.schedule);
    const scheduleLabel = is24h ? 'Abierto 24 horas' : station.schedule || 'Horario no especificado';

    const availableFuels = ALL_FUEL_META.filter(
      (meta) => typeof station.prices[meta.key] === 'number' && station.prices[meta.key] > 0
    );

    const activePrice = station.prices[this.activeFuel];
    const activeFuelName =
      PRIMARY_FUELS.find((f) => f.key === this.activeFuel)?.label || 'Carburante';

    const baseShareUrl = `${window.location.origin}${window.location.pathname}?estacion=${encodeURIComponent(station.id)}`;
    const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${station.lat},${station.lng}`;
    const whatsappText =
      typeof activePrice === 'number'
        ? `${station.brand} (${station.locality || station.municipality}) — ${activeFuelName}: ${formatPrice(activePrice)}\n${station.address}\n${baseShareUrl}`
        : `${station.brand} (${station.locality || station.municipality})\n${station.address}\n${baseShareUrl}`;
    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(whatsappText)}`;

    this.updateMobileSheetHeader(
      station.brand,
      typeof activePrice === 'number' ? formatPrice(activePrice) : station.locality
    );

    this.sheetBodyEl.innerHTML = `
      <div class="space-y-4 pb-4">
        <div class="flex items-center justify-between gap-2">
          <button
            type="button"
            id="detail-back-btn"
            class="flex min-h-[44px] items-center gap-1.5 rounded-xl px-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-[#313c52]"
          >
            ${iconSvg('arrow-left', 'h-4 w-4')}
            <span>Volver</span>
          </button>

          <button
            type="button"
            id="detail-fav-toggle"
            class="flex min-h-[44px] items-center gap-1.5 rounded-xl px-3.5 text-xs font-semibold transition ${
              isFav
                ? 'bg-amber-400/20 text-amber-700 hover:bg-amber-400/30 dark:text-amber-200 dark:hover:bg-amber-400/30'
                : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-[#3c485f] dark:bg-[#2a3346] dark:text-slate-200 dark:hover:bg-[#343f56]'
            }"
          >
            ${iconSvg(isFav ? 'star-filled' : 'star', 'h-4 w-4')}
            <span>${isFav ? `Guardada · ${escapeHtml(fav!.tag)}` : 'Guardar favorita'}</span>
          </button>
        </div>

        <div>
          <h2 class="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            ${escapeHtml(station.brand)}
          </h2>
          <p class="mt-1 flex items-start gap-1.5 text-sm text-slate-600 dark:text-slate-300">
            ${iconSvg('map-pin', 'mt-0.5 h-4 w-4 shrink-0 text-slate-400')}
            <span>${escapeHtml(station.address)} · ${escapeHtml(station.locality || station.municipality)}${station.cp ? ` (${escapeHtml(station.cp)})` : ''}</span>
          </p>
          <div class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500 dark:text-slate-300">
            <span class="inline-flex items-center gap-1 ${is24h ? 'font-semibold text-emerald-700 dark:text-emerald-300' : ''}">
              ${iconSvg('clock', 'h-3.5 w-3.5')}
              ${escapeHtml(scheduleLabel)}
            </span>
            ${
              distKm !== null
                ? `<span aria-hidden="true">·</span>
                   <span class="font-medium tabular-nums">${formatDistance(distKm)} · ~${estimateDriveMinutes(distKm)} min en coche</span>`
                : ''
            }
          </div>
        </div>

        <!-- Etiquetas rápidas de favorita -->
        <div class="rounded-2xl border border-slate-200/80 bg-slate-50/70 p-3 dark:border-[#343e52] dark:bg-[#1e2432]">
          <div class="text-xs font-semibold text-slate-600 dark:text-slate-300">
            Etiqueta rápida en Favoritas
          </div>
          <div class="mt-2 flex flex-wrap gap-1.5">
            ${QUICK_FAVORITE_TAGS.map((tag) => {
              const activeTag = fav?.tag === tag;
              return `
                <button
                  type="button"
                  data-quick-tag="${tag}"
                  class="min-h-[40px] rounded-xl px-3.5 text-xs font-semibold transition ${
                    activeTag
                      ? 'bg-emerald-700 text-white hover:bg-emerald-800 dark:bg-emerald-300 dark:text-slate-900 dark:hover:bg-emerald-200'
                      : 'border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 active:bg-slate-200/70 dark:border-[#3c485f] dark:bg-[#242c3c] dark:text-slate-200 dark:hover:bg-[#313c52] dark:active:bg-[#3a4761]'
                  }"
                >
                  ${tag}
                </button>
              `;
            }).join('')}
          </div>
          <form id="custom-tag-form" class="mt-2 flex gap-2">
            <input
              id="custom-tag-input"
              type="text"
              maxlength="24"
              value="${escapeHtml(this.customTagDraft)}"
              placeholder="Etiqueta personalizada (ej. Pueblo)…"
              class="min-h-[42px] flex-1 rounded-xl border border-slate-200 bg-white px-3 text-xs text-slate-900 outline-none focus:border-emerald-600 focus:bg-white dark:border-[#3c485f] dark:bg-[#242c3c] dark:text-slate-100 dark:focus:border-emerald-300 dark:focus:bg-[#2b3447]"
            />
            <button
              type="submit"
              class="min-h-[42px] shrink-0 rounded-xl bg-emerald-700 px-3.5 text-xs font-semibold text-white transition hover:bg-emerald-800 active:scale-[0.98] dark:bg-emerald-300 dark:text-slate-900 dark:hover:bg-emerald-200"
            >
              Guardar
            </button>
          </form>
        </div>

        <!-- Tabla completa de carburantes -->
        <div>
          <h3 class="text-xs font-semibold text-slate-500 dark:text-slate-300">
            Todos los carburantes disponibles
          </h3>
          <div class="mt-2 overflow-hidden rounded-2xl border border-slate-200/80 dark:border-[#343e52]">
            <table class="w-full text-left text-sm">
              <tbody class="divide-y divide-slate-100 dark:divide-[#343e52]">
                ${availableFuels
                  .map((meta) => {
                    const price = station.prices[meta.key];
                    const isActiveFuel = meta.key === this.activeFuel;
                    return `
                      <tr class="${
                        isActiveFuel
                          ? 'bg-emerald-50/70 dark:bg-emerald-400/15'
                          : 'bg-white dark:bg-[#242c3c]'
                      }">
                        <td class="px-3.5 py-2.5 font-medium ${
                          isActiveFuel
                            ? 'text-emerald-800 dark:text-emerald-200'
                            : 'text-slate-700 dark:text-slate-200'
                        }">
                          ${escapeHtml(meta.label)}
                        </td>
                        <td class="font-mono-num px-3.5 py-2.5 text-right font-bold ${
                          isActiveFuel
                            ? 'text-emerald-700 dark:text-emerald-300'
                            : 'text-slate-900 dark:text-slate-100'
                        }">
                          ${formatPrice(price)}
                        </td>
                      </tr>
                    `;
                  })
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>

        <!-- Acciones directas -->
        <div class="grid grid-cols-1 gap-2 pt-1 sm:grid-cols-3">
          <a
            href="${mapsUrl}"
            target="_blank"
            rel="noopener noreferrer"
            class="flex min-h-[46px] items-center justify-center gap-2 rounded-xl bg-emerald-700 px-3 text-xs font-semibold text-white transition hover:bg-emerald-800 active:scale-[0.98] dark:bg-emerald-300 dark:text-slate-900 dark:hover:bg-emerald-200"
          >
            ${iconSvg('navigation', 'h-4 w-4')}
            <span>Cómo llegar</span>
          </a>

          <a
            href="${whatsappUrl}"
            target="_blank"
            rel="noopener noreferrer"
            class="flex min-h-[46px] items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-800 transition hover:bg-slate-50 active:bg-slate-100 dark:border-[#3c485f] dark:bg-[#2a3346] dark:text-slate-100 dark:hover:bg-[#343f56] dark:active:bg-[#3d4a64]"
          >
            ${iconSvg('share', 'h-4 w-4 text-emerald-600 dark:text-emerald-300')}
            <span>WhatsApp</span>
          </a>

          <button
            type="button"
            id="copy-station-link"
            class="flex min-h-[46px] items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-800 transition hover:bg-slate-50 active:bg-slate-100 dark:border-[#3c485f] dark:bg-[#2a3346] dark:text-slate-100 dark:hover:bg-[#343f56] dark:active:bg-[#3d4a64]"
          >
            ${iconSvg(this.linkCopiedId === station.id ? 'check' : 'copy', 'h-4 w-4')}
            <span>${this.linkCopiedId === station.id ? 'Copiado' : 'Copiar enlace'}</span>
          </button>
        </div>
      </div>
    `;

    this.sheetBodyEl
      .querySelector('#detail-back-btn')
      ?.addEventListener('click', () => {
        this.selectedStation = null;
        this.map?.setSelectedStation(null);
        this.renderTabBars();
        this.renderSheetContent();
      });

    this.sheetBodyEl
      .querySelector('#detail-fav-toggle')
      ?.addEventListener('click', () => {
        if (getFavorite(station.id)) {
          this.favorites = removeFavorite(station.id);
        } else {
          this.favorites = saveFavorite(
            station,
            'Casa',
            this.dataMode === 'online' ? 'online' : 'offline'
          );
        }
        this.map?.setFavorites(new Set(this.favorites.map((f) => f.id)));
        this.renderStationDetail(station);
      });

    this.sheetBodyEl.querySelectorAll('[data-quick-tag]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tag = btn.getAttribute('data-quick-tag');
        if (!tag) return;
        this.favorites = saveFavorite(
          station,
          tag,
          this.dataMode === 'online' ? 'online' : 'offline'
        );
        this.customTagDraft = tag;
        this.map?.setFavorites(new Set(this.favorites.map((f) => f.id)));
        this.renderStationDetail(station);
      });
    });

    this.sheetBodyEl
      .querySelector('#custom-tag-form')
      ?.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = this.sheetBodyEl?.querySelector('#custom-tag-input') as HTMLInputElement | null;
        const val = input?.value.trim() || 'Favorita';
        this.customTagDraft = val;
        this.favorites = saveFavorite(
          station,
          val,
          this.dataMode === 'online' ? 'online' : 'offline'
        );
        this.map?.setFavorites(new Set(this.favorites.map((f) => f.id)));
        this.renderStationDetail(station);
      });

    this.sheetBodyEl
      .querySelector('#copy-station-link')
      ?.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(baseShareUrl);
          this.linkCopiedId = station.id;
          this.renderStationDetail(station);
          setTimeout(() => {
            if (this.linkCopiedId === station.id) {
              this.linkCopiedId = null;
              if (this.selectedStation?.id === station.id) {
                this.renderStationDetail(station);
              }
            }
          }, 2200);
        } catch {
          // Fallback silencioso
        }
      });
  }

  private bindStationListActions(): void {
    if (!this.sheetBodyEl) return;

    this.sheetBodyEl
      .querySelector('[data-action="sheet-retry"]')
      ?.addEventListener('click', () => this.loadActiveProvince());

    this.sheetBodyEl
      .querySelector('[data-action="sheet-backup"]')
      ?.addEventListener('click', () => this.loadStaticBackup());

    this.sheetBodyEl.querySelectorAll('[data-station-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-station-id');
        const st = this.allStations.find((s) => s.id === id);
        if (!st) return;
        this.selectStation(st, true);
        this.map?.setView(st.lat, st.lng, Math.max(this.map.getView().zoom, 13.8), true);
      });
    });
  }
}
