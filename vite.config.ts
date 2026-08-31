import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwind()],
  root: 'src/web',
  publicDir: '../../public',
  build: { outDir: '../../dist', emptyOutDir: true },
  server: {
    port: 5173,
    /*
     * `ws: true`, and it is not optional here.
     *
     * The string shorthand normalises to `{ target, changeOrigin: true }` with
     * no websocket support, so `bun run dev` proxied every `/api` request
     * except the one that matters: the terminal socket is a GET that upgrades,
     * and `ws://localhost:5173/api/claude/terminals/<id>/socket` hung
     * unanswered. A Claude Code session could be started from the dev server
     * and never attached to — the one surface that cannot be checked any other
     * way, unreachable on the only build a person develops against.
     */
    proxy: { '/api': { target: 'http://127.0.0.1:8585', ws: true } },
  },
})
