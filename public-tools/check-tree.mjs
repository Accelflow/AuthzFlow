import { readFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const manifest = JSON.parse(await readFile('public-tools/source-manifest.json', 'utf8'));
const licenses = JSON.parse(await readFile('public-tools/license-policy.json', 'utf8'));
const files = [];
const walk = async dir => {
  for (const entry of await readdir(dir || '.', { withFileTypes: true })) {
    const name = dir ? dir + '/' + entry.name : entry.name;
    if (entry.name === '.git' || entry.name === 'node_modules' || ['target', 'test-results'].includes(name)
      || ['packages/core/dist', 'packages/core/wasm', 'packages/server/dist'].includes(name)) continue;
    const stat = await lstat(name);
    if (stat.isSymbolicLink()) throw Error('source_symlink_forbidden');
    if (stat.isDirectory()) { await walk(name); continue; }
    if (!stat.isFile() || stat.size > 1048576 || /(^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|docs(?:-internal)?)(\/|$)/i.test(name)) throw Error('source_path_forbidden');
    files.push(name);
    const bytes = await readFile(name);
    if (licenses[name]) {
      if (createHash('sha256').update(bytes).digest('hex') !== licenses[name]) throw Error('source_license_changed');
      continue;
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0') || /\.(?:internal|local|local[h]ost|ts\.net)\b/i.test(text)
      || /\b(?:local[h]ost|0[.]0[.]0[.]0|169[.]254(?:\.\d{1,3}){2}|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2})\b/.test(text)) throw Error('source_hostname_forbidden');
    if (/[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~\[\]-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}/.test(text)) throw Error('source_email_forbidden');
    for (const raw of text.match(/https?:\/\/[^\s<>"'`\)\]]+/gi) ?? []) {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || url.port || url.username || url.password || !['github.com','accelflow.jp','registry.npmjs.org','www.npmjs.com','authzflow.test','docs.npmjs.com'].includes(url.hostname)) throw Error('source_url_forbidden');
    }
    if (entry.name === 'package.json') {
      const p = JSON.parse(text);
      if (p.private && !(name === 'package.json' && p.name === 'authzflow-workspace')) throw Error('source_private_package');
      for (const group of ['dependencies','devDependencies','peerDependencies','optionalDependencies']) for (const [dep,spec] of Object.entries(p[group] ?? {})) {
        if (!['typescript','@playwright/test'].includes(dep) || !/^\d+\.\d+\.\d+$/.test(spec)) throw Error('source_private_dependency');
      }
    }
    if (entry.name === 'pnpm-lock.yaml' && /\b(?:file|workspace|link|portal|patch|git\+ssh|ssh):/i.test(text)) throw Error('source_private_dependency');
  }
};
await walk('');
if (JSON.stringify(files.sort()) !== JSON.stringify([...manifest.files].sort())) throw Error('source_manifest_mismatch');
console.log(`PASS: ${files.length} allowlisted source files; host, URL, email, path and dependency checks`);
