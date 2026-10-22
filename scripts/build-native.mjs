// macOS release builder. Produces prebuilt native libraries, never publishes.
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,readdir,copyFile,lstat} from 'node:fs/promises';
import {resolve,join,dirname,relative} from 'node:path';
import {createHash} from 'node:crypto';
const output=resolve(process.argv[2]??''),ndk=process.argv[3];
if(process.argv.length!==4||!ndk||!output.endsWith('.tgz')||process.platform!=='darwin')throw Error('native_builder_arguments');
const staging=output+'.source',root=process.cwd();
await mkdir(staging);await mkdir(join(staging,'include'));
const run=(command,args,env={})=>execFileSync(command,args,{stdio:'inherit',env:{...process.env,...env}});
for(const target of ['aarch64-apple-ios','aarch64-apple-ios-sim','aarch64-linux-android']){
 const env=target.endsWith('android')?{CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER:join(ndk,'toolchains/llvm/prebuilt/darwin-x86_64/bin/aarch64-linux-android24-clang'),RUSTFLAGS:'-C link-arg=-Wl,-z,max-page-size=16384'}:{};
 run('cargo',['build','--locked','-p','authzflow-native','--release','--target',target],env);
}
for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md','RUST_STD_NOTICES.html'])await copyFile(join('packages/core',name),join(staging,name));
await copyFile('crates/authzflow-native/include/authzflow_native.h',join(staging,'include/authzflow_native.h'));
run('xcodebuild',['-create-xcframework','-library',resolve('target/aarch64-apple-ios/release/libauthzflow_native.a'),'-headers',join(staging,'include'),'-library',resolve('target/aarch64-apple-ios-sim/release/libauthzflow_native.a'),'-headers',join(staging,'include'),'-output',join(staging,'AuthzFlow.xcframework')]);
await mkdir(join(staging,'android/arm64-v8a'),{recursive:true});await copyFile('target/aarch64-linux-android/release/libauthzflow_native.so',join(staging,'android/arm64-v8a/libauthzflow_native.so'));
const files={};const walk=async(dir)=>{for(const name of (await readdir(dir)).sort()){const path=join(dir,name),stat=await lstat(path);if(stat.isDirectory())await walk(path);else if(stat.isFile())files[relative(staging,path)]=createHash('sha256').update(await readFile(path)).digest('hex');else throw Error('native_artifact_symlink');}};await walk(staging);
const hash=createHash('sha256');for(const path of ['Cargo.toml','Cargo.lock',...(await (async()=>{const paths=[];for(const base of ['crates/authzflow-core','crates/authzflow-native']){const scan=async dir=>{for(const name of (await readdir(dir)).sort()){const path=join(dir,name);if((await lstat(path)).isDirectory())await scan(path);else paths.push(path);}};await scan(base);}return paths;})())].sort())hash.update(path+'\0').update(await readFile(path));
const sourceTreeSha256=hash.digest('hex');
run('tar',['-czf',output,'-C',staging,'.']);
await writeFile(output+'.json',JSON.stringify({schemaVersion:1,abiVersion:2,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceTreeSha256,sha256:createHash('sha256').update(await readFile(output)).digest('hex'),files},null,2)+'\n');
console.log('Native artifact ready: '+output);
