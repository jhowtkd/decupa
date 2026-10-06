import {expect,it} from "vitest";
import {mkdir,mkdtemp,copyFile,readdir,readFile,writeFile} from "node:fs/promises";import {tmpdir} from "node:os";import {join} from "node:path";
import {createHash} from "node:crypto";
import {hashFile,probe} from "@decupa/media";
import {FIXTURES} from "../../../../../tests/fixtures/global-setup.ts";
import {analyzeRecipe,relinkRecipe,validateRules} from "./analysis.ts";
import type {Recipe} from "./types.ts";
import {resolveAppTransports} from "../analysis-transports.ts";
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

it("trocar Muse por Luna reutiliza ASR e recalcula visual/regras pelo transporte de cada etapa",async()=>{
 const {dir,r}=await setup();let speechCalls=0;const calls:{url:string;images:boolean}[]=[];
 const stored={preset:"custom" as const,apiKey:"meta-fake",model:"muse-spark-1.3-contributor",baseUrl:"https://api.meta.ai/v1/chat/completions"};
 let current:import("@decupa/triage").Credentials=stored;
 const fetchImpl=(async(url,init)=>{const body=JSON.parse(String(init?.body));const images=body.messages[0].content.some((p:{type:string})=>p.type==="image_url");calls.push({url:String(url),images});const value=images?{spans:[{id:"v",start:0,end:r.source.durationSeconds,text:String(url),confidence:"observed",tags:[]}]}:{rules:[]};return new Response(JSON.stringify({choices:[{finish_reason:"stop",message:{content:JSON.stringify(value)}}]}));}) as typeof fetch;
 const exec={run:async(call:import("../pipeline.ts").ExecCall)=>{const pattern=call.args.at(-1)!;for(let i=0;i<3;i++)await writeFile(pattern.replace("%03d",String(i).padStart(3,"0")),"fake frame");return {code:0,stdout:"",stderr:""};}};
 const deps={workDir:dir,exec,allowModel:true,allowVisual:true,persist:async()=>{},transcribe:async()=>{speechCalls++;return [];}};
 const initial=resolveAppTransports({stored,env:{},fetchImpl,loadStored:async()=>current});
 const initialDeps={...deps,send:initial.textSend,modelKey:initial.textKey,visualClient:initial.visualClient,resolveAnalysis:initial.resolveAnalysis};
 await analyzeRecipe(r,initialDeps,new AbortController().signal);await analyzeRecipe(r,initialDeps,new AbortController().signal);
 current={...stored,openaiApiKey:"new-ui-key"};
 await analyzeRecipe(r,initialDeps,new AbortController().signal);
 expect(speechCalls).toBe(1);expect(calls).toEqual([{url:stored.baseUrl,images:true},{url:stored.baseUrl,images:false},{url:"https://api.openai.com/v1/chat/completions",images:true},{url:stored.baseUrl,images:false}]);
 const lunarDeps=initialDeps;
 const folders=(await readdir(dir,{withFileTypes:true})).filter(item=>item.isDirectory());
 for(const folder of folders){const path=join(dir,folder.name,"speech.json");if(await readFile(path,"utf8").catch(()=>null)!==null)await writeFile(path,JSON.stringify([{id:"s",sourceId:r.id,start:0,end:1,text:"entrada nova"}]));}
 await analyzeRecipe(r,lunarDeps,new AbortController().signal);expect(speechCalls).toBe(1);expect(calls).toHaveLength(5);expect(calls.at(-1)).toEqual({url:stored.baseUrl,images:false});
 for(const folder of folders){const path=join(dir,folder.name,"visual.json");const raw=await readFile(path,"utf8").catch(()=>null);if(raw){const spans=JSON.parse(raw);if(spans[0]?.text.includes("openai")){spans[0].text="descrição corrigida";await writeFile(path,JSON.stringify(spans));}}}
 await analyzeRecipe(r,lunarDeps,new AbortController().signal);expect(speechCalls).toBe(1);expect(calls).toHaveLength(6);
});

