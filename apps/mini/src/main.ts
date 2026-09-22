import { createSSRApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';

// uni-app 约定的入口：必须导出 createApp()，小程序 / H5 两端都走这里
export function createApp() {
  const app = createSSRApp(App);
  app.use(createPinia());
  return { app };
}
