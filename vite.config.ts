import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import devServer from '@hono/vite-dev-server'

// Served from the root of www.kubitnodes.com, so the base stays '/'.
export default defineConfig(({ mode }) => {
  // Vite only injects VITE_-prefixed vars, and only into the *client*. The proxy
  // needs ARGUS and ARGUS_KEY server-side, so load them explicitly with an empty
  // prefix and put just those two on process.env for the dev server to read.
  //
  // Deliberately not spreading everything from .env onto process.env, and
  // deliberately not renaming these to VITE_ARGUS_KEY: that prefix is exactly
  // what would inline the credential into the browser bundle.
  const env = loadEnv(mode, process.cwd(), '')
  if (env.ARGUS) process.env.ARGUS = env.ARGUS
  if (env.ARGUS_KEY) process.env.ARGUS_KEY = env.ARGUS_KEY

  return {
    base: '/',
    plugins: [
      react(),
      tailwindcss(),
      // Runs the same Hono app the container runs, so /api/pixels behaves
      // identically in `npm run dev` and in the cluster. `exclude` inverts the
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