it("templates migram recipe-v1 sem chamadas no padrão e reaproveitam só a fala no Luna",async()=>{
 const {dir,r}=await setup();let calls=0;
 const stored={preset:"custom" as const,apiKey:"fake",model:"muse-spark-1.3-contributor",baseUrl:"https://api.meta.ai/v1/chat/completions"};
 const legacyModelKey=JSON.stringify({model:stored.model,providerKey:stored.baseUrl});
 const legacy=join(dir,createHash("sha256").update(JSON.stringify([r.source.sha256,legacyModelKey,"recipe-v1"])).digest("hex"));
 await mkdir(legacy,{recursive:true});
 const speech=[{id:"s",sourceId:r.id,start:0,end:1,text:"fala legada"}];
 const visual=[{id:"v",sourceId:r.id,start:0,end:r.source.durationSeconds,text:"visual legado",confidence:"observed",tags:[]}];
 const rules=[{id:"r",category:"narrative",observation:"legada",instruction:"preserve",enabled:true,confidence:"observed",evidence:[{start:0,end:1}]}];
 for(const [name,value]of Object.entries({speech,visual,rules}))await writeFile(join(legacy,name+".json"),JSON.stringify(value));
 const fetchImpl=(async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));const images=body.messages[0].content.some((p:{type:string})=>p.type==="image_url");return new Response(JSON.stringify({choices:[{finish_reason:"stop",message:{content:JSON.stringify(images?{spans:[{...visual[0],text:"novo"}]}:{rules:[]})}}]}));}) as typeof fetch;
 const initial=resolveAppTransports({stored,env:{},fetchImpl});expect(initial.legacyModelKey).toBe(legacyModelKey);
 const exec={run:async(call:import("../pipeline.ts").ExecCall)=>{const pattern=call.args.at(-1)!;for(let i=0;i<3;i++)await writeFile(pattern.replace("%03d",String(i).padStart(3,"0")),"fake");return {code:0,stdout:"",stderr:""};}};
 const base={workDir:dir,exec,allowModel:true,allowVisual:true,persist:async()=>{},transcribe:async()=>{throw Error("ASR não deve rodar");}};
 const deps={...base,send:initial.textSend,modelKey:initial.textKey,legacyModelKey:initial.legacyModelKey,legacyVisualCompatible:initial.legacyVisualCompatible,visualClient:initial.visualClient};
 const result=await analyzeRecipe(r,deps,new AbortController().signal);expect(result.rules[0]).toEqual(rules[0]);expect(calls).toBe(0);
 await analyzeRecipe(r,deps,new AbortController().signal);expect(calls).toBe(0);
 await writeFile(join(legacy,"visual.json"),'{"bad":true}');
 await analyzeRecipe(r,deps,new AbortController().signal);expect(calls).toBe(0);
 await writeFile(join(legacy,"visual.json"),JSON.stringify(visual));
 const missing=resolveAppTransports({stored,env:{DECUPA_VISUAL_PROVIDER:"openai"},fetchImpl});
 await expect(analyzeRecipe(r,{...base,send:missing.textSend,modelKey:missing.textKey,legacyModelKey:missing.legacyModelKey,legacyVisualCompatible:missing.legacyVisualCompatible,visualClient:missing.visualClient},new AbortController().signal)).rejects.toThrow(/OPENAI_API_KEY/);
 expect(calls).toBe(0);
 const lunar=resolveAppTransports({stored,env:{DECUPA_VISUAL_PROVIDER:"openai",OPENAI_API_KEY:"fake"},fetchImpl});
 await analyzeRecipe(r,{...base,send:lunar.textSend,modelKey:lunar.textKey,legacyModelKey:lunar.legacyModelKey,legacyVisualCompatible:lunar.legacyVisualCompatible,visualClient:lunar.visualClient},new AbortController().signal);
 expect(calls).toBe(2);
 // O fallback não deve recolocar regras antigas depois de editar a fala migrada.
 for(const entry of await readdir(dir,{withFileTypes:true}))if(entry.isDirectory()&&entry.name!==legacy.split("/").at(-1)){
  const file=join(dir,entry.name,"speech.json");if(await readFile(file,"utf8").catch(()=>null))await writeFile(file,JSON.stringify([{...speech[0],text:"fala corrigida"}]));
 }
 await analyzeRecipe(r,deps,new AbortController().signal);expect(calls).toBe(3);
});
