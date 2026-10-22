import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gunzipSync, gzipSync } from 'node:zlib';
import { verifyReleaseArchive, archiveFiles } from './archive.mjs';

test('both npm archives contain exact compiled files, MIT and complete notices', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'authzflow-release-'));
  try {
    for (const name of ['core', 'server']) {
      const result = JSON.parse(execFileSync('npm', ['pack', `./packages/${name}`, '--ignore-scripts', '--json', '--pack-destination', folder], { encoding: 'utf8' }))[0];
      const archive = await readFile(join(folder, result.filename));
      const verified = await verifyReleaseArchive(archive);
      assert.deepEqual([...verified.files.keys()].sort(), archiveFiles[`@authzflow/${name}`]);
      assert.equal(verified.manifest.license, 'MIT'); assert.equal(verified.integrity, result.integrity);
      assert.ok(![...verified.files.keys()].some(file => file.endsWith('.html')));
      assert.ok(verified.files.get('THIRD_PARTY_NOTICES.md').toString('utf8').includes('Copyright notices for The Rust Standard Library'));
      const tar = gunzipSync(archive);
      for (const attack of ['path', 'symlink', 'license', 'notices']) {
        const bytes = Buffer.from(tar), h = bytes.subarray(0, 512);
        if (attack === 'path') { h.fill(0, 0, 100); h.write('package/forbidden-file'); }
        if (attack === 'symlink') h[156] = 50;
        if (attack === 'license') { const at = bytes.indexOf(Buffer.from('Copyright (c) 2026 Accelflow Inc.')); assert.ok(at >= 0); bytes[at] = 88; }
        if (attack === 'notices') { const at = bytes.indexOf(Buffer.from('Copyright notices for The Rust Standard Library')); assert.ok(at >= 0); bytes[at] = 88; }
        h.fill(32, 148, 156); h.write(h.reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148);
        await assert.rejects(verifyReleaseArchive(gzipSync(bytes)), /npm_(archive|license)_/);
      }
    }
  } finally { await rm(folder, { recursive: true, force: true }); }
});
