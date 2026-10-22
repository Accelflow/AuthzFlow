import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
const folder = resolve(process.argv[2] ?? '');
if (process.argv.length !== 3) throw Error('archive_directory_required');
const archives = (await readdir(folder)).filter(x => x.endsWith('.tgz')).map(x => join(folder, x));
if (archives.length !== 2) throw Error('archive_count_invalid');
const consumer = await mkdtemp(join(tmpdir(), 'authzflow-consumer-'));
try {
  execFileSync('npm', ['install', '--prefix', consumer, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', ...archives], { stdio: 'pipe' });
  await writeFile(join(consumer, 'main.mjs'), await readFile(new URL('../examples/check-only/main.mjs', import.meta.url)));
  execFileSync(process.execPath, [join(consumer, 'main.mjs')], { stdio: 'inherit', env: { ...process.env, AUTHZFLOW_INSTALLED_PACKAGES: '1' } });
} finally { await rm(consumer, { recursive: true, force: true }); }
