import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const buildOptions = {
  entryPoints: ['src/background.ts', 'src/sidepanel.ts', 'src/content.ts', 'src/offscreen.ts'],
  bundle: true,
  outdir: 'dist',
  format: 'esm',
  target: 'chrome120',
  sourcemap: true,
};

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log('Watching for changes...');
} else {
  await esbuild.build(buildOptions);
  console.log('Extension built successfully.');
}
