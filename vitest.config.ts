import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    {
      name: 'strip-shebang',
      transform(code) {
        if (code.startsWith('#!')) {
          return { code: code.replace(/^#!.*(?:\r\n|\n|\r)/, ''), map: null };
        }
      },
    },
  ],
  test: {
    include: ['src/**/*.test.ts', 'sidecar/**/*.test.js', 'cloudflare/**/*.test.js'],
  },
});
