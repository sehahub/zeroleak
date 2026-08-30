import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://zeroleak.workers.dev',
  build: { inlineStylesheets: 'auto' },
  vite: {
    build: { target: 'es2022' },
  },
});
