import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    target: 'es2019',
    rollupOptions: {
      input: {
        root: resolve(__dirname, 'index.html'),
        challenge: resolve(__dirname, 'challenge/index.html'),
        admin: resolve(__dirname, 'challenge/admin/index.html'),
      },
    },
  },
});
