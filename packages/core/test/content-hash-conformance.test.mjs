import {registerContentHashConformance} from '../testing/content-hash-conformance.mjs';
const clientSerialize=value=>JSON.stringify([value.id,value.title??'',value.body]);
const serverSerialize=value=>JSON.stringify([value.id,value.title??'',value.body]);
registerContentHashConformance({name:'example resource',clientSerialize,serverSerialize,
 equivalent:[{name:'object order and product default',values:[{id:'r',body:'text'},{body:'text',title:'',id:'r'}],expected:'["r","","text"]'}],
 different:[{name:'body',left:{id:'r',body:'a'},right:{id:'r',body:'b'}},{name:'title',left:{id:'r',title:'a',body:'x'},right:{id:'r',title:'b',body:'x'}}],
});
