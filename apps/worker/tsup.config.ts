import { defineConfig } from 'tsup'

// One self-contained bundle per app: workspace packages + deps inlined, so Heroku's
// devDependency pruning can't break runtime resolution.
export default defineConfig({
  entry: { scheduler: 'src/scheduler.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  noExternal: [/.*/],
  external: ['pg-native'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
})
