/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BASE_PATH?: string;
  readonly VITE_CARTODB_API_KEY?: string;
  readonly VITE_FUEL_PROXY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
