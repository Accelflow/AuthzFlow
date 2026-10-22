import type {ResourceAuthority,ResourceAuthorityOptions} from '../dist/resource-authority.js';
export function registerResourceAuthorityContract(name:string,createAuthority:(options:ResourceAuthorityOptions)=>ResourceAuthority,wasmBytes?:Uint8Array<ArrayBuffer>):void;
