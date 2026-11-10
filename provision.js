import { spawn } from 'node:child_process';
import { access, mkdir, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Pin release and digests so setup never executes an unverified latest asset.
export const ASSETS = Object.freeze({
  'darwin-arm64': {file:'podman-installer-macos-arm64.pkg', sha256:'48f675622f66233ca2116e67fdab41ed9dbcc25b48b78a8e6ef0be6549031d22'},
  'win32-x64': {file:'podman-installer-windows-amd64.msi', sha256:'4a05240054cb990629cbe098db090c5c7848c44162c11910cabb45ca75a40d53'},
  'win32-arm64': {file:'podman-installer-windows-arm64.msi', sha256:'a1b65ffa7dd60a5eceedd3df7fc5d1d005b8d21018ff9deaa15aeacfbc92cd6c'},
});
export const RELEASE = 'v6.1.4';
export function run(file,args,{timeoutMs=30000,signal}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(file,args,{shell:false,windowsHide:true,signal});
    let out='',err='';
    const timer=setTimeout(()=>child.kill(),timeoutMs);timer.unref?.();
    child.stdout?.on('data',x=>{out=(out+x).slice(-65536)});
    child.stderr?.on('data',x=>{err=(err+x).slice(-65536)});
    child.on('error',e=>{clearTimeout(timer);reject(e)});
    child.on('close',(code)=>{clearTimeout(timer);resolve({code,stdout:out,stderr:err})});
  });
}
export async function discoverEngine() {
  const candidates=[['docker',process.platform==='win32'?'docker.exe':'docker'],['podman',process.platform==='win32'?'podman.exe':'podman']];
  if(process.platform==='darwin') candidates.push(['docker','/usr/local/bin/docker'],['docker','/Applications/Docker.app/Contents/Resources/bin/docker'],['podman','/opt/podman/bin/podman']);
  if(process.platform==='win32'&&process.env.ProgramFiles) candidates.push(['podman',path.join(process.env.ProgramFiles,'RedHat','Podman','podman.exe')]);
  for(const [kind,executable] of candidates){try{const r=await run(executable,['--version'],{timeoutMs:4000});if(r.code===0)return {kind,executable}}catch{}}
  return {kind:'podman',executable:process.platform==='win32'?'podman.exe':'/opt/podman/bin/podman',missing:true};
}
export class Provisioner {
  constructor(dataDir,onReady){this.dataDir=dataDir;this.onReady=onReady;this.state={phase:'idle',step:'',error:null};this.controller=new AbortController();}
  snapshot(){return {...this.state}}
  start(){if(this.task)return this.snapshot();this.state={phase:'running',step:'detect',error:null};this.task=this.prepare().catch(e=>{this.state={phase:'error',step:this.state.step,error:e.message}}).finally(()=>{this.task=null});return this.snapshot()}
  async checked(engine,args,timeoutMs=120000){const r=await run(engine.executable,args,{timeoutMs,signal:this.controller.signal});if(r.code!==0)throw new Error((r.stderr||r.stdout||'Process failed').slice(-4000));return r}
  async prepare(){
    const engine=await discoverEngine();
    if(engine.missing){
      const asset=ASSETS[`${process.platform}-${process.arch}`];
      if(!asset)throw new Error(`Managed installer unavailable for ${process.platform}/${process.arch}. This release supports Apple Silicon macOS and Windows x64/ARM64.`);
      this.state.step='download';
      await mkdir(path.join(this.dataDir,'downloads'),{recursive:true});
      const target=path.join(this.dataDir,'downloads',asset.file);
      let valid=false;try{const {readFile}=await import('node:fs/promises');valid=createHash('sha256').update(await readFile(target)).digest('hex')===asset.sha256}catch{}
      if(!valid){
        const response=await fetch(`https://github.com/podman-container-tools/podman/releases/download/${RELEASE}/${asset.file}`,{signal:AbortSignal.any([this.controller.signal,AbortSignal.timeout(600000)])});
        if(!response.ok)throw new Error(`Installer download failed: HTTP ${response.status}`);
        const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>160*1024*1024)throw new Error('Installer exceeds size limit');chunks.push(chunk);this.state.bytes=size}
        const bytes=Buffer.concat(chunks);if(createHash('sha256').update(bytes).digest('hex')!==asset.sha256)throw new Error('Installer SHA-256 mismatch; installation blocked');
        await writeFile(target+'.part',bytes,{mode:0o600});await rename(target+'.part',target);
      }
      this.state.step='system_installer';
      // Only a direct user action reaches start(). Native OS installer owns elevation/consent.
      const launched=process.platform==='darwin'?await run('/usr/bin/open',[target]):await run('msiexec.exe',['/i',target],{timeoutMs:600000});
      if(launched.code!==0)throw new Error('System installer failed or was cancelled');
      this.state={phase:'needs_system_step',step:'system_installer',error:null};return;
    }
    if(engine.kind==='podman'){
      this.state.step='machine';
      const list=await this.checked(engine,['machine','list','--format','json']);
      const machines=JSON.parse(list.stdout||'[]');
      const owned=machines.find(x=>(x.Name||x.name)==='dsh-omarchy');
      // Never change or stop an unrelated user's VM.
      if(!owned)await this.checked(engine,['machine','init','--cpus','2','--memory','2048','--disk-size','20','dsh-omarchy'],900000);
      if(!owned?.Running&&!owned?.running)await this.checked(engine,['machine','start','dsh-omarchy'],300000);
    }
    this.state.step='image';
    // Arch Linux official userspace is x86_64. ARM needs emulation support in the engine VM.
    await this.checked(engine,['pull','--platform','linux/amd64','docker.io/library/archlinux:base'],900000);
    this.state.step='verify';await this.onReady(engine);
    this.state={phase:'ready',step:'complete',error:null};
  }
  async dispose(){this.controller.abort();await this.task}
}
