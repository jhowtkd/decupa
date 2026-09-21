import {expect,it} from "vitest";
import {mkdtemp,copyFile,readFile,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";import {join} from "node:path";
import {createHash} from "node:crypto";
import {hashFile} from "@decupa/media";
import {FIXTURES} from "../../../../../tests/fixtures/global-setup.ts";
import {blankProject} from "./routes.ts";
import {createProject,saveProject} from "./store.ts";
import {deliverApproved,readDelivery} from "./delivery.ts";
import type {ExecCall} from "../pipeline.ts";
async function setup(){
 const dir=await mkdtemp(join(tmpdir(),"resolve-delivery-"));const p=blankProject("p");
 await copyFile(join(FIXTURES,"clip.mp4"),join(dir,"preview.mp4"));
 p.previewRevision=0;p.finalApprovedRevision=0;p.previewArtifact={revision:0,relativePath:"preview.mp4",sha256:await hashFile(join(dir,"preview.mp4")),assemblySha256:createHash("sha256").update(JSON.stringify(p.assembly)).digest("hex")};
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
 const exec={run:async()=>{calls++;return {code:1,stdout:JSON.stringify({ok:false,error:"import failed"}),stderr:""};}};
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
