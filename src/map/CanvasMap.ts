import { formatShortPrice } from '../data/provinces';
import type { PrimaryFuelKey, Station } from '../types';

export interface CanvasMapOptions {
  canvas: HTMLCanvasElement;
  onSelectStation: (station: Station) => void;
  onMapInteract: () => void;
}

interface TileEntry {
  img: HTMLImageElement;
  loaded: boolean;
  failed: boolean;
  lastUsed: number;
}

const TILE_SIZE = 256;
const MIN_ZOOM = 5.4;
const MAX_ZOOM = 18.2;
const MAX_TILE_CACHE = 260;

export class CanvasMap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private onSelectStation: (station: Station) => void;
  private onMapInteract: () => void;

  private centerLat = 40.4168;
  private centerLng = -3.7038;
  private zoom = 10.5;
  private width = 375;
  private height = 667;
  private dpr = 1;
  private isDark = false;

  private stations: Station[] = [];
  private activeFuel: PrimaryFuelKey = 'g95';
  private selectedId: string | null = null;
  private favoriteIds = new Set<string>();
  private userLocation: { lat: number; lng: number } | null = null;

  private p30 = 0;
  private p55 = 0;
  private p75 = 0;

  private tiles = new Map<string, TileEntry>();
  private rafScheduled = false;
  private animFrameId: number | null = null;

  // Gesture state
  private isPanning = false;
  private panStartX = 0;
  private panStartY = 0;
  private panStartTime = 0;
  private panMoved = false;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private velocitySamples: Array<{ x: number; y: number; t: number }> = [];

  private isPinching = false;
  private pinchInitialDist = 0;
  private pinchInitialZoom = 10;
  private pinchWorldX = 0;
  private pinchWorldY = 0;

  private lastTapTime = 0;
  private lastTapX = 0;
  private lastTapY = 0;

  private cartoApiKey = (import.meta.env.VITE_CARTODB_API_KEY || '').trim();
  private resizeObserver: ResizeObserver | null = null;

  constructor(options: CanvasMapOptions) {
    this.canvas = options.canvas;
    const context = this.canvas.getContext('2d', { alpha: false });
    if (!context) {
      throw new Error('Canvas 2D no disponible');
    }
    this.ctx = context;
    this.onSelectStation = options.onSelectStation;
    this.onMapInteract = options.onMapInteract;

    this.resize();
    this.bindEvents();
  }

  public setTheme(isDark: boolean): void {
    if (this.isDark !== isDark) {
      this.isDark = isDark;
      this.tiles.clear();
      this.requestDraw();
    }
  }

  public setView(lat: number, lng: number, zoom?: number, animate = false): void {
    if (animate) {
      this.animateTo(lat, lng, zoom ?? this.zoom, 320);
      return;
    }
    this.stopAnimations();
    this.centerLat = lat;
    this.centerLng = lng;
    if (typeof zoom === 'number') {
      this.zoom = this.clampZoom(zoom);
    }
    this.requestDraw();
  }

  public getView(): { lat: number; lng: number; zoom: number } {
    return { lat: this.centerLat, lng: this.centerLng, zoom: this.zoom };
  }

  public setData(
    stations: Station[],
    activeFuel: PrimaryFuelKey,
    selectedId: string | null,
    favoriteIds: Set<string>
  ): void {
    this.stations = stations;
    this.activeFuel = activeFuel;
    this.selectedId = selectedId;
    this.favoriteIds = favoriteIds;
    this.computePriceThresholds();
    this.requestDraw();
  }

  public setSelectedStation(selectedId: string | null): void {
    this.selectedId = selectedId;
    this.requestDraw();
  }

  public setFavorites(favoriteIds: Set<string>): void {
    this.favoriteIds = favoriteIds;
    this.requestDraw();
  }

  public setUserLocation(loc: { lat: number; lng: number } | null): void {
    this.userLocation = loc;
    this.requestDraw();
  }

  public destroy(): void {
    this.stopAnimations();
    this.resizeObserver?.disconnect();
  }

  private computePriceThresholds(): void {
    const prices: number[] = [];
    for (const s of this.stations) {
      const p = s.prices[this.activeFuel];
      if (typeof p === 'number' && p > 0) prices.push(p);
    }
    if (prices.length === 0) {
      this.p30 = this.p55 = this.p75 = 0;
      return;
    }
    prices.sort((a, b) => a - b);
    this.p30 = prices[Math.floor((prices.length - 1) * 0.28)];
    this.p55 = prices[Math.floor((prices.length - 1) * 0.55)];
    this.p75 = prices[Math.floor((prices.length - 1) * 0.78)];
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width || window.innerWidth);
    this.height = Math.max(1, rect.height || window.innerHeight);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.requestDraw();
  }

  private clampZoom(z: number): number {
    return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
  }

  private clampLat(lat: number): number {
    return Math.max(-85, Math.min(85, lat));
  }

  // Proyección Web Mercator normalizada [0, 1]
  private latLngToNorm(lat: number, lng: number): { x: number; y: number } {
    const x = (lng + 180) / 360;
    const sinLat = Math.sin((this.clampLat(lat) * Math.PI) / 180);
    const y = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
    return { x, y };
  }

  private normToLatLng(nx: number, ny: number): { lat: number; lng: number } {
    const lng = nx * 360 - 180;
    const n = Math.PI - 2 * Math.PI * ny;
    const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    return { lat, lng };
  }

  private worldPixelSize(zoom: number): number {
    return TILE_SIZE * Math.pow(2, zoom);
  }

  private latLngToScreen(lat: number, lng: number): { x: number; y: number } {
    const worldSize = this.worldPixelSize(this.zoom);
    const centerNorm = this.latLngToNorm(this.centerLat, this.centerLng);
    const ptNorm = this.latLngToNorm(lat, lng);
    return {
      x: this.width / 2 + (ptNorm.x - centerNorm.x) * worldSize,
      y: this.height / 2 + (ptNorm.y - centerNorm.y) * worldSize,
    };
  }

  private screenToNorm(sx: number, sy: number, zoom = this.zoom): { x: number; y: number } {
    const worldSize = this.worldPixelSize(zoom);
    const centerNorm = this.latLngToNorm(this.centerLat, this.centerLng);
    return {
      x: centerNorm.x + (sx - this.width / 2) / worldSize,
      y: centerNorm.y + (sy - this.height / 2) / worldSize,
    };
  }

  private panByPixels(dx: number, dy: number): void {
    const worldSize = this.worldPixelSize(this.zoom);
    const centerNorm = this.latLngToNorm(this.centerLat, this.centerLng);
    const nextX = centerNorm.x - dx / worldSize;
    const nextY = Math.max(0.05, Math.min(0.95, centerNorm.y - dy / worldSize));
    const next = this.normToLatLng(nextX, nextY);
    this.centerLat = next.lat;
    this.centerLng = next.lng;
  }

  private zoomAroundPoint(targetZoom: number, sx: number, sy: number): void {
    const clamped = this.clampZoom(targetZoom);
    const anchorNorm = this.screenToNorm(sx, sy, this.zoom);
    this.zoom = clamped;
    const nextWorldSize = this.worldPixelSize(clamped);
    const nextCenterNormX = anchorNorm.x - (sx - this.width / 2) / nextWorldSize;
    const nextCenterNormY = Math.max(
      0.05,
      Math.min(0.95, anchorNorm.y - (sy - this.height / 2) / nextWorldSize)
    );
    const next = this.normToLatLng(nextCenterNormX, nextCenterNormY);
    this.centerLat = next.lat;
    this.centerLng = next.lng;
  }

  private stopAnimations(): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  private animateTo(targetLat: number, targetLng: number, targetZoom: number, durationMs = 260): void {
    this.stopAnimations();
    const startLat = this.centerLat;
    const startLng = this.centerLng;
    const startZoom = this.zoom;
    const clampedTargetZoom = this.clampZoom(targetZoom);
    const startTime = performance.now();

    const step = (now: number) => {
      const t = Math.min(1, (now - startTime) / durationMs);
      const ease = 1 - Math.pow(1 - t, 3);
      this.centerLat = startLat + (targetLat - startLat) * ease;
      this.centerLng = startLng + (targetLng - startLng) * ease;
      this.zoom = startZoom + (clampedTargetZoom - startZoom) * ease;
      this.draw();
      if (t < 1) {
        this.animFrameId = requestAnimationFrame(step);
      } else {
        this.animFrameId = null;
      }
    };
    this.animFrameId = requestAnimationFrame(step);
  }

  private animateDoubleTapZoom(sx: number, sy: number): void {
    this.stopAnimations();
    const anchorNorm = this.screenToNorm(sx, sy, this.zoom);
    const startZoom = this.zoom;
    const targetZoom = this.clampZoom(startZoom + 1.65);
    const startTime = performance.now();
    const durationMs = 240;

    const step = (now: number) => {
      const t = Math.min(1, (now - startTime) / durationMs);
      const ease = 1 - Math.pow(1 - t, 3);
      const z = startZoom + (targetZoom - startZoom) * ease;
      const worldSize = this.worldPixelSize(z);
      const centerNormX = anchorNorm.x - (sx - this.width / 2) / worldSize;
      const centerNormY = Math.max(
        0.05,
        Math.min(0.95, anchorNorm.y - (sy - this.height / 2) / worldSize)
      );
      const next = this.normToLatLng(centerNormX, centerNormY);
      this.zoom = z;
      this.centerLat = next.lat;
      this.centerLng = next.lng;
      this.draw();
      if (t < 1) {
        this.animFrameId = requestAnimationFrame(step);
      } else {
        this.animFrameId = null;
      }
    };
    this.animFrameId = requestAnimationFrame(step);
  }

  private startInertia(vx: number, vy: number): void {
    if (Math.hypot(vx, vy) < 0.08) return;
    this.stopAnimations();
    let curVx = vx * 16;
    let curVy = vy * 16;

    const step = () => {
      curVx *= 0.92;
      curVy *= 0.92;
      if (Math.hypot(curVx, curVy) < 0.35) {
        this.animFrameId = null;
        return;
      }
      this.panByPixels(curVx, curVy);
      this.draw();
      this.animFrameId = requestAnimationFrame(step);
    };
    this.animFrameId = requestAnimationFrame(step);
  }

  private bindEvents(): void {
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);
    window.addEventListener('resize', () => this.resize());

    // Touch Events para gestos móviles ultra-suaves (pinch + pan + doble toque)
    this.canvas.addEventListener(
      'touchstart',
      (e) => {
        if (e.touches.length === 0) return;
        e.preventDefault();
        this.stopAnimations();
        this.onMapInteract();

        const rect = this.canvas.getBoundingClientRect();

        if (e.touches.length >= 2) {
          this.isPanning = false;
          this.isPinching = true;
          const t0 = e.touches[0];
          const t1 = e.touches[1];
          const dx = t1.clientX - t0.clientX;
          const dy = t1.clientY - t0.clientY;
          this.pinchInitialDist = Math.max(10, Math.hypot(dx, dy));
          this.pinchInitialZoom = this.zoom;
          const midX = (t0.clientX + t1.clientX) / 2 - rect.left;
          const midY = (t0.clientY + t1.clientY) / 2 - rect.top;
          const norm = this.screenToNorm(midX, midY, this.zoom);
          this.pinchWorldX = norm.x;
          this.pinchWorldY = norm.y;
          return;
        }

        const t = e.touches[0];
        const x = t.clientX - rect.left;
        const y = t.clientY - rect.top;

        this.isPinching = false;
        this.isPanning = true;
        this.panMoved = false;
        this.panStartX = x;
        this.panStartY = y;
        this.lastPointerX = x;
        this.lastPointerY = y;
        this.panStartTime = performance.now();
        this.velocitySamples = [{ x, y, t: this.panStartTime }];
      },
      { passive: false }
    );

    this.canvas.addEventListener(
      'touchmove',
      (e) => {
        e.preventDefault();
        const rect = this.canvas.getBoundingClientRect();

        if (e.touches.length >= 2) {
          const t0 = e.touches[0];
          const t1 = e.touches[1];
          const dx = t1.clientX - t0.clientX;
          const dy = t1.clientY - t0.clientY;
          const dist = Math.max(10, Math.hypot(dx, dy));

          if (!this.isPinching) {
            this.isPinching = true;
            this.isPanning = false;
            this.pinchInitialDist = dist;
            this.pinchInitialZoom = this.zoom;
            const midX = (t0.clientX + t1.clientX) / 2 - rect.left;
            const midY = (t0.clientY + t1.clientY) / 2 - rect.top;
            const norm = this.screenToNorm(midX, midY, this.zoom);
            this.pinchWorldX = norm.x;
            this.pinchWorldY = norm.y;
            return;
          }

          const midX = (t0.clientX + t1.clientX) / 2 - rect.left;
          const midY = (t0.clientY + t1.clientY) / 2 - rect.top;
          const nextZoom = this.clampZoom(
            this.pinchInitialZoom + Math.log2(dist / this.pinchInitialDist)
          );
          const worldSize = this.worldPixelSize(nextZoom);
          const nextCenterX = this.pinchWorldX - (midX - this.width / 2) / worldSize;
          const nextCenterY = Math.max(
            0.05,
            Math.min(0.95, this.pinchWorldY - (midY - this.height / 2) / worldSize)
          );
          const nextCenter = this.normToLatLng(nextCenterX, nextCenterY);
          this.zoom = nextZoom;
          this.centerLat = nextCenter.lat;
          this.centerLng = nextCenter.lng;
          this.requestDraw();
          return;
        }

        if (this.isPanning && e.touches.length === 1) {
          const t = e.touches[0];
          const x = t.clientX - rect.left;
          const y = t.clientY - rect.top;
          const dx = x - this.lastPointerX;
          const dy = y - this.lastPointerY;

          if (Math.hypot(x - this.panStartX, y - this.panStartY) > 7) {
            this.panMoved = true;
          }

          this.panByPixels(dx, dy);
          this.lastPointerX = x;
          this.lastPointerY = y;

          const now = performance.now();
          this.velocitySamples.push({ x, y, t: now });
          if (this.velocitySamples.length > 6) {
            this.velocitySamples.shift();
          }
          this.requestDraw();
        }
      },
      { passive: false }
    );

    this.canvas.addEventListener('touchend', (e) => {
      if (e.touches.length === 1 && this.isPinching) {
        // Transición limpia de 2 dedos a 1 dedo sin saltos
        const rect = this.canvas.getBoundingClientRect();
        const t = e.touches[0];
        this.isPinching = false;
        this.isPanning = true;
        this.panMoved = true;
        this.lastPointerX = t.clientX - rect.left;
        this.lastPointerY = t.clientY - rect.top;
        this.velocitySamples = [];
        return;
      }

      if (e.touches.length === 0) {
        const wasPinching = this.isPinching;
        this.isPinching = false;

        if (!wasPinching && this.isPanning) {
          this.isPanning = false;
          const now = performance.now();

          if (!this.panMoved && now - this.panStartTime < 280) {
            const hit = this.hitTestStation(this.panStartX, this.panStartY);
            if (hit) {
              this.onSelectStation(hit);
              return;
            }
            if (
              now - this.lastTapTime < 310 &&
              Math.hypot(this.panStartX - this.lastTapX, this.panStartY - this.lastTapY) < 40
            ) {
              this.lastTapTime = 0;
              this.animateDoubleTapZoom(this.panStartX, this.panStartY);
              return;
            }
            this.lastTapTime = now;
            this.lastTapX = this.panStartX;
            this.lastTapY = this.panStartY;
            return;
          }

          const v = this.computeReleaseVelocity(now);
          this.startInertia(v.vx, v.vy);
        }
      }
    });

    // Mouse / Desktop events
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      this.stopAnimations();
      this.onMapInteract();
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      this.isPanning = true;
      this.panMoved = false;
      this.panStartX = x;
      this.panStartY = y;
      this.lastPointerX = x;
      this.lastPointerY = y;
      this.panStartTime = performance.now();
      this.velocitySamples = [{ x, y, t: this.panStartTime }];
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isPanning) return;
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const dx = x - this.lastPointerX;
      const dy = y - this.lastPointerY;
      if (Math.hypot(x - this.panStartX, y - this.panStartY) > 5) {
        this.panMoved = true;
      }
      this.panByPixels(dx, dy);
      this.lastPointerX = x;
      this.lastPointerY = y;
      const now = performance.now();
      this.velocitySamples.push({ x, y, t: now });
      if (this.velocitySamples.length > 6) this.velocitySamples.shift();
      this.requestDraw();
    });

    window.addEventListener('mouseup', (e) => {
      if (!this.isPanning) return;
      this.isPanning = false;
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const now = performance.now();

      if (!this.panMoved) {
        const hit = this.hitTestStation(x, y);
        if (hit) {
          this.onSelectStation(hit);
          return;
        }
      } else {
        const v = this.computeReleaseVelocity(now);
        this.startInertia(v.vx, v.vy);
      }
    });

    this.canvas.addEventListener('dblclick', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = this.hitTestStation(x, y);
      if (!hit) {
        this.animateDoubleTapZoom(x, y);
      }
    });

    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.stopAnimations();
        this.onMapInteract();
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const delta = -e.deltaY * 0.0022;
        this.zoomAroundPoint(this.zoom + delta, x, y);
        this.requestDraw();
      },
      { passive: false }
    );
  }

  private computeReleaseVelocity(now: number): { vx: number; vy: number } {
    const recent = this.velocitySamples.filter((s) => now - s.t < 110);
    if (recent.length < 2) return { vx: 0, vy: 0 };
    const first = recent[0];
    const last = recent[recent.length - 1];
    const dt = Math.max(12, last.t - first.t);
    return {
      vx: (last.x - first.x) / dt,
      vy: (last.y - first.y) / dt,
    };
  }

  private hitTestStation(sx: number, sy: number): Station | null {
    let best: Station | null = null;
    let bestDist = 30; // Radio generoso (~60px área táctil)

    for (const s of this.stations) {
      const pos = this.latLngToScreen(s.lat, s.lng);
      if (
        pos.x < -30 ||
        pos.x > this.width + 30 ||
        pos.y < -30 ||
        pos.y > this.height + 30
      ) {
        continue;
      }
      const d = Math.hypot(pos.x - sx, pos.y - sy);
      if (d <= bestDist) {
        bestDist = d;
        best = s;
      }
    }
    return best;
  }

  private getTileUrl(z: number, x: number, y: number): string {
    const subdomains = ['a', 'b', 'c', 'd'];
    const sub = subdomains[Math.abs(x + y) % subdomains.length];
    const style = this.isDark ? 'dark_all' : 'voyager';
    const retina = this.dpr > 1.25 ? '@2x' : '';
    const keyParam = this.cartoApiKey
      ? `?key=${encodeURIComponent(this.cartoApiKey)}`
      : '';
    return `https://${sub}.basemaps.cartocdn.com/rastertiles/${style}/${z}/${x}/${y}${retina}.png${keyParam}`;
  }

  private getTile(z: number, x: number, y: number): TileEntry {
    const key = `${this.isDark ? 'd' : 'l'}:${z}/${x}/${y}`;
    const existing = this.tiles.get(key);
    if (existing) {
      existing.lastUsed = performance.now();
      return existing;
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';
    const entry: TileEntry = {
      img,
      loaded: false,
      failed: false,
      lastUsed: performance.now(),
    };

    img.onload = () => {
      entry.loaded = true;
      this.requestDraw();
    };
    img.onerror = () => {
      entry.failed = true;
    };
    img.src = this.getTileUrl(z, x, y);

    this.tiles.set(key, entry);
    if (this.tiles.size > MAX_TILE_CACHE) {
      this.pruneTiles();
    }
    return entry;
  }

  private pruneTiles(): void {
    const entries = [...this.tiles.entries()].sort(
      (a, b) => a[1].lastUsed - b[1].lastUsed
    );
    const toDelete = entries.length - MAX_TILE_CACHE + 30;
    for (let i = 0; i < toDelete && i < entries.length; i++) {
      this.tiles.delete(entries[i][0]);
    }
  }

  private requestDraw(): void {
    if (this.rafScheduled) return;
    this.rafScheduled = true;
    requestAnimationFrame(() => {
      this.rafScheduled = false;
      this.draw();
    });
  }

  private getMarkerColor(price: number): { fill: string; text: string } {
    if (this.isDark) {
      if (price <= this.p30) return { fill: '#34d399', text: '#052e16' }; // Verde pastel
      if (price <= this.p55) return { fill: '#7dd3fc', text: '#082f49' }; // Azul pastel
      if (price <= this.p75) return { fill: '#fcd34d', text: '#451a03' }; // Ámbar pastel
      return { fill: '#fda4af', text: '#4c0519' }; // Rojo pastel
    }
    if (price <= this.p30) return { fill: '#059669', text: '#ffffff' }; // Verde
    if (price <= this.p55) return { fill: '#0284c7', text: '#ffffff' }; // Azul
    if (price <= this.p75) return { fill: '#d97706', text: '#ffffff' }; // Ámbar
    return { fill: '#e11d48', text: '#ffffff' }; // Rojo
  }

  private draw(): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    // Fondo base antes de teselas
    ctx.fillStyle = this.isDark ? '#141d21' : '#eae6df';
    ctx.fillRect(0, 0, this.width, this.height);

    // 1. Dibujar teselas CartoDB
    const tileZoom = Math.max(0, Math.min(18, Math.round(this.zoom)));
    const scaleFactor = Math.pow(2, this.zoom - tileZoom);
    const scaledTileSize = TILE_SIZE * scaleFactor;
    const totalTiles = Math.pow(2, tileZoom);

    const centerNorm = this.latLngToNorm(this.centerLat, this.centerLng);
    const worldCenterX = centerNorm.x * totalTiles * scaledTileSize;
    const worldCenterY = centerNorm.y * totalTiles * scaledTileSize;
    const originX = this.width / 2 - worldCenterX;
    const originY = this.height / 2 - worldCenterY;

    const minTileX = Math.floor(-originX / scaledTileSize) - 1;
    const maxTileX = Math.floor((this.width - originX) / scaledTileSize) + 1;
    const minTileY = Math.max(0, Math.floor(-originY / scaledTileSize) - 1);
    const maxTileY = Math.min(
      totalTiles - 1,
      Math.floor((this.height - originY) / scaledTileSize) + 1
    );

    if (this.isDark) {
      ctx.filter = 'brightness(1.18) contrast(0.90) saturate(1.12)';
    }

    for (let ty = minTileY; ty <= maxTileY; ty++) {
      for (let tx = minTileX; tx <= maxTileX; tx++) {
        const wrappedX = ((tx % totalTiles) + totalTiles) % totalTiles;
        const dx = originX + tx * scaledTileSize;
        const dy = originY + ty * scaledTileSize;
        const tile = this.getTile(tileZoom, wrappedX, ty);

        if (tile.loaded) {
          ctx.drawImage(
            tile.img,
            dx,
            dy,
            scaledTileSize + 0.6,
            scaledTileSize + 0.6
          );
        } else if (tileZoom > 2) {
          // Fallback suave desde tesela padre si ya está cacheada
          const parentZ = tileZoom - 1;
          const parentX = Math.floor(wrappedX / 2);
          const parentY = Math.floor(ty / 2);
          const parentKey = `${this.isDark ? 'd' : 'l'}:${parentZ}/${parentX}/${parentY}`;
          const parent = this.tiles.get(parentKey);
          if (parent?.loaded) {
            const subX = (wrappedX % 2) * (parent.img.width / 2);
            const subY = (ty % 2) * (parent.img.height / 2);
            ctx.drawImage(
              parent.img,
              subX,
              subY,
              parent.img.width / 2,
              parent.img.height / 2,
              dx,
              dy,
              scaledTileSize + 0.6,
              scaledTileSize + 0.6
            );
          }
        }
      }
    }

    ctx.filter = 'none';

    // Suavizado pastel para Dark Matter en modo oscuro
    if (this.isDark) {
      ctx.fillStyle = 'rgba(24, 38, 44, 0.22)';
      ctx.fillRect(0, 0, this.width, this.height);
    }

    // 2. Ubicación GPS del usuario
    if (this.userLocation) {
      const up = this.latLngToScreen(this.userLocation.lat, this.userLocation.lng);
      if (up.x >= -40 && up.x <= this.width + 40 && up.y >= -40 && up.y <= this.height + 40) {
        ctx.beginPath();
        ctx.arc(up.x, up.y, 18, 0, Math.PI * 2);
        ctx.fillStyle = this.isDark
          ? 'rgba(52, 211, 153, 0.22)'
          : 'rgba(16, 185, 129, 0.22)';
        ctx.fill();

        ctx.beginPath();
        ctx.arc(up.x, up.y, 7.5, 0, Math.PI * 2);
        ctx.fillStyle = this.isDark ? '#34d399' : '#059669';
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }
    }

    // 3. Estaciones visibles en pantalla
    const visible: Array<{
      station: Station;
      x: number;
      y: number;
      price: number;
      isFav: boolean;
      isSelected: boolean;
    }> = [];

    for (const st of this.stations) {
      const price = st.prices[this.activeFuel];
      if (typeof price !== 'number' || price <= 0) continue;
      const pos = this.latLngToScreen(st.lat, st.lng);
      if (
        pos.x < -36 ||
        pos.x > this.width + 36 ||
        pos.y < -36 ||
        pos.y > this.height + 36
      ) {
        continue;
      }
      visible.push({
        station: st,
        x: pos.x,
        y: pos.y,
        price,
        isFav: this.favoriteIds.has(st.id),
        isSelected: st.id === this.selectedId,
      });
    }

    // Ordenar para dibujar primero caras, luego baratas, favoritas y seleccionada arriba
    visible.sort((a, b) => {
      if (a.isSelected !== b.isSelected) return a.isSelected ? 1 : -1;
      if (a.isFav !== b.isFav) return a.isFav ? 1 : -1;
      return b.price - a.price;
    });

    const dotRadius =
      this.zoom >= 13 ? 10.5 : this.zoom >= 11 ? 9 : this.zoom >= 9.5 ? 7.5 : 6;

    // Dibujar puntos de gasolineras grandes y legibles
    for (const item of visible) {
      const color = this.getMarkerColor(item.price);
      const r = item.isSelected ? dotRadius + 3.5 : item.isFav ? dotRadius + 1.5 : dotRadius;

      // Sombra sutil
      ctx.beginPath();
      ctx.arc(item.x, item.y + 1.5, r + 1.5, 0, Math.PI * 2);
      ctx.fillStyle = this.isDark ? 'rgba(0,0,0,0.45)' : 'rgba(15,23,42,0.18)';
      ctx.fill();

      // Halo exterior si está seleccionada
      if (item.isSelected) {
        ctx.beginPath();
        ctx.arc(item.x, item.y, r + 6, 0, Math.PI * 2);
        ctx.fillStyle = this.isDark
          ? 'rgba(248, 250, 252, 0.25)'
          : 'rgba(15, 23, 42, 0.18)';
        ctx.fill();
      }

      // Círculo principal
      ctx.beginPath();
      ctx.arc(item.x, item.y, r, 0, Math.PI * 2);
      ctx.fillStyle = color.fill;
      ctx.fill();
      ctx.lineWidth = item.isSelected ? 3 : 2;
      ctx.strokeStyle = item.isSelected
        ? this.isDark
          ? '#ffffff'
          : '#0f172a'
        : this.isDark
          ? '#0b1311'
          : '#ffffff';
      ctx.stroke();

      // Marca interior si es favorita
      if (item.isFav) {
        ctx.beginPath();
        ctx.arc(item.x, item.y, Math.max(2.6, r * 0.34), 0, Math.PI * 2);
        ctx.fillStyle = color.text;
        ctx.fill();
      }
    }

    // 4. Etiquetas de precio junto al punto al hacer zoom (sin solapamientos)
    const showZoomLabels = this.zoom >= 11.4;
    if (showZoomLabels || this.selectedId || this.favoriteIds.size > 0) {
      const labelCandidates = visible
        .filter(
          (v) =>
            v.isSelected ||
            (v.isFav && this.zoom >= 9.6) ||
            showZoomLabels
        )
        .sort((a, b) => {
          if (a.isSelected !== b.isSelected) return a.isSelected ? -1 : 1;
          if (a.isFav !== b.isFav) return a.isFav ? -1 : 1;
          return a.price - b.price;
        });

      const occupied: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
      ctx.font = '600 11.5px "JetBrains Mono", monospace';
      ctx.textBaseline = 'middle';

      for (const item of labelCandidates) {
        const text = formatShortPrice(item.price);
        const textWidth = ctx.measureText(text).width;
        const boxW = textWidth + 12;
        const boxH = 22;
        const r = item.isSelected ? dotRadius + 3.5 : dotRadius;
        const bx = Math.round(item.x + r + 5);
        const by = Math.round(item.y - boxH / 2);

        if (bx + boxW > this.width - 8 || by < 8 || by + boxH > this.height - 8) {
          continue;
        }

        const collides = occupied.some(
          (o) => !(bx + boxW + 4 < o.x1 || bx - 4 > o.x2 || by + boxH + 3 < o.y1 || by - 3 > o.y2)
        );
        if (collides && !item.isSelected) continue;

        occupied.push({ x1: bx, y1: by, x2: bx + boxW, y2: by + boxH });

        const color = this.getMarkerColor(item.price);
        this.drawRoundedRect(ctx, bx, by, boxW, boxH, 7);
        ctx.fillStyle = item.isSelected
          ? this.isDark
            ? '#f8fafc'
            : '#0f172a'
          : this.isDark
            ? 'rgba(17, 26, 29, 0.92)'
            : 'rgba(255, 255, 255, 0.95)';
        ctx.fill();

        ctx.lineWidth = 1.25;
        ctx.strokeStyle = item.isSelected
          ? color.fill
          : this.isDark
            ? 'rgba(255,255,255,0.16)'
            : 'rgba(15,23,42,0.12)';
        ctx.stroke();

        ctx.fillStyle = item.isSelected
          ? this.isDark
            ? '#0f172a'
            : '#ffffff'
          : this.isDark
            ? color.fill
            : '#0f172a';
        ctx.fillText(text, bx + 6, by + boxH / 2 + 0.5);
      }
    }

    // Atribución discreta abajo a la derecha (requerida por CartoDB)
    ctx.font = '500 10px "Plus Jakarta Sans", sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = this.isDark
      ? 'rgba(226, 232, 240, 0.45)'
      : 'rgba(15, 23, 42, 0.45)';
    ctx.fillText('© CARTO © OpenStreetMap', 10, this.height - 8);

    ctx.restore();
  }

  private drawRoundedRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number
  ): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
}
