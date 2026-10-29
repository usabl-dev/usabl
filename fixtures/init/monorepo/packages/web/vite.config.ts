import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  server: { port: Number(process.env.WEB_PORT ?? 3000) },
  define: { __MODE__: JSON.stringify(mode) },
}));
