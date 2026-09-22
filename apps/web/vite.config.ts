import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * 商户网页后台构建配置。
 *
 * 与小程序端刻意**不共用**一份配置：uni-app 的产物形态、样式单位、组件注册方式
 * 都和浏览器端不同，硬凑一个配置只会两边都别扭。共用的只有 Token（@snack/tokens）。
 *
 * 接口基址默认是**同源相对路径**（''）—— 生产由 Nginx 把 /api 与 /t 反代到服务端。
 * 这样产物里不会写死任何域名，换环境只需改 Nginx；这也是 check-build 那条
 * 「产物里不许出现本机地址」的守卫在网页端天然成立的原因。
 */
export default defineConfig({
  plugins: [vue()],
  /**
   * 部署基址。默认 `/`（独立域名 / 根目录）。
   * 若挂在子路径下（如 `/admin/`），构建时传 `VITE_BASE=/admin/` —— 它与路由的
   * `createWebHistory(import.meta.env.BASE_URL)` 是同一个值，两边必须一致，
   * 否则静态资源路径对了但路由不对（刷新子页面 404），或反过来。
   */
  base: process.env.VITE_BASE ?? '/',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5181,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/t': { target: 'http://127.0.0.1:3000', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 900,
  },
});
