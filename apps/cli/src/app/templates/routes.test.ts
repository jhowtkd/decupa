import {expect,it,afterEach} from "vitest";
import {createServer} from "node:http";import {mkdtemp} from "node:fs/promises";import {tmpdir} from "node:os";import {join} from "node:path";
import {createTemplateRuntime} from "./routes.ts";import {loadRecipe,saveRecipe} from "./store.ts";
import {FIXTURES} from "../../../../../tests/fixtures/global-setup.ts";
const closes:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of closes.splice(0))await close();});
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
