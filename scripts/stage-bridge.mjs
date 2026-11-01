// Stage a self-contained Native Server directory for the release zip.
// npm pack keeps `workspace:*` and pnpm deploy produces links, so neither is
// zip-safe. Instead: vendor the shared package as a tarball, pin direct deps
// to the versions pnpm resolved, and let npm build a flat node_modules.
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] ? resolve(process.argv[2]) : '';
if (!out) {
  console.error('usage: node scripts/stage-bridge.mjs <out-dir>');
  process.exit(1);
}

const nativeDir = join(repo, 'app', 'native-server');
const sharedDir = join(repo, 'packages', 'shared');
for (const dir of [join(nativeDir, 'dist'), join(sharedDir, 'dist')]) {
  if (!existsSync(dir)) throw new Error(`missing build output: ${dir} (run pnpm run build first)`);
}

const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString();

rmSync(out, { recursive: true, force: true });
const vendorDir = join(out, 'vendor');
mkdirSync(vendorDir, { recursive: true });

run(`npm pack --pack-destination "${vendorDir}"`, sharedDir);
const sharedTgz = readdirSync(vendorDir).find((name) => name.endsWith('.tgz'));
if (!sharedTgz) throw new Error('npm pack produced no tarball for aieasybrowser-shared');

cpSync(join(nativeDir, 'dist'), join(out, 'dist'), { recursive: true });
rmSync(join(out, 'dist', 'node_path.txt'), { force: true });

const [listing] = JSON.parse(
  run('pnpm --filter aieasybrowser-bridge list --prod --json --depth 0', repo),
);
const pkg = JSON.parse(readFileSync(join(nativeDir, 'package.json'), 'utf8'));
for (const name of Object.keys(pkg.dependencies)) {
  if (name === 'aieasybrowser-shared') {
    pkg.dependencies[name] = `file:vendor/${sharedTgz}`;
    continue;
  }
  const version = listing.dependencies?.[name]?.version;
  if (!version) throw new Error(`pnpm did not resolve dependency ${name}`);
  pkg.dependencies[name] = version;
}
delete pkg.devDependencies;
delete pkg.scripts;
delete pkg.husky;
delete pkg['lint-staged'];
writeFileSync(join(out, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

run('npm install --omit=dev --ignore-scripts --no-audit --no-fund --no-package-lock', out);
console.log(`staged ${pkg.name}@${pkg.version} -> ${out}`);
