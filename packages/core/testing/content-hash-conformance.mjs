import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createContentHasher} from '../dist/content-hash.js';
/** Consumers supply independently expected bytes and real client/server serializers. */
export function registerContentHashConformance({name,clientSerialize,serverSerialize,equivalent,different}){
 const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
 const client=createContentHasher({serialize:clientSerialize,digest}),server=createContentHasher({serialize:serverSerialize,digest});
 for(const group of equivalent)test(`${name}: canonical bytes ${group.name}`,async()=>{
  assert.ok(group.values.length>=2,'at least two independently shaped equivalent values required');
  const expected=digest(new TextEncoder().encode(group.expected));
  for(const value of group.values){const before=structuredClone(value);assert.equal(clientSerialize(structuredClone(value)),group.expected);assert.equal(serverSerialize(structuredClone(value)),group.expected);assert.equal(await client(value),expected);assert.equal(await server(value),expected);assert.deepEqual(value,before);}
 });
 for(const pair of different)test(`${name}: changed ${pair.name} changes the hash`,async()=>{assert.notEqual(await client(pair.left),await server(pair.right));assert.equal(await client(pair.left),await server(pair.left));assert.equal(await client(pair.right),await server(pair.right));});
}
