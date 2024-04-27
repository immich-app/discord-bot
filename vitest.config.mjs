import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: './',
    globals: true,
    server: {
      deps: {
        fallbackCjs: true,
      },
    },
  },
});
