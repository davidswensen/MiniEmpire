import { defineConfig, type Plugin } from 'vite';
import { SHARED_SRC, simVersion } from '../../scripts/sim-version.mjs';

/**
 * `import { SIM_VERSION } from 'virtual:sim-version'` gives the client the
 * fingerprint of the simulation it was built with. The relay compares it with
 * its own so players with an outdated page can never join a game and desync.
 */
function simVersionPlugin(): Plugin {
  const id = 'virtual:sim-version';
  const resolved = '\0' + id;
  return {
    name: 'sim-version',
    resolveId: (s) => (s === id ? resolved : undefined),
    load: (s) => (s === resolved ? `export const SIM_VERSION = ${JSON.stringify(simVersion())};` : undefined),
    configureServer(server) {
      // in dev, editing the simulation changes the fingerprint
      server.watcher.add(SHARED_SRC);
      server.watcher.on('change', (file) => {
        if (!file.replace(/\\/g, '/').includes('packages/shared/src/')) return;
        const mod = server.moduleGraph.getModuleById(resolved);
        if (mod) server.moduleGraph.invalidateModule(mod);
      });
    },
  };
}

export default defineConfig({
  plugins: [simVersionPlugin()],
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: {
        main: 'index.html',
        determinism: 'determinism.html',
      },
    },
  },
});
