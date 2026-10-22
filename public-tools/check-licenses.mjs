import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const inventory = JSON.parse(await readFile('public-tools/dependency-licenses.json', 'utf8'));
const lock = await readFile('Cargo.lock', 'utf8');
const packages = [...lock.matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/g)]
  .map(([,name,version]) => ({name,version})).filter(p => !p.name.startsWith('authzflow-'));
if (JSON.stringify(packages) !== JSON.stringify(inventory.packages.map(({name,version})=>({name,version})))) throw Error('license_inventory_lock_mismatch');
if (inventory.packages.some(p => !p.license.includes('MIT') || p.selected !== (p.license.includes('Unicode-3.0') ? 'MIT AND Unicode-3.0' : 'MIT'))) throw Error('license_inventory_requires_review');
if (createHash('sha256').update(await readFile('THIRD_PARTY_NOTICES.md')).digest('hex') !== inventory.noticesSha256) throw Error('license_notices_changed');
const tools = await readFile('mise.toml', 'utf8');
if (!tools.includes(`rust = "${inventory.rustVersion}"`)) throw Error('license_toolchain_changed');
console.log(`PASS: ${packages.length} locked dependency license selections and notice digest`);
