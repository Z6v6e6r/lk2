/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PHUB_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  readonly __PHUB_BOOTSTRAP__?: {
    readonly tenantKey: string;
    readonly release: string;
    readonly apiBaseUrl?: string;
  };
}
