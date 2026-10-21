import { defineConfig } from 'vitest/config';

// Unit tests run in Node: geometry and scene construction need no browser.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
