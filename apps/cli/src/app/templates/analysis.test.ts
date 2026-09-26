import {expect,it} from "vitest";
import {mkdtemp,copyFile,writeFile} from "node:fs/promises";import {tmpdir} from "node:os";import {join} from "node:path";
import {hashFile,probe} from "@decupa/media";
import {FIXTURES} from "../../../../../tests/fixtures/global-setup.ts";
import {analyzeRecipe,relinkRecipe,validateRules} from "./analysis.ts";
import type {Recipe} from "./types.ts";
async function setup(){const dir=await mkdtemp(join(tmpdir(),"recipe-analysis-"));const path=join(dir,"base.mp4");await copyFile(join(FIXTURES,"clip.mp4"),path);const info=await probe(path);const r:Recipe={id:"11111111-1111-4111-8111-111111111111",revision:1,name:"Base",status:"draft",source:{path,sha256:await hashFile(path),durationSeconds:info.durationMs/1000},analysis:{status:"pending",stage:"media"},rules:[]};return {dir,r};}
it("recusa evidência fora do vídeo",()=>{expect(()=>validateRules([{id:"r",category:"rhythm",observation:"corte",instruction:"rápido",enabled:true,confidence:"observed",evidence:[{start:1,end:3}]}],2)).toThrow();});
it("consentimento bloqueia todos os transportes",async()=>{
 const {dir,r}=await setup();let calls=0;
 await expect(analyzeRecipe(r,{workDir:dir,exec:{run:async()=>{calls++;throw Error("no");}},send:async()=>{calls++;return "{}";},modelKey:"test",allowModel:false,allowVisual:false,persist:async()=>{}},new AbortController().signal)).rejects.toThrow(/autorizada/);expect(calls).toBe(0);
});
it("religação recusa outra mídia sem alterar receita",async()=>{const {dir,r}=await setup();await writeFile(join(dir,"other"),"different");await expect(relinkRecipe(r,join(dir,"other"))).rejects.toThrow(/identidade/);expect(r.source.path).toBe(join(dir,"base.mp4"));});
it("síntese retorna rascunho e retoma cache sem chamada paga",async()=>{
 const {dir,r}=await setup();let sends=0;const states:string[]=[];
 const deps={workDir:dir,exec:{run:async()=>{throw Error("unexpected");}},send:async()=>{sends++;return JSON.stringify({rules:[{id:"r",category:"rhythm",observation:"estimativa",instruction:"ritmo calmo",enabled:true,confidence:"observed",evidence:[{start:0,end:1}]}]});},modelKey:"test",allowModel:true,allowVisual:true,persist:async(p:Recipe)=>{states.push(p.analysis.status);},describe:async()=>[{id:"v",sourceId:r.id,start:0,end:r.source.durationSeconds,text:"cena",confidence:"observed" as const,tags:[]}],transcribe:async()=>[]};
 const result=await analyzeRecipe(r,deps,new AbortController().signal);expect(result.status).toBe("draft");expect(result.rules[0]!.confidence).toBe("uncertain");expect(result.rules).toHaveLength(7);expect(states.at(-1)).toBe("ready");
 await analyzeRecipe(r,deps,new AbortController().signal);expect(sends).toBe(1);
 await analyzeRecipe(r,{...deps,modelKey:"changed"},new AbortController().signal);expect(sends).toBe(2);
});
it("cancelamento persiste estado e não aprova parcial",async()=>{
 const {dir,r}=await setup();const ctrl=new AbortController();const states:string[]=[];
 const deps={workDir:dir,exec:{run:async()=>{throw Error("unexpected");}},send:async()=>"{}",modelKey:"t",allowModel:true,allowVisual:true,persist:async(p:Recipe)=>{states.push(p.analysis.status);},transcribe:async()=>{ctrl.abort();return [];},describe:async()=>[]};
 await expect(analyzeRecipe(r,deps,ctrl.signal)).rejects.toThrow();expect(states.at(-1)).toBe("cancelled");
});

it("lacuna visual inclusive cauda fracionária impede aprovação e pode ser reanalisada",async()=>{
 const {dir,r}=await setup();let end=r.source.durationSeconds-0.2;let calls=0;let saved:Recipe=r;
 const deps={workDir:dir,exec:{run:async()=>{throw Error("unexpected");}},send:async()=>JSON.stringify({rules:[]}),modelKey:"partial",allowModel:true,allowVisual:true,persist:async(p:Recipe)=>{saved=p;},transcribe:async()=>[],describe:async()=>{calls++;return [{id:"v",sourceId:r.id,start:0,end,text:"cena",confidence:"observed" as const,tags:[]}];}};
 await expect(analyzeRecipe(r,deps,new AbortController().signal)).rejects.toThrow(/Lacunas visuais/);expect(saved.analysis.status).toBe("error");expect(saved.analysis.error).toContain(end.toFixed(3));
 end=r.source.durationSeconds;expect((await analyzeRecipe(r,deps,new AbortController().signal)).analysis.status).toBe("ready");expect(calls).toBe(2);
});
