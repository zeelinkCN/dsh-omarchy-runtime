import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { run } from './provision.js';
import { Runtime, spawnRunner } from './runtime.js';
import { discoverEngine, Provisioner } from './provision.js';

export const name='omarchy-runtime';
export const inject=['tools','connection'];
const obj=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const text=description=>({type:'string',description});
export async function apply(ctx,config={}){
  const dataDir=config.dataDir||path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'.local','share'),'dsh-omarchy');
  let engine=await discoverEngine();
  let runtime;
  const build=()=>new Runtime({dataDir,engine:engine.kind,executable:engine.executable,image:'docker.io/library/archlinux:base',cpus:config.cpus??2,memoryMB:config.memoryMB??2048,idleMinutes:config.idleMinutes??10,ephemeralMinutes:config.ephemeralMinutes??30,
    runner: (file,args,options)=>spawnRunner(file,args,options)});
  runtime=build();
  const setup=new Provisioner(dataDir,async next=>{await runtime.dispose();engine=next;runtime=build()});
  let sweeping=false;
  ctx.effect(()=>{const timer=setInterval(async()=>{if(sweeping)return;sweeping=true;try{await runtime.sweep()}catch{}finally{sweeping=false}},30000);timer.unref?.();return async()=>{clearInterval(timer);await setup.dispose();await runtime.dispose()}});
  const sharedId=input=>input?.projectPath && !input.workspaceId && input.mode!=='isolated' && input.mode!=='ephemeral' ? `project-${createHash('sha256').update(path.resolve(input.projectPath)).digest('hex').slice(0,20)}` : input?.workspaceId;
  const options=input=>({...input,workspaceId:sharedId(input)});
  const service={
    async status(){const state=await runtime.status();return {...state,engine:engine.kind,setup:setup.snapshot(),edition:'Arch headless preview',version:'0.1.0',desktopAvailable:false,resources:{cpus:config.cpus??2,memoryMB:config.memoryMB??2048,diskLimit:false,network:'bridge'}}},
    ensureWorkspace:input=>runtime.ensureWorkspace(options(input||{})),
    exec:(input,signal)=>runtime.exec(options(input||{}),signal),
    suspend:id=>runtime.suspend(id),resume:id=>runtime.resume(id),stop:id=>runtime.stop(id),destroy:id=>runtime.destroy(id),
    snapshot:(id,label)=>runtime.snapshot(id,label),restore:(id,snapshotId)=>runtime.restore(id,snapshotId),
    logs:()=>runtime.logs(),
  };
  ctx.reflect.provide('omarchy',service);
  async function operation(action,input={},signal){
    if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Expected an input object');
    if(action==='status')return service.status();
    if(action==='logs')return {logs:service.logs()};
    if(action==='ensure')return service.ensureWorkspace(input);
    if(action==='exec')return service.exec(input,signal);
    if(['suspend','resume','stop','destroy'].includes(action)){if(typeof input.workspaceId!=='string')throw new Error('workspaceId required');return service[action](input.workspaceId)}
    if(action==='snapshot')return service.snapshot(input.workspaceId,input.name);
    if(action==='restore')return service.restore(input.workspaceId,input.snapshotId);
    throw new Error('Unknown operation');
  }
  const tool=(name,description,parameters,action)=>ctx.tools.register({name,description,parameters,timeoutMs:660000,
    output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value,null,2)}]},
    async execute(args,exec){return operation(action||args.action,args,exec.signal)}
  });
  ctx.effect(()=>tool('omarchy_status','Read Linux runtime availability, setup progress, workspace states and supported capabilities. Returns missing dependencies explicitly.',obj(),'status'));
  ctx.effect(()=>tool('omarchy_exec','Run a shell command inside an isolated Arch Linux workspace and return stdout, stderr and exit code. Reuses the selected workspace or creates a project workspace. Requires completed runtime setup.',obj({workspaceId:text('Existing workspace ID; omit to select by project.'),projectPath:text('Absolute host project directory to mount read-write at /workspace; omit for an isolated filesystem.'),command:text('Linux shell command.'),cwd:text('Absolute working directory inside the container; default /workspace.'),timeoutSec:{type:'integer',description:'Execution timeout in seconds, default 60, maximum 600.'}},['command']),'exec'));
  ctx.effect(()=>tool('omarchy_workspace','Manage Linux workspaces: ensure, suspend (stop and release memory), resume, stop, destroy, snapshot, restore or logs. Destroy removes the container filesystem; snapshots exclude mounted project files. Restore may be unsupported; check status.',obj({action:{type:'string',enum:['ensure','suspend','resume','stop','destroy','snapshot','restore','logs']},workspaceId:text('Workspace ID required for lifecycle operations.'),projectPath:text('Absolute project directory for ensure.'),mode:{type:'string',enum:['shared','isolated','ephemeral']},name:text('Optional snapshot label.'),snapshotId:text('Snapshot ID for restore.')},['action'])));
  ctx.effect(()=>ctx.connection.fetch.register({path:'/api/omarchy-runtime',methods:['GET','POST'],requestBody:'buffered',fetch:async request=>{
    try{
      if(request.method==='GET')return Response.json(await service.status(),{headers:{'Cache-Control':'no-store'}});
      if(!request.headers.get('content-type')?.startsWith('application/json'))return Response.json({error:'JSON required'},{status:415});
      const body=await request.text();if(body.length>65536)return Response.json({error:'Request too large'},{status:413});
      const {action,input}=JSON.parse(body);
      // Setup and image upgrade are user-only actions, absent from agent tools and Service.
      let result;
      if(action==='setup')result=setup.start();
      else if(action==='upgrade'){
        const pulled=await run(engine.executable,['pull','--platform','linux/amd64','docker.io/library/archlinux:base'],{timeoutMs:900000,signal:request.signal});
        if(pulled.code!==0)throw new Error((pulled.stderr||'Image update failed').slice(-2000));
        result={updated:true,detail:'Arch base image updated. Existing workspaces keep their current filesystem until recreated; the DSH plugin itself is upgraded through the Plugins page.'};
      }else result=await operation(action,input,request.signal);
      return Response.json({ok:true,result},{headers:{'Cache-Control':'no-store'}});
    }catch(error){return Response.json({ok:false,error:error.message,code:error.code||'RUNTIME_ERROR'},{status:400})}
  }}));
}
