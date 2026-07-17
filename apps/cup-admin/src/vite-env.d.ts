/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PHUB_API_URL?: string;
  readonly VITE_PHUB_TENANT_KEY?: string;
  readonly VITE_PHUB_APP_VERSION?: string;
  readonly VITE_PHUB_APP_BUILD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
