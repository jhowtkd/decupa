import {expect,it,afterEach} from "vitest";
import {createServer} from "node:http";import {copyFile,mkdtemp,mkdir,readFile,realpath,rm} from "node:fs/promises";import {tmpdir} from "node:os";import {join} from "node:path";
import {createTemplateRuntime} from "./routes.ts";import {loadRecipe,saveRecipe} from "./store.ts";
import {FIXTURES} from "../../../../../tests/fixtures/global-setup.ts";
import {startApp} from "../server.ts";
import {hashFile} from "@decupa/media";
const closes:Array<()=>Promise<void>>=[];const tempDirs:string[]=[];
afterEach(async()=>{for(const close of closes.splice(0))await close();for(const dir of tempDirs.splice(0))await rm(dir,{recursive:true,force:true});});
async function tempDir(prefix:string){const path=await realpath(await mkdtemp(join(tmpdir(),prefix)));tempDirs.push(path);return path;}
async function boot(){const root=await mkdtemp(join(tmpdir(),"template-routes-"));let port=0;let calls=0;
 const runtime=createTemplateRuntime(root,{port:()=>port,selectFn:async()=>({paths:[join(FIXTURES,"clip.mp4")]}),exec:{run:async()=>{calls++;throw Error("external blocked");}},send:async()=>{calls++;return "{}";},modelKey:"test",allowModel:false,allowVisual:false});
 const server=createServer((req,res)=>{void runtime.handleTemplates(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}});});await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));port=(server.address() as {port:number}).port;closes.push(()=>new Promise(r=>server.close(()=>r())));
 const base=`http://127.0.0.1:${port}`;const create=await fetch(base+"/templates/api",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Evento"})});const {recipe}=await create.json() as any;
 return {root,base,recipe,calls:()=>calls};}
