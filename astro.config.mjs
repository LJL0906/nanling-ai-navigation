import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import icon from 'astro-icon';

export default defineConfig({
  site: 'https://nav.ljianl.com',
  compressHTML: true,
  server: { host: '0.0.0.0' },
  // 不配置 include：astro-icon 只内联实际用到的图标，避免打包整套图标集
  integrations: [icon()],
  vite: { plugins: [tailwindcss()] },
});
