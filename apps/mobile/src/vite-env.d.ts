/// <reference types="vite/client" />
import '../../web/src/vite-env.js';

declare global {
  interface ImportMetaEnv {
    readonly VITE_APP_VERSION?: string;
    readonly VITE_PHUB_TENANT_KEY?: string;
  }
}
