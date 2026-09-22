/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 接口基址。留空 = 同源（生产由 Nginx 反代）；本地开发走 Vite proxy 到 3000 */
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
