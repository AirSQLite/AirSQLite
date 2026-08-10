// Two bundles, two worlds.
//
//   extension -> CJS, node platform, `vscode` and `better-sqlite3` left external.
//                VS Code requires CJS for the extension host, and native modules
//                cannot be bundled — better-sqlite3 ships a prebuilt .node that is
//                resolved from node_modules at runtime and packed into the .vsix.
//
//   ui        -> ESM, browser platform, everything inlined including CSS.
//                Nothing node-specific may reach this bundle; scripts/check-portability.js
//                is what actually enforces that.

const esbuild = require('esbuild')
const path = require('node:path')

const watch = process.argv.includes('--watch')
const root = __dirname

// Production builds drop sourcemaps. Not for size — the bundles are 0.2MB against 16MB of
// native prebuilds — but because .vscodeignore keeps the .map files out of the .vsix, and a
// bundle whose sourceMappingURL points at a file that was never shipped makes devtools chase
// a 404 every time it opens. Deliberately not minified: nothing here is served over a network,
// and a readable bundle is worth more than 70KB when something misbehaves in a user's editor.
//
// `vscode:prepublish` passes this, so `vsce package` always gets a fresh production build
// rather than whatever happened to be in dist/.
const production = process.argv.includes('--production')

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  sourcemap: !production,
  logLevel: 'info',
  absWorkingDir: root,
}

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  ...shared,
  entryPoints: [path.join(root, 'src/extension.ts')],
  outfile: path.join(root, 'dist/extension.js'),
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode', 'better-sqlite3'],
}

// The dev/test server. ESM so `import.meta.url` survives, `.mjs` because the package is
// otherwise CJS. Not shipped in the .vsix — it exists to host the UI for Playwright and
// for local development.
/** @type {import('esbuild').BuildOptions} */
const serverConfig = {
  ...shared,
  entryPoints: [path.join(root, 'src/server.ts')],
  outfile: path.join(root, 'dist/server.mjs'),
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external: ['ws', 'better-sqlite3'],
}

/** @type {import('esbuild').BuildOptions} */
const uiConfig = {
  ...shared,
  entryPoints: [path.join(root, 'src/ui/index.tsx')],
  outfile: path.join(root, 'dist/ui.js'),
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  loader: { '.css': 'css' },
}

async function main() {
  if (watch) {
    const contexts = await Promise.all([
      esbuild.context(extensionConfig),
      esbuild.context(serverConfig),
      esbuild.context(uiConfig),
    ])
    await Promise.all(contexts.map((c) => c.watch()))
    console.log('[esbuild] watching extension + server + ui')
    return
  }

  await Promise.all([
    esbuild.build(extensionConfig),
    esbuild.build(serverConfig),
    esbuild.build(uiConfig),
  ])
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
