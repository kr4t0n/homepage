import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import devServer from '@hono/vite-dev-server'

// Served from the root of a domain rather than a subpath, so the base stays '/'.
export default defineConfig(({ mode }) => {
  // Vite only injects VITE_-prefixed vars, and only into the *client*. The proxy
  // needs PROMETHEUS_URL server-side, so load it explicitly with an empty prefix
  // and put just that one on process.env for the dev server to read.
  //
  // Deliberately not spreading everything from .env onto process.env, and
  // deliberately not renaming it VITE_PROMETHEUS_URL: that prefix is exactly
  // what would inline the address into the browser bundle.
  const env = loadEnv(mode, process.cwd(), '')
  if (env.PROMETHEUS_URL) process.env.PROMETHEUS_URL = env.PROMETHEUS_URL

  return {
    base: '/',
    plugins: [
      react(),
      tailwindcss(),
      // Runs the same Hono app the container runs, so /api/pixels behaves
      // identically in `pnpm run dev` and in the cluster. `exclude` inverts the
      // plugin's default: hand it only /api/*, and let Vite keep serving the SPA,
      // HMR and every asset as before.
      devServer({
        entry: 'src/server/api.ts',
        exclude: [/^(?!\/api\/).*/],
        injectClientScript: false,
      }),
    ],
    build: {
      target: 'es2022',
      rollupOptions: {
        output: {
          manualChunks: {
            three: ['three'],
            r3f: ['@react-three/fiber', '@react-three/drei'],
            gsap: ['gsap', '@gsap/react'],
          },
        },
      },
    },
  }
})
