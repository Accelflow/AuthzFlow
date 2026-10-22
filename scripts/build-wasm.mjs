import { mkdirSync,realpathSync } from 'node:fs';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
const remaps=[realpathSync(process.cwd()),realpathSync(homedir()),realpathSync(process.env.CARGO_HOME??resolve(homedir(),'.cargo'))];
const buildEnv={...process.env,CARGO_ENCODED_RUSTFLAGS:remaps.map((path,i)=>`--remap-path-prefix=${path}=/build/source${i}`).join('\x1f')};
import { spawnSync } from 'node:child_process';
const run = (args) => {
  const result = spawnSync(args[0], args.slice(1), { stdio: 'inherit',env:buildEnv });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run(['cargo', 'build', '--locked', '-p', 'authzflow-wasm', '--release', '--target', 'wasm32-unknown-unknown']);
mkdirSync('packages/core/wasm', { recursive: true });
run(['wasm-bindgen', 'target/wasm32-unknown-unknown/release/authzflow_wasm.wasm', '--target', 'web', '--out-dir', 'packages/core/wasm']);
