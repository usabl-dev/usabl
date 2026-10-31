/**
 * Reading the dev server port and protocol from a Vite config without running it. Only static
 * literals count; anything else is reported as unread, never guessed.
 */
import { describe, expect, it } from 'vitest';
import { readViteServer } from '../../src/init/vite-server.js';

describe('readViteServer', () => {
  it('reads a static port and https from defineConfig', () => {
    expect(readViteServer('export default defineConfig({ server: { port: 4100, https: true } })', 'vite.config.ts')).toEqual({
      port: { value: 4100 },
      https: { value: true },
    });
  });

  it('reads the server block only, never another block with a port', () => {
    // A port in preview or in a plugin option is not the dev server port.
    const raw = 'export default defineConfig({ server: { host: true }, preview: { port: 4173 } })';
    expect(readViteServer(raw, 'vite.config.ts')).toEqual({ port: { absent: true }, https: { absent: true } });
  });

  it('reads a plain object default export and a config returned by a function', () => {
    expect(readViteServer('export default { server: { port: 3000 } }', 'vite.config.js').port).toEqual({ value: 3000 });
    expect(
      readViteServer('export default defineConfig(({ mode }) => ({ server: { port: 3001 } }))', 'vite.config.ts').port,
    ).toEqual({ value: 3001 });
    expect(
      readViteServer('export default defineConfig(() => { return { server: { port: 3002 } } })', 'vite.config.ts').port,
    ).toEqual({ value: 3002 });
    expect(readViteServer('const config = { server: { port: 3003 } }\nexport default config', 'vite.config.ts').port).toEqual({
      value: 3003,
    });
  });

  it('reads https given as an options object, and false as http', () => {
    const raw = "export default { server: { https: { key: 'k.pem', cert: 'c.pem' } } }";
    expect(readViteServer(raw, 'vite.config.ts').https).toEqual({ value: true });
    expect(readViteServer('export default { server: { https: false } }', 'vite.config.ts').https).toEqual({ value: false });
  });

  it('reads https turned on by the basic SSL plugin', () => {
    const raw = "import basicSsl from '@vitejs/plugin-basic-ssl'\nexport default { plugins: [basicSsl()] }";
    expect(readViteServer(raw, 'vite.config.ts').https).toEqual({ value: true });
  });

  it('says it could not read a port or https set by code', () => {
    const raw = 'export default { server: { port: Number(process.env.PORT), https: useHttps() } }';
    expect(readViteServer(raw, 'vite.config.ts')).toEqual({ port: { unread: true }, https: { unread: true } });
  });

  it('says it could not read a server block it cannot see into', () => {
    expect(readViteServer('export default { server: devServer }', 'vite.config.ts')).toEqual({
      port: { unread: true },
      https: { unread: true },
    });
    expect(readViteServer('export default { ...shared }', 'vite.config.ts')).toEqual({
      port: { unread: true },
      https: { unread: true },
    });
    expect(readViteServer('export default makeConfig()', 'vite.config.ts')).toEqual({
      port: { unread: true },
      https: { unread: true },
    });
  });

  it('says it could not read a file that does not parse', () => {
    expect(readViteServer('export default {', 'vite.config.ts')).toEqual({ port: { unread: true }, https: { unread: true } });
  });

  it('ignores a port in a comment or a string', () => {
    const raw = "// server: { port: 9999 }\nexport default { define: { note: 'server: { port: 8888 }' } }";
    expect(readViteServer(raw, 'vite.config.ts')).toEqual({ port: { absent: true }, https: { absent: true } });
  });
});
