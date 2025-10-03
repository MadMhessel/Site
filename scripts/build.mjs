import { build } from 'esbuild';
import { mkdir, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const publicDir = path.join(distDir, 'public');
const assetsDir = path.join(publicDir, 'assets');

await mkdir(assetsDir, { recursive: true });

await build({
  entryPoints: [path.join(rootDir, 'src', 'main.ts')],
  bundle: true,
  format: 'esm',
  target: 'es2020',
  outfile: path.join(assetsDir, 'main.js'),
  sourcemap: true,
  minify: false
});

await build({
  entryPoints: [path.join(rootDir, 'server.ts')],
  bundle: false,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: path.join(distDir, 'server.js'),
  sourcemap: true
});

await cp(path.join(rootDir, 'index.html'), path.join(publicDir, 'index.html'));
await cp(path.join(rootDir, 'styles.css'), path.join(publicDir, 'styles.css'));
await cp(path.join(rootDir, 'data'), path.join(distDir, 'data'), { recursive: true });
