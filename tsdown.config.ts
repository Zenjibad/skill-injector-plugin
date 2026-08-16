/**
 * tsdown build for skill-injector-plugin:
 *  - host half (lib/index.js, ESM node) from src/index.ts,
 *  - pure helpers (lib/helpers.js, ESM node) from src/helpers.ts,
 *  - browser client bundle (lib/client.js, CJS ModuleLoader closure factory)
 *    from src/client/index.tsx — the exports["./client"] artifact the DSH
 *    client-modules scanner loads (bundle id = package name).
 */
import { defineConfig } from 'tsdown'

const NODE_ENV = process.env.NODE_ENV ?? 'production'

/** Module specifiers the web shell shares into the frozen module table. */
const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'cordis']

/** One client bundle for the plugin id (package name). */
const clientBundle = {
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs' as const,
  platform: 'browser' as const,
  dts: false,
  sourcemap: true,
  clean: false,
  external: CLIENT_EXTERNALS,
  define: {
    'process.env.NODE_ENV': JSON.stringify(NODE_ENV),
    'import.meta.env.MODE': JSON.stringify(NODE_ENV),
    'import.meta.env': JSON.stringify({ MODE: NODE_ENV }),
    'import.meta.resolve': 'undefined',
  },
  inputOptions: {
    resolve: { conditionNames: ['browser', 'import', 'require', 'default'] },
  },
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: "skill-injector-plugin", factory: (require) => {`,
    footer: `return module.exports; } });`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

export default defineConfig([
  {
    entry: { index: 'src/index.ts', helpers: 'src/helpers.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: false,
    clean: true,
  },
  clientBundle,
])
