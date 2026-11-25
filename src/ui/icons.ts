export const BRAND_LOGO_SVG = `
<svg viewBox="0 0 64 64" fill="none" class="h-8 w-8" aria-hidden="true">
  <rect width="64" height="64" rx="16" fill="#064E3B"/>
  <path d="M32 10C21.5066 10 13 18.5066 13 29C13 41.3 28.4 53.1 31.1 55.1C31.63 55.49 32.37 55.49 32.9 55.1C35.6 53.1 51 41.3 51 29C51 18.5066 42.4934 10 32 10Z" fill="#F8FAFC"/>
  <path d="M32 15.5C24.5442 15.5 18.5 21.5442 18.5 29C18.5 34.4 22.8 40.9 27.2 45.6C25.3 42.4 24.2 38.9 24.2 35.6C24.2 28.8 29.8 22.5 32 19.8C34.2 22.5 39.8 28.8 39.8 35.6C39.8 38.9 38.7 42.4 36.8 45.6C41.2 40.9 45.5 34.4 45.5 29C45.5 21.5442 39.4558 15.5 32 15.5Z" fill="#064E3B"/>
  <path d="M32 22.8C29.8 26.2 26.2 31.1 26.2 35.6C26.2 39.2 28.8 42.1 32 42.1C35.2 42.1 37.8 39.2 37.8 35.6C37.8 31.1 34.2 26.2 32 22.8Z" fill="#34D399"/>
</svg>`;

export function iconSvg(
  name:
    | 'compass'
    | 'award'
    | 'star'
    | 'star-filled'
    | 'sun'
    | 'moon'
    | 'locate'
    | 'chevron-down'
    | 'chevron-right'
    | 'arrow-left'
    | 'map-pin'
    | 'clock'
    | 'navigation'
    | 'share'
    | 'copy'
    | 'check'
    | 'search'
    | 'download'
    | 'refresh'
    | 'trash'
    | 'x',
  cls = 'w-5 h-5'
): string {
  const paths: Record<string, string> = {
    compass:
      '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
    award:
      '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
    star:
      '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    'star-filled':
      '<polygon fill="currentColor" points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    locate:
      '<line x1="2" x2="5" y1="12" y2="12"/><line x1="19" x2="22" y1="12" y2="12"/><line x1="12" x2="12" y1="2" y2="5"/><line x1="12" x2="12" y1="19" y2="22"/><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
    'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    'map-pin':
      '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
    clock:
      '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    navigation: '<polygon points="3 11 22 2 13 21 11 13 3 11"/>',
    share:
      '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    search:
      '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    download:
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
    refresh:
      '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    trash:
      '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  };

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="${cls}" aria-hidden="true">${paths[name] || ''}</svg>`;
}
