import swc from 'unplugin-swc';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: './',
    globals: true,
    server: { deps: { fallbackCJS: true } },
    include: ['src/**/*.spec.ts'],
  },
  plugins: [swc.vite(), tsconfigPaths()],
});
