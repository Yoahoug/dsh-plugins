import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Test the source, not the built lib: suites self-import the package name.
      '@dsh-plugins/web-search-tavily': new URL('./packages/web-search-tavily/src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    include: ['packages/*/tests/**/*.spec.ts'],
  },
})
