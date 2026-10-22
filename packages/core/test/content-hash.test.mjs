import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createContentHasher} from '../dist/content-hash.js';
const serialize=value=>JSON.stringify([value.title,value.body]);
const hash=createContentHasher({serialize,digest:bytes=>createHash('sha256').update(bytes).digest('hex')});
test('hash exact projected content with matching server and browser codecs',async()=>{
 const value={title:'日本語',body:['One','Two']},browser=createContentHasher({serialize,digest:async bytes=>Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex')});
 assert.equal(await hash(value),createHash('sha256').update('["日本語",["One","Two"]]').digest('hex'));assert.equal(await hash(value),await browser(value));
 assert.notEqual(await hash(value),await hash({...value,title:'changed'}));assert.notEqual(await hash(value),await hash({...value,body:['Two','One']}));
});
test('host mutation cannot replace the snapshot being hashed',async()=>{
 const value={title:'original',body:['One']},guarded=createContentHasher({serialize:snapshot=>{value.title='changed';snapshot.body.push('local');return serialize(snapshot);},digest:bytes=>createHash('sha256').update(bytes).digest('hex')});
 assert.equal(await guarded(value),await hash({title:'original',body:['One','local']}));assert.deepEqual(value,{title:'changed',body:['One']});
});
test('invalid digest and non-cloneable content fail closed',async()=>{
 for(const digest of [()=>'',()=> 'A'.repeat(64),()=>null])await assert.rejects(createContentHasher({serialize,digest})({title:'x',body:[]}),/content_hash_invalid/);
 await assert.rejects(hash({title:'x',body:()=>{}}));await assert.rejects(createContentHasher({serialize:()=>{throw Error('codec_failure');},digest:()=>''})({}),/codec_failure/);
});
