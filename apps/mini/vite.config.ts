import { defineConfig } from 'vite';
import uni from '@dcloudio/vite-plugin-uni';

export default defineConfig({
  plugins: [uni()],
  css: {
    // 小程序端不需要浏览器前缀，H5 端交由 uni 内置的 postcss 处理
    postcss: {},
  },
});
