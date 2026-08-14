import { defineConfig } from 'vitest/config'

// Real-API lane: e2e tests self-skip when their required env credential is absent.
export default defineConfig({
  resolve: {
    alias: {
      '@dsh-plugins/web-search-tavily': new URL('./packages/web-search-tavily/src/index.ts', import.meta.url).pathname,
      '@dsh-plugins/vision-bridge': new URL('./packages/vision-bridge/src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    include: ['packages/*/tests/**/*.e2e.ts'],
  },
})
