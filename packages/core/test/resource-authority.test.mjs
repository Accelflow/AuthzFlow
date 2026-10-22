import {readFileSync} from 'node:fs';
import {createResourceAuthority} from '../dist/resource-authority.js';
import {registerResourceAuthorityContract} from '../testing/resource-authority-conformance.mjs';
const wasmBytes=new Uint8Array(readFileSync(new URL('../wasm/authzflow_wasm_bg.wasm',import.meta.url)));
registerResourceAuthorityContract('Rust/Wasm',createResourceAuthority,wasmBytes);

import test from 'node:test';import assert from 'node:assert/strict';
test('changes require an explicit host purge port; native factories must be paired',()=>{assert.throws(()=>createResourceAuthority({changes:{}}),/authz_authority_config_invalid/);assert.throws(()=>createResourceAuthority({runtime:async()=>null}),/authz_authority_config_invalid/);});
