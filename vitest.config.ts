import { defineConfig } from 'vitest/config'

// Kept apart from vite.config.ts, which copies ARGUS and ARGUS_KEY from .env
// onto process.env. The proxy's tests must only ever reach the stub upstream
// they start themselves, never a real credential.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // vi.stubEnv changes process.env for the whole file; undo it before each test.
    unstubEnvs: true,
  },
})
