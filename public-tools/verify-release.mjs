import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyReleaseArchive } from './archive.mjs';
const folder = process.argv[2];
if (!folder || process.argv.length !== 3) throw Error('release_archive_directory_required');
const archives = (await readdir(folder)).filter(x => x.endsWith('.tgz'));
if (archives.length !== 2) throw Error('release_archive_count_invalid');
const names = new Set();
for (const file of archives) {
  const { manifest, files, integrity } = await verifyReleaseArchive(await readFile(join(folder, file)));
  if (names.has(manifest.name)) throw Error('release_archive_duplicate');
  names.add(manifest.name);
  console.log(JSON.stringify({ name: manifest.name, version: manifest.version, fileCount: files.size, integrity }));
}
