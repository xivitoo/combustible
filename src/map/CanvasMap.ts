import { formatShortPrice } from '../data/provinces';
import type { PrimaryFuelKey, Station } from '../types';

export interface CanvasMapOptions {
  canvas: HTMLCanvasElement;
  onSelectStation: (station: Station) => void;
  onMapInteract: () => void;
  paused?: boolean;
}

interface TileEntry {
  img: HTMLImageElement;
  loaded: boolean;
  failed: boolean;
  lastUsed: number;
}

interface PreparedMarker {
  station: Station;
  normX: number;
  normY: number;
  price: number;
  label: string;
}

const TILE_SIZE = 256;
const MIN_ZOOM = 5.4;
const MAX_ZOOM = 18.2;
const MAX_TILE_CACHE = 320;

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
  private paused = false;

  private preparedMarkers: PreparedMarker[] = [];
  private activeFuel: PrimaryFuelKey = 'g95';
  private selectedId: string | null = null;
  private favoriteIds = new Set<string>();
  private userLocation: { lat: number; lng: number } | null = null;

  private p30 = 0;
  private p55 = 0;
  private p75 = 0;

  private tiles = new Map<string, TileEntry>();
  private drawnLabelHits: Array<{
    station: Station;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  }> = [];
  private rafScheduled = false;
  private animFrameId: number | null = null;

  // Estado de gestos
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
    this.paused = Boolean(options.paused);

    this.resize();
    this.bindEvents();
  }

  public setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (!paused) {
      this.requestDraw();
    }
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
      this.animateTo(lat, lng, zoom ?? this.zoom, 300);
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

  public zoomIn(): void {
    this.animateTo(this.centerLat, this.centerLng, this.zoom + 1.1, 200);
  }

  public zoomOut(): void {
    this.animateTo(this.centerLat, this.centerLng, this.zoom - 1.1, 200);
  }

  public setData(
    stations: Station[],
    activeFuel: PrimaryFuelKey,
    selectedId: string | null,
    favoriteIds: Set<string>
  ): void {
    this.activeFuel = activeFuel;
    this.selectedId = selectedId;
    this.favoriteIds = favoriteIds;

    const prepared: PreparedMarker[] = [];
    const prices: number[] = [];

    for (const s of stations) {
      const p = s.prices[activeFuel];
      if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) continue;
      const norm = this.latLngToNorm(s.lat, s.lng);
      prepared.push({
        station: s,
        normX: norm.x,
        normY: norm.y,
        price: p,
        label: formatShortPrice(p),
      });
      prices.push(p);
    }

    // Ordenar de más baratas a más caras para que el culling espacial priorice las más baratas
    prepared.sort((a, b) => a.price - b.price);
    this.preparedMarkers = prepared;

    if (prices.length > 0) {
      prices.sort((a, b) => a - b);
      this.p30 = prices[Math.floor((prices.length - 1) * 0.28)];
      this.p55 = prices[Math.floor((prices.length - 1) * 0.55)];
      this.p75 = prices[Math.floor((prices.length - 1) * 0.78)];
    } else {
      this.p30 = this.p55 = this.p75 = 0;
    }

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

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, rect.width || window.innerWidth);
    this.height = Math.max(1, rect.height || window.innerHeight);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
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
    const durationMs = 220;

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
      curVx *= 0.91;
      curVy *= 0.91;
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

    // Gestos táctiles nativos (pinch + pan + doble toque)
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

          if (Math.hypot(x - this.panStartX, y - this.panStartY) > 12) {
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

          if (!this.panMoved && now - this.panStartTime < 450) {
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

    // Eventos de ratón en escritorio
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
      if (Math.hypot(x - this.panStartX, y - this.panStartY) > 8) {
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
        const clampedDelta = Math.max(-140, Math.min(140, e.deltaY));
        const delta = -clampedDelta * 0.0024;
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
    // 1. Comprobar primero si se pulsó directamente sobre una etiqueta de precio visible
    for (const label of this.drawnLabelHits) {
      if (
        sx >= label.x1 - 4 &&
        sx <= label.x2 + 4 &&
        sy >= label.y1 - 4 &&
        sy <= label.y2 + 4
      ) {
        return label.station;
      }
    }

    // 2. Comprobar puntos de estaciones cercanos
    const worldSize = this.worldPixelSize(this.zoom);
    const centerNorm = this.latLngToNorm(this.centerLat, this.centerLng);
    const halfW = this.width / 2;
    const halfH = this.height / 2;

    let best: Station | null = null;
    let bestDist = 34;

    for (const m of this.preparedMarkers) {
      const px = halfW + (m.normX - centerNorm.x) * worldSize;
      const py = halfH + (m.normY - centerNorm.y) * worldSize;
      if (px < -34 || px > this.width + 34 || py < -34 || py > this.height + 34) {
        continue;
      }
      const d = Math.hypot(px - sx, py - sy);
      if (d <= bestDist) {
        bestDist = d;
        best = m.station;
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
    const toDelete = entries.length - MAX_TILE_CACHE + 40;
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
      // Tonos pastel suaves para modo oscuro
      if (price <= this.p30) return { fill: '#6ee7b7', text: '#064e3b' }; // Menta pastel
      if (price <= this.p55) return { fill: '#93c5fd', text: '#1e3a8a' }; // Azul cielo pastel
      if (price <= this.p75) return { fill: '#fde68a', text: '#78350f' }; // Ámbar pastel
      return { fill: '#fda4af', text: '#881337' }; // Rosa coral pastel
    }
    if (price <= this.p30) return { fill: '#059669', text: '#ffffff' };
    if (price <= this.p55) return { fill: '#0284c7', text: '#ffffff' };
    if (price <= this.p75) return { fill: '#d97706', text: '#ffffff' };
    return { fill: '#e11d48', text: '#ffffff' };
  }

  private drawTileWithFallback(
    ctx: CanvasRenderingContext2D,
    tileZoom: number,
    wrappedX: number,
    ty: number,
    dx: number,
    dy: number,
    size: number
  ): void {
    const tile = this.getTile(tileZoom, wrappedX, ty);
    if (tile.loaded) {
      ctx.drawImage(tile.img, dx, dy, size + 0.75, size + 0.75);
      return;
    }

    // Buscar hasta 3 niveles padre cacheados para evitar cuadros vacíos durante zoom/pan rápido
    for (let step = 1; step <= 3; step++) {
      const parentZ = tileZoom - step;
      if (parentZ < 2) break;
      const factor = 1 << step;
      const parentX = Math.floor(wrappedX / factor);
      const parentY = Math.floor(ty / factor);
      const parentKey = `${this.isDark ? 'd' : 'l'}:${parentZ}/${parentX}/${parentY}`;
      const parent = this.tiles.get(parentKey);
      if (parent?.loaded) {
        const subW = parent.img.width / factor;
        const subH = parent.img.height / factor;
        const sx = (wrappedX % factor) * subW;
        const sy = (ty % factor) * subH;
        ctx.drawImage(parent.img, sx, sy, subW, subH, dx, dy, size + 0.75, size + 0.75);
        return;
      }
    }
  }

  private draw(): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);

    // Fondo suave (pastel oscuro o neutro Voyager)
    ctx.fillStyle = this.isDark ? '#252d3d' : '#eae6df';
    ctx.fillRect(0, 0, this.width, this.height);

    if (this.paused) {
      ctx.restore();
      return;
    }

    // 1. Teselas CartoDB sin ctx.filter (máximo rendimiento 60fps)
    const tileZoom = Math.max(0, Math.min(18, Math.floor(this.zoom + 0.15)));
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

    for (let ty = minTileY; ty <= maxTileY; ty++) {
      for (let tx = minTileX; tx <= maxTileX; tx++) {
        const wrappedX = ((tx % totalTiles) + totalTiles) % totalTiles;
        const dx = originX + tx * scaledTileSize;
        const dy = originY + ty * scaledTileSize;
        this.drawTileWithFallback(ctx, tileZoom, wrappedX, ty, dx, dy, scaledTileSize);
      }
    }

    // Baño pastel suave en modo oscuro mediante un único rectángulo compuesto (60fps)
    if (this.isDark) {
      ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = 'rgba(72, 88, 118, 0.28)';
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.globalCompositeOperation = 'source-over';
    }

    const worldSize = this.worldPixelSize(this.zoom);
    const halfW = this.width / 2;
    const halfH = this.height / 2;

    // 2. Ubicación GPS del usuario
    if (this.userLocation) {
      const un = this.latLngToNorm(this.userLocation.lat, this.userLocation.lng);
      const ux = halfW + (un.x - centerNorm.x) * worldSize;
      const uy = halfH + (un.y - centerNorm.y) * worldSize;
      if (ux >= -40 && ux <= this.width + 40 && uy >= -40 && uy <= this.height + 40) {
        ctx.beginPath();
        ctx.arc(ux, uy, 17, 0, Math.PI * 2);
        ctx.fillStyle = this.isDark
          ? 'rgba(110, 231, 183, 0.25)'
          : 'rgba(16, 185, 129, 0.22)';
        ctx.fill();

        ctx.beginPath();
        ctx.arc(ux, uy, 7.5, 0, Math.PI * 2);
        ctx.fillStyle = this.isDark ? '#6ee7b7' : '#059669';
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }
    }

    // 3. Estaciones visibles (culling espacial en zoom lejano para fluidez total)
    const visible: Array<{
      marker: PreparedMarker;
      x: number;
      y: number;
      isFav: boolean;
      isSelected: boolean;
    }> = [];

    const useGridCull = this.zoom < 11.2;
    const cellSize = 18;
    const seenCells = useGridCull ? new Set<number>() : null;

    // preparedMarkers ya viene ordenado de más baratas a más caras
    for (const m of this.preparedMarkers) {
      const px = halfW + (m.normX - centerNorm.x) * worldSize;
      const py = halfH + (m.normY - centerNorm.y) * worldSize;
      if (px < -32 || px > this.width + 32 || py < -32 || py > this.height + 32) {
        continue;
      }

      const isSelected = m.station.id === this.selectedId;
      const isFav = this.favoriteIds.has(m.station.id);

      if (seenCells && !isSelected && !isFav) {
        const cx = Math.floor(px / cellSize);
        const cy = Math.floor(py / cellSize);
        const key = (cx + 1000) * 10000 + (cy + 1000);
        if (seenCells.has(key)) continue;
        seenCells.add(key);
      }

      visible.push({ marker: m, x: px, y: py, isFav, isSelected });
    }

    // Dibujar primero caras, luego baratas, favoritas y seleccionada al final
    visible.sort((a, b) => {
      if (a.isSelected !== b.isSelected) return a.isSelected ? 1 : -1;
      if (a.isFav !== b.isFav) return a.isFav ? 1 : -1;
      return b.marker.price - a.marker.price;
    });

    const dotRadius =
      this.zoom >= 13 ? 10.5 : this.zoom >= 11 ? 9 : this.zoom >= 9.5 ? 7.5 : 6.5;

    for (const item of visible) {
      const color = this.getMarkerColor(item.marker.price);
      const r = item.isSelected ? dotRadius + 3.5 : item.isFav ? dotRadius + 1.5 : dotRadius;

      if (item.isSelected) {
        ctx.beginPath();
        ctx.arc(item.x, item.y, r + 6, 0, Math.PI * 2);
        ctx.fillStyle = this.isDark
          ? 'rgba(248, 250, 252, 0.25)'
          : 'rgba(15, 23, 42, 0.16)';
        ctx.fill();
      }

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
          ? '#222938'
          : '#ffffff';
      ctx.stroke();

      if (item.isFav) {
        ctx.beginPath();
        ctx.arc(item.x, item.y, Math.max(2.6, r * 0.34), 0, Math.PI * 2);
        ctx.fillStyle = color.text;
        ctx.fill();
      }
    }

    // 4. Etiquetas de precio junto al punto al hacer zoom (con anti-solapamiento)
    this.drawnLabelHits = [];
    const showZoomLabels = this.zoom >= 11.4;
    if (showZoomLabels || this.selectedId || this.favoriteIds.size > 0) {
      const labelCandidates = visible
        .filter(
          (v) => v.isSelected || (v.isFav && this.zoom >= 9.5) || showZoomLabels
        )
        .sort((a, b) => {
          if (a.isSelected !== b.isSelected) return a.isSelected ? -1 : 1;
          if (a.isFav !== b.isFav) return a.isFav ? -1 : 1;
          return a.marker.price - b.marker.price;
        });

      const occupied: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
      ctx.font = '600 11.5px "JetBrains Mono", monospace';
      ctx.textBaseline = 'middle';

      let drawnLabels = 0;
      for (const item of labelCandidates) {
        if (drawnLabels >= 38 && !item.isSelected && !item.isFav) break;

        const text = item.marker.label;
        const boxW = text.length * 7.2 + 12;
        const boxH = 22;
        const r = item.isSelected ? dotRadius + 3.5 : dotRadius;
        const bx = Math.round(item.x + r + 5);
        const by = Math.round(item.y - boxH / 2);

        if (bx + boxW > this.width - 8 || by < 8 || by + boxH > this.height - 8) {
          continue;
        }

        const collides = occupied.some(
          (o) =>
            !(
              bx + boxW + 4 < o.x1 ||
              bx - 4 > o.x2 ||
              by + boxH + 3 < o.y1 ||
              by - 3 > o.y2
            )
        );
        if (collides && !item.isSelected) continue;

        occupied.push({ x1: bx, y1: by, x2: bx + boxW, y2: by + boxH });
        this.drawnLabelHits.push({
          station: item.marker.station,
          x1: bx,
          y1: by,
          x2: bx + boxW,
          y2: by + boxH,
        });
        drawnLabels++;

        const color = this.getMarkerColor(item.marker.price);
        this.drawRoundedRect(ctx, bx, by, boxW, boxH, 7);
        ctx.fillStyle = item.isSelected
          ? this.isDark
            ? '#f8fafc'
            : '#0f172a'
          : this.isDark
            ? 'rgba(34, 41, 56, 0.94)'
            : 'rgba(255, 255, 255, 0.95)';
        ctx.fill();

        ctx.lineWidth = 1.25;
        ctx.strokeStyle = item.isSelected
          ? color.fill
          : this.isDark
            ? 'rgba(255,255,255,0.18)'
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

    // Atribución discreta abajo a la izquierda
    ctx.font = '500 10px "Plus Jakarta Sans", sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = this.isDark
      ? 'rgba(226, 232, 240, 0.52)'
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
