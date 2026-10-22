import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

test('public source guard rejects private hosts, URLs, email, forbidden paths and dependencies', async () => {
  const checker = await readFile(new URL('./check-tree.mjs', import.meta.url));
  const cases = [
    ['safe.md', '# Safe', true],
    ['safe.md', ['https:', '', 'service.' + 'internal'].join('/'), false],
    ['safe.md', ['https:', '', 'unreviewed.example'].join('/'), false],
    ['safe.md', '127' + '.0.0.1', false],
    ['safe.md', 'person@' + 'example.org', false],
    ['.env', 'VALUE=1', false],
    [['docs','internal'].join('-') + '/a.md', '# Private', false],
    ['packages/demo/package.json', JSON.stringify({ dependencies: { '@company/private': '1.0.0' } }), false],
  ];
  for (const [file, body, valid] of cases) {
    const root = await mkdtemp(join(tmpdir(), 'authzflow-source-guard-'));
    try {
      await mkdir(join(root, 'public-tools')); await mkdir(join(root, file, '..'), { recursive: true });
      await writeFile(join(root, 'public-tools/check-tree.mjs'), checker);
      await writeFile(join(root, 'public-tools/license-policy.json'), '{}');
      await writeFile(join(root, file), body);
      await writeFile(join(root, 'public-tools/source-manifest.json'), JSON.stringify({ files: ['public-tools/check-tree.mjs', 'public-tools/license-policy.json', 'public-tools/source-manifest.json', file] }));
      const result = spawnSync(process.execPath, ['public-tools/check-tree.mjs'], { cwd: root, encoding: 'utf8' });
      assert.equal(result.status === 0, valid, `${file}: ${result.stderr}`);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
