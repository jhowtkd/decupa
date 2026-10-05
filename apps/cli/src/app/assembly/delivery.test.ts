import {spawn} from "node:child_process";
import {createServer} from "node:net";
import {once} from "node:events";
import {expect,it} from "vitest";
import {mkdtemp,copyFile,readFile,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";import {join} from "node:path";
import {createHash} from "node:crypto";
import {hashFile} from "@decupa/media";
import {FIXTURES} from "../../../../../tests/fixtures/global-setup.ts";
import {referenceForAssembly} from "../../../../../tests/fixtures/timeline-reference.ts";
import {blankProject} from "./routes.ts";
import {fixtureAssembly} from "./fixture.ts";
import {createProject,saveProject} from "./store.ts";
import {deliverApproved,readDelivery} from "./delivery.ts";
import type {ExecCall} from "../pipeline.ts";
async function setup(){
 const dir=await mkdtemp(join(tmpdir(),"resolve-delivery-"));const p=blankProject("p");
 const media=join(dir,"fala.mp4");
 await copyFile(join(FIXTURES,"clip.mp4"),media);
 const sample=fixtureAssembly().sources[0]!;
 p.assembly.sources=[{...sample,id:"a",path:media,sha256:await hashFile(media),name:"fala.mp4",durationSeconds:3}];
 const clip={id:"v1",sceneId:"s1",sourceId:"a",sourceStartSeconds:0,startFrame:0,durationFrames:75};
 p.assembly.tracks[0]!.clips=[{...clip,id:"v1"}];
 p.assembly.tracks[2]!.clips=[{...clip,id:"a1"}];
 const preview=join(dir,"preview.mp4");
 await copyFile(await referenceForAssembly(p.assembly),preview);
 p.previewRevision=0;p.finalApprovedRevision=0;p.previewArtifact={revision:0,relativePath:"preview.mp4",sha256:await hashFile(preview),assemblySha256:createHash("sha256").update(JSON.stringify(p.assembly)).digest("hex")};
 await createProject(dir,p);return {dir,p};
}
it("não chama ponte sem aprovação",async()=>{
 let calls=0;const exec={run:async()=>{calls++;return {code:0,stdout:"",stderr:""};}};
 await expect(deliverApproved(blankProject("p"),"/tmp/unused",exec,new AbortController().signal)).rejects.toThrow(/aprovação/);expect(calls).toBe(0);
});
it("repete entrega abrindo projeto e exporta DRP sem reimportação",async()=>{
 const {dir,p}=await setup();const modes:string[]=[];
 const exec={run:async(call:ExecCall)=>{const r=JSON.parse(await readFile(call.args.at(-1)!,"utf8"));modes.push(r.mode);call.onLine?.(JSON.stringify({stage:"created",projectName:r.projectName}));if(r.drpPath)await writeFile(r.drpPath,"drp");return {code:0,stdout:JSON.stringify({ok:true,projectName:r.projectName,verified:r.mode==="create",drpPath:r.drpPath}),stderr:""};}};
 const first=await deliverApproved(p,dir,exec,new AbortController().signal);
 await deliverApproved(p,dir,exec,new AbortController().signal);
 const third=await deliverApproved(p,dir,exec,new AbortController().signal,{exportDrp:true});
 expect(modes).toEqual(["create","open","export"]);expect(third.projectName).toBe(first.projectName);expect(third.drpPath).toMatch(/\.drp$/);
 expect((await readDelivery(dir,0))?.status).toBe("ready");
});
it("falha parcial fica registrada e exige nova cópia explícita",async()=>{
 const {dir,p}=await setup();let calls=0;
 const exec={run:async(call:ExecCall)=>{calls++;call.onLine?.(JSON.stringify({stage:"created"}));return {code:1,stdout:JSON.stringify({ok:false,error:"import failed"}),stderr:""};}};
 await expect(deliverApproved(p,dir,exec,new AbortController().signal)).rejects.toThrow(/import failed/);
 expect((await readDelivery(dir,0))?.status).toBe("error");
 await expect(deliverApproved(p,dir,exec,new AbortController().signal)).rejects.toThrow(/cópia/);expect(calls).toBe(1);
});
it("edição durante entrega não é anunciada como revisão atual",async()=>{
 const {dir,p}=await setup();const exec={run:async(call:ExecCall)=>{
 const r=JSON.parse(await readFile(call.args.at(-1)!,"utf8"));await saveProject(dir,0,{...p,revision:1,assembly:{...p.assembly,revision:1}});
 return {code:0,stdout:JSON.stringify({ok:true,projectName:r.projectName,verified:true}),stderr:""};}};
 await expect(deliverApproved(p,dir,exec,new AbortController().signal)).rejects.toThrow(/revisão mudou/);
 expect((await readDelivery(dir,0))?.status).toBe("ready");
});

it("falha ao reabrir preserva projeto entregue e permite tentar novamente",async()=>{
 const {dir,p}=await setup();const names:string[]=[];let fail=false;
 const exec={run:async(call:ExecCall)=>{const r=JSON.parse(await readFile(call.args.at(-1)!,"utf8"));names.push(r.projectName);return {code:fail?1:0,stdout:JSON.stringify(fail?{ok:false,error:"Resolve fechado"}:{ok:true,projectName:r.projectName,verified:true}),stderr:""};}};
 const first=await deliverApproved(p,dir,exec,new AbortController().signal);fail=true;
 for(const options of [{},{exportDrp:true}]){await expect(deliverApproved(p,dir,exec,new AbortController().signal,options)).rejects.toThrow(/fechado/);expect(await readDelivery(dir,0)).toMatchObject({status:"ready",projectName:first.projectName});}
 fail=false;await deliverApproved(p,dir,exec,new AbortController().signal);expect(new Set(names).size).toBe(1);
});

it("mutex bloqueia concorrência e é liberado pelo SO após morte do processo",async()=>{
 const child=spawn(process.execPath,["--input-type=module","-e",'import {createServer} from "node:net";createServer(s=>s.destroy()).listen({host:"127.0.0.1",port:47789,exclusive:true},()=>console.log("locked"));'],{stdio:["ignore","pipe","pipe"]});
 try{
  await once(child.stdout!,"data");const {dir,p}=await setup();let calls=0;
  const exec={run:async(call:ExecCall)=>{calls++;const r=JSON.parse(await readFile(call.args.at(-1)!,"utf8"));return {code:0,stdout:JSON.stringify({ok:true,projectName:r.projectName,verified:true}),stderr:""};}};
  await expect(deliverApproved(p,dir,exec,new AbortController().signal)).rejects.toThrow(/andamento/);expect(calls).toBe(0);
  const exited=once(child,"exit");child.kill("SIGKILL");await exited;
  expect((await deliverApproved(p,dir,exec,new AbortController().signal)).status).toBe("ready");expect(calls).toBe(1);
 }finally{if(child.exitCode===null)child.kill("SIGKILL");}
});

it("falha antes de criar projeto permite repetir sem nova cópia",async()=>{
 const {dir,p}=await setup();let calls=0;const exec={run:async()=>{calls++;return {code:1,stdout:JSON.stringify({ok:false,error:"API indisponível"}),stderr:""};}};
 for(let i=0;i<2;i++)await expect(deliverApproved(p,dir,exec,new AbortController().signal)).rejects.toThrow(/API indisponível/);
 expect(calls).toBe(2);expect(await readDelivery(dir,0)).toMatchObject({created:false,status:"error",stage:"connecting"});
});

it("entrega que não responde é interrompida, solta a porta e não volta a running", async () => {
  const { dir, p } = await setup();
  let releaseLate!: () => void;
  const late = new Promise<void>((resolve) => { releaseLate = resolve; });
  const exec = { run: async (call: ExecCall) => {
    const request = JSON.parse(await readFile(call.args[call.args.indexOf("--request") + 1]!, "utf8")) as { projectName: string };
    await new Promise((resolve) => setTimeout(resolve, 3000));
    call.onLine?.(JSON.stringify({ stage: "created" }));
    releaseLate();
    return { code: 0, stdout: JSON.stringify({ ok: true, projectName: request.projectName, verified: true }), stderr: "" };
  } };
  const started = Date.now();
  await expect(deliverApproved(p, dir, exec, new AbortController().signal, { timeoutMs: 100 })).rejects.toThrow(/interrompida/);
  expect(Date.now() - started).toBeLessThan(1500);
  expect((await readDelivery(dir, 0))?.status).toBe("error");
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 47789, exclusive: true }, () => server.close(() => resolve()));
  });
  await late;
  expect((await readDelivery(dir, 0))?.status).toBe("error");
});
