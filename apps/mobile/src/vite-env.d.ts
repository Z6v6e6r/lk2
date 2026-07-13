/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_VERSION?: string;
  readonly VITE_PHUB_API_BASE_URL?: string;
  readonly VITE_PHUB_TENANT_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