it("apenas approve publica versão vista; PATCH não aprova",async()=>{
 const {base,root,recipe}=await boot();let r=await fetch(base+`/templates/api/${recipe.id}`,{method:"PATCH",body:JSON.stringify({baseRevision:1,status:"approved",name:"Hack",rules:[]})});expect(r.status).toBe(400);
 r=await fetch(base+`/templates/api/${recipe.id}/approve`,{method:"POST",body:JSON.stringify({baseRevision:1})});expect(r.status).toBe(409);
 await saveRecipe(root,{...recipe,analysis:{status:"ready",stage:"complete"}},1);
 r=await fetch(base+`/templates/api/${recipe.id}/approve`,{method:"POST",body:JSON.stringify({baseRevision:1})});expect(r.status).toBe(200);
 expect((await loadRecipe(root,recipe.id,1)).status).toBe("approved");
});
it("protege origem, consentimento e tamanho de body",async()=>{
 const {base,recipe,calls}=await boot();
 expect((await fetch(base+`/templates/api/${recipe.id}/analyze`,{method:"POST",body:JSON.stringify({baseRevision:1})})).status).toBe(402);expect(calls()).toBe(0);
 expect((await fetch(base+"/templates/api",{method:"POST",headers:{origin:"https://evil.example"},body:"{}"})).status).toBe(403);
 expect((await fetch(base+"/templates/api",{method:"POST",body:"x".repeat(1024*1024+1)})).status).toBe(413);
 expect((await fetch(base+"/templates/api/not-an-id")).status).toBe(400);
});
it("referência cadastrada permite range e não path arbitrário",async()=>{
 const {base,recipe}=await boot();const r=await fetch(base+`/templates/api/${recipe.id}/media`,{headers:{range:"bytes=0-9"}});expect(r.status).toBe(206);expect((await r.arrayBuffer()).byteLength).toBe(10);
 expect((await fetch(base+"/templates/api/not-an-id/media")).status).toBe(400);
});
it("templates usa a configuração de origem da casca com host permitido",async()=>{
 const root=await mkdtemp(join(tmpdir(),"template-origin-config-"));await mkdir(join(root,"alpha"));
 const app=await startApp({projectsRoot:root,port:0,autoStart:false,templatesRoot:join(root,"templates"),
  executor:{run:async()=>({code:0,stdout:"",stderr:""})},selectFn:async()=>({paths:[join(FIXTURES,"clip.mp4")]}),
  env:{DECUPA_ALLOWED_HOSTS:"decupa.studio"}});
 try{
  const response=await fetch(`http://127.0.0.1:${app.port}/templates/api`,{method:"POST",headers:{host:`decupa.studio:${app.port}`,origin:"http://decupa.studio","content-type":"application/json"},body:JSON.stringify({name:"Evento"})});
  expect(response.status).toBe(201);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});

async function mediaRuntime(root:string,lookup?:(id:string)=>Promise<{id:string;path:string;nome:string;tamanho:number;duracao:number;criadoEm:number}|null>){
 let port=0;
 const runtime=createTemplateRuntime(root,{port:()=>port,...(lookup?{getMedia:lookup}:{}),
  exec:{run:async()=>{throw Error("external blocked");}},send:async()=>"{}",modelKey:"test",allowModel:false,allowVisual:false});
 const server=createServer((req,res)=>{void runtime.handleTemplates(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}});});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));port=(server.address() as {port:number}).port;
 closes.push(()=>new Promise(resolve=>server.close(()=>resolve())));
 return {base:`http://127.0.0.1:${port}`};
}
const record=(id:string,path:string)=>({id,path,nome:"clip.mp4",tamanho:1,duracao:1,criadoEm:Date.now()});
it("cria referência pelo mediaId do acervo sem seletor local",async()=>{
 const root=await tempDir("template-library-reference-");
 const path=join(FIXTURES,"clip.mp4");const mediaId=await hashFile(path);
 const {base}=await mediaRuntime(root,async id=>id===mediaId?record(id,path):null);
 const response=await fetch(base+"/templates/api",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Acervo",mediaId})});
 expect(response.status).toBe(201);
 const {recipe}=await response.json() as any;
 expect(recipe.source.sha256).toBe(mediaId);
 expect(recipe.source.path).toBe(path);
});

it("rejeita mediaId inválido/desconhecido e indisponibilidade do acervo",async()=>{
 const root=await tempDir("template-library-errors-");const {base}=await mediaRuntime(root,async()=>null);
 const post=async(mediaId:unknown)=>fetch(base+"/templates/api",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Acervo",mediaId})});
 expect((await post("../arquivo.mp4")).status).toBe(400);
 expect((await post("a".repeat(64))).status).toBe(404);
 const unavailableRoot=await tempDir("template-library-unavailable-");const unavailable=await mediaRuntime(unavailableRoot);
 expect((await fetch(unavailable.base+"/templates/api",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Acervo",mediaId:"a".repeat(64)})})).status).toBe(503);
 const rejectedRoot=await tempDir("template-library-rejected-");const rejected=await mediaRuntime(rejectedRoot,async()=>{throw Error("media store offline");});
 expect((await fetch(rejected.base+"/templates/api",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Acervo",mediaId:"a".repeat(64)})})).status).toBe(503);
});

it("valida vídeo real e recusa divergência entre mediaId e conteúdo",async()=>{
 const root=await tempDir("template-library-video-check-");const video=join(FIXTURES,"clip.mp4"),audio=join(FIXTURES,"tone-gap.wav");
 const videoId=await hashFile(video),audioId=await hashFile(audio);const {base}=await mediaRuntime(root,async id=>id===videoId?record(id,audio):id===audioId?record(id,video):null);
 const post=async(mediaId:string)=>fetch(base+"/templates/api",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Vídeo",mediaId})});
 expect((await post(videoId)).status).toBe(400);
 expect((await post(audioId)).status).toBe(409);
  expect((await (await fetch(base+"/templates/api")).json() as any).recipes).toHaveLength(0);
});

it("cria template a partir da mídia publicada pelo upload HTTP e mantém metadados do acervo",async()=>{
 const root=await tempDir("template-upload-flow-");const input=await readFile(join(FIXTURES,"clip.mp4"));const mediaRoot=join(root,"media");
 const app=await startApp({projectsRoot:join(root,"projects"),port:0,autoStart:false,templatesRoot:join(root,"templates"),providerConfigDir:join(root,"config"),executor:{run:async()=>({code:0,stdout:"",stderr:""})},env:{DECUPA_MEDIA_ROOT:mediaRoot,DECUPA_UPLOAD_PART_BYTES:"65536"}});
 try{
 const base=`http://127.0.0.1:${app.port}`;const created=await fetch(base+"/api/uploads",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({nome:"capturado.mp4",tamanho:input.length})});expect([200,201]).toContain(created.status);
  const upload=await created.json() as {id:string;tamanhoParte:number};let mediaId="";
  for(let offset=0;offset<input.length;){const end=Math.min(input.length,offset+upload.tamanhoParte)-1;const part=await fetch(base+`/api/uploads/${upload.id}`,{method:"PATCH",headers:{"Content-Range":`bytes ${offset}-${end}/${input.length}`},body:input.subarray(offset,end+1)});expect(part.status).toBe(end+1===input.length?201:200);if(end+1===input.length)mediaId=(await part.json() as {mediaId:string}).mediaId;offset=end+1;}
  const library=await (await fetch(base+"/api/media")).json() as any[];expect(library).toEqual([expect.objectContaining({id:mediaId,nome:"capturado.mp4",tamanho:input.length})]);
  const template=await fetch(base+"/templates/api",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Upload web",mediaId})});expect(template.status).toBe(201);
  const {recipe}=await template.json() as any;expect(recipe.source.sha256).toBe(mediaId);expect(recipe.source.path).toBe(join(mediaRoot,"pool",mediaId));
  const relink=await fetch(base+`/templates/api/${recipe.id}/relink`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({baseRevision:1,mediaId})});expect(relink.status).toBe(200);
  const {recipe:relinked}=await relink.json() as any;expect(relinked).toMatchObject({revision:2,status:"draft",source:{sha256:mediaId,path:recipe.source.path}});
  const alias=await fetch(base+"/templates/media-upload.js");expect(alias.status).toBe(200);expect(await alias.text()).toContain("ResumableMediaUpload");
 }finally{await app.close();}
});

it("relink por acervo preserva hash, aprovação histórica e só avança revisão no sucesso",async()=>{
 const root=await tempDir("template-library-relink-");const original=join(FIXTURES,"clip.mp4");
 const dir=await tempDir("template-library-copy-");const relinked=join(dir,"same-content.mp4");await copyFile(original,relinked);
 const mediaId=await hashFile(original);const {base}=await mediaRuntime(root,async id=>id===mediaId?record(id,relinked):null);
 const created=await fetch(base+"/templates/api",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Acervo",mediaId})});
 const {recipe}=await created.json() as any;await saveRecipe(root,{...recipe,analysis:{status:"ready",stage:"complete"}},1);
 const approved=await fetch(base+`/templates/api/${recipe.id}/approve`,{method:"POST",body:JSON.stringify({baseRevision:1})});expect(approved.status).toBe(200);
 const relink=await fetch(base+`/templates/api/${recipe.id}/relink`,{method:"POST",body:JSON.stringify({baseRevision:1,mediaId})});expect(relink.status).toBe(200);
 const {recipe:next}=await relink.json() as any;expect(next.revision).toBe(2);expect(next.status).toBe("draft");expect(next.source.sha256).toBe(mediaId);expect(next.source.path).toBe(relinked);
 expect((await loadRecipe(root,recipe.id,1)).status).toBe("approved");
 const missing=await fetch(base+`/templates/api/${recipe.id}/relink`,{method:"POST",body:JSON.stringify({baseRevision:2,mediaId:"b".repeat(64)})});expect(missing.status).toBe(404);
 expect((await loadRecipe(root,recipe.id)).revision).toBe(2);
 const stale=await fetch(base+`/templates/api/${recipe.id}/relink`,{method:"POST",body:JSON.stringify({baseRevision:1,mediaId})});expect(stale.status).toBe(409);
 expect(await loadRecipe(root,recipe.id)).toEqual(next);
});
