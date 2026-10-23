import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const archiveFiles = {
  '@authzflow/core': ['dist/resource-authority-driver.js','dist/resource-authority-driver.d.ts','dist/resource-change-tracker-driver.js','dist/resource-change-tracker-driver.d.ts','dist/resource-authority.js','dist/resource-authority.d.ts','dist/resource-change-tracker.js','dist/resource-change-tracker.d.ts','testing/index.mjs','testing/index.d.mts','testing/resource-authority-conformance.mjs','testing/resource-authority-conformance.d.mts','testing/content-hash-conformance.mjs','testing/content-hash-conformance.d.mts','dist/checked-reader-protocol.js','dist/checked-reader-protocol.d.ts','dist/native-reader.js','dist/native-reader.d.ts','dist/runtime-driver.js','dist/runtime-driver.d.ts','dist/replica-eligibility.js','dist/replica-eligibility.d.ts','dist/replicas.js','dist/replicas.d.ts','dist/content-hash.js','dist/content-hash.d.ts','testing/replica-conformance.mjs','testing/replica-conformance.d.mts','dist/cache.js', 'dist/cache.d.ts', 'dist/sqlite.js', 'dist/sqlite.d.ts', 'dist/indexeddb.js', 'dist/indexeddb.d.ts', 'dist/index.js', 'dist/index.d.ts', 'dist/checked-reader.js', 'dist/checked-reader.d.ts', 'dist/change-consumer.js', 'dist/change-consumer.d.ts', 'wasm/authzflow_wasm.js', 'wasm/authzflow_wasm.d.ts', 'wasm/authzflow_wasm_bg.wasm', 'wasm/authzflow_wasm_bg.wasm.d.ts', 'package.json', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md'].sort(),
  '@authzflow/server': ['dist/index.js', 'dist/index.d.ts', 'dist/change-feed.js', 'dist/change-feed.d.ts', 'package.json', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md'].sort(),
};

export async function verifyReleaseArchive(archive) {
  let tar;
  try { if (archive.length > 8388608) throw Error(); tar = gunzipSync(archive, { maxOutputLength: 16777216 }); }
  catch { throw Error('npm_archive_invalid'); }
  const files = new Map(); let offset = 0;
  const union = new Set(Object.values(archiveFiles).flat());
  while (offset + 512 <= tar.length) {
    const h = tar.subarray(offset, offset + 512);
    if (h.every(x => x === 0)) break;
    const field = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const rawSize = field(124, 136).trim(), rawSum = field(148, 156).trim();
    if (!/^[0-7]+$/.test(rawSize) || !/^[0-7]+$/.test(rawSum)) throw Error('npm_archive_invalid');
    const size = parseInt(rawSize, 8), sum = h.reduce((s, x, i) => s + (i >= 148 && i < 156 ? 32 : x), 0);
    const prefix = field(345, 500), name = (prefix ? prefix + '/' : '') + field(0, 100);
    if (sum !== parseInt(rawSum, 8) || size > 1048576 || offset + 512 + size > tar.length || ![0, 48].includes(h[156]) || !name.startsWith('package/')) throw Error('npm_archive_invalid');
    const file = name.slice(8);
    if (!union.has(file) || files.has(file)) throw Error('npm_archive_forbidden_path');
    files.set(file, tar.subarray(offset + 512, offset + 512 + size)); offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (offset + 1024 > tar.length || !tar.subarray(offset).every(x => x === 0)) throw Error('npm_archive_invalid');
  let manifest; try { manifest = JSON.parse(files.get('package.json').toString('utf8')); } catch { throw Error('npm_manifest_invalid'); }
  const expected = archiveFiles[manifest.name];
  if (!expected || JSON.stringify([...files.keys()].sort()) !== JSON.stringify(expected)) throw Error('npm_archive_invalid');
  const source = JSON.parse(await readFile(new URL(`../packages/${manifest.name.endsWith('/core') ? 'core' : 'server'}/package.json`, import.meta.url), 'utf8'));
  if (JSON.stringify(manifest) !== JSON.stringify(source) || manifest.private !== false || manifest.license !== 'MIT'
    || manifest.author !== 'Accelflow Inc.' || manifest.publishConfig?.access !== 'public' || manifest.publishConfig?.provenance !== true
    || manifest.publishConfig?.registry !== 'https://registry.npmjs.org/' || !/^\d+\.\d+\.\d+-(?:alpha|beta)\.\d+$/.test(manifest.version)
    || manifest.scripts && Object.keys(manifest.scripts).length) throw Error('npm_publication_not_ready');
  for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'bundledDependencies']) if (manifest[group] && Object.keys(manifest[group]).length) throw Error('npm_dependency_unreviewed');
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    if (!files.get(file).equals(await readFile(new URL('../' + file, import.meta.url)))) throw Error('npm_license_invalid');
  }
  if (!files.get('README.md').length) throw Error('npm_readme_required');
  if (manifest.name.endsWith('/core') && !WebAssembly.validate(files.get('wasm/authzflow_wasm_bg.wasm'))) throw Error('npm_wasm_invalid');
  return { files, manifest, integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64') };
}
