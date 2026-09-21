import type {IncomingMessage,ServerResponse} from "node:http";
import {randomUUID} from "node:crypto";
import {readFile,realpath} from "node:fs/promises";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {hashFile,probe} from "@decupa/media";
import {serveMedia} from "../../http/media.ts";
import {originAllowed} from "../../http/origin.ts";
import {selectLocalFiles,type SelectResult} from "../assembly/select.ts";
import {analyzeRecipe,relinkRecipe,type RecipeAnalysisDeps} from "./analysis.ts";
import {approveRecipe,listRecipes,loadRecipe,saveRecipe,validateRecipe,recipeId} from "./store.ts";
import type {Recipe} from "./types.ts";
const jobs=new Map<string,AbortController>();
const HERE=fileURLToPath(new URL(".",import.meta.url));
class HttpError extends Error {constructor(public status:number,message:string){super(message);}}
function json(res:ServerResponse,value:unknown,status=200){res.writeHead(status,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify(value));}
async function body(req:IncomingMessage):Promise<Record<string,unknown>>{
 const parts:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>1024*1024)throw new HttpError(413,"pedido excede 1 MiB");parts.push(Buffer.from(chunk));}
 try{const value=JSON.parse(Buffer.concat(parts).toString()||"{}");if(!value||typeof value!=="object"||Array.isArray(value))throw Error();return value;}catch{throw new HttpError(400,"JSON inválido");}
}
type Deps=Omit<RecipeAnalysisDeps,"workDir"|"persist">&{port:()=>number;selectFn?:()=>Promise<SelectResult>};
export function createTemplateRuntime(root:string,deps:Deps){
 async function recover(r:Recipe):Promise<Recipe>{
  if(r.analysis.status!=="running"||jobs.has(join(root,r.id)))return r;
  let alive=false;if(r.analysis.pid&&r.analysis.pid!==process.pid)try{process.kill(r.analysis.pid,0);alive=true;}catch{/* stopped */}
  if(alive)return r;
  const next={...r,analysis:{status:"error" as const,stage:r.analysis.stage,error:"Análise interrompida; retome para reutilizar etapas concluídas."}};
  await saveRecipe(root,next,r.revision);return next;
 }
 async function handleTemplates(req:IncomingMessage,res:ServerResponse):Promise<boolean>{
  const url=new URL(req.url??"/","http://localhost");if(url.pathname!=="/templates"&&!url.pathname.startsWith("/templates/"))return false;
  try{
   if(req.method!=="GET"&&!originAllowed(req.headers.origin,deps.port()))throw new HttpError(403,"origem não permitida");
   const staticFiles:Record<string,[string,string]>={"/templates":["page.html","text/html"],"/templates/":["page.html","text/html"],"/templates/page.js":["page.js","text/javascript"],"/templates/page.css":["page.css","text/css"]};
   const asset=staticFiles[url.pathname];if(req.method==="GET"&&asset){res.writeHead(200,{"content-type":asset[1]+"; charset=utf-8","cache-control":"no-store"});res.end(await readFile(join(HERE,asset[0]),"utf8"));return true;}
   const parts=url.pathname.split("/").filter(Boolean);if(parts[1]!=="api"||parts.length>4)throw new HttpError(404,"rota desconhecida");
   const input=req.method==="GET"?{}:await body(req);
   if(parts.length===2){
    if(req.method==="GET"){const all=await listRecipes(root);const recipes=[];for(const r of all)recipes.push(r.status==="draft"?await recover(r):r);json(res,{recipes});return true;}
    if(req.method!=="POST")throw new HttpError(405,"método inválido");
    if(typeof input.name!=="string"||!input.name.trim()||input.name.length>200)throw new HttpError(400,"informe um nome de até 200 caracteres");
    const selected=await (deps.selectFn??selectLocalFiles)();if("cancelled"in selected){json(res,{cancelled:true});return true;}
    if(selected.paths.length!==1)throw new HttpError(400,"selecione um vídeo base");
    const path=await realpath(selected.paths[0]!);const info=await probe(path);if(!info.hasVideo||info.durationMs<=0)throw new HttpError(400,"referência precisa conter vídeo válido");
    const recipe:Recipe={id:randomUUID(),revision:1,name:input.name.trim(),status:"draft",source:{path,sha256:await hashFile(path),durationSeconds:info.durationMs/1000},analysis:{status:"pending",stage:"media"},rules:[]};
    await saveRecipe(root,recipe,null);json(res,{recipe},201);return true;
   }
   const id=recipeId(parts[2]!);const key=join(root,id);const action=parts[3];
   const revision=url.searchParams.has("revision")?Number(url.searchParams.get("revision")):undefined;
   if(revision!==undefined&&(!Number.isSafeInteger(revision)||revision<1))throw new HttpError(400,"revisão inválida");
   let recipe=await recover(await loadRecipe(root,id,req.method==="GET"?revision:undefined));
   if(req.method==="GET"){
    if(action==="media"){if(await hashFile(recipe.source.path)!==recipe.source.sha256)throw new HttpError(409,"referência mudou; religue o original");await serveMedia(req,res,recipe.source.path);return true;}
    if(action)throw new HttpError(404,"rota desconhecida");json(res,{recipe});return true;
   }
   if(input.baseRevision!==recipe.revision)throw new HttpError(409,"revisão desatualizada; recarregue o template");
   if(action==="cancel"&&req.method==="POST"){const job=jobs.get(key);if(!job)throw new HttpError(409,"análise não está neste servidor");job.abort();json(res,{recipe});return true;}
   if(recipe.analysis.status==="running")throw new HttpError(409,"análise em andamento; cancele antes de editar");
   if(!action&&req.method==="PATCH"){
    if(Object.keys(input).some(k=>!["baseRevision","name","rules"].includes(k)))throw new HttpError(400,"somente nome e orientações podem ser editados");
    const next=validateRecipe({...recipe,revision:recipe.revision+1,status:"draft",name:input.name??recipe.name,rules:input.rules??recipe.rules});await saveRecipe(root,next,recipe.revision);json(res,{recipe:next});return true;
   }
   if(req.method!=="POST")throw new HttpError(405,"método inválido");
   if(action==="approve"){const next=approveRecipe(recipe,recipe.revision);await saveRecipe(root,next,recipe.revision);json(res,{recipe:next});return true;}
   if(action==="relink"){
    const selected=await(deps.selectFn??selectLocalFiles)();if("cancelled"in selected){json(res,{cancelled:true});return true;}
    if(selected.paths.length!==1)throw new HttpError(400,"selecione um vídeo");
    const next={...await relinkRecipe(recipe,selected.paths[0]!),revision:recipe.revision+1,status:"draft" as const};await saveRecipe(root,next,recipe.revision);json(res,{recipe:next});return true;
   }
   if(action==="analyze"){
    const allowModel=deps.allowModel||input.modelOptIn===true;const allowVisual=deps.allowVisual||input.visualOptIn===true;
    if(!allowModel||!allowVisual)throw new HttpError(402,"Autorize a análise externa desta referência antes de continuar.");
    const previous=recipe.revision;
    recipe={...recipe,revision:previous+1,status:"draft",analysis:{status:"running",stage:"media",pid:process.pid}};
    await saveRecipe(root,recipe,previous);const ctrl=new AbortController();jobs.set(key,ctrl);
    void analyzeRecipe(recipe,{...deps,allowModel,allowVisual,workDir:join(root,id,"analysis"),persist:async next=>{await saveRecipe(root,next,recipe.revision);}},ctrl.signal).catch(()=>{}).finally(()=>jobs.delete(key));
    json(res,{recipe},202);return true;
   }
   throw new HttpError(404,"ação desconhecida");
  }catch(error){
   const message=error instanceof Error?error.message:String(error);
   const status=error instanceof HttpError?error.status:(error as NodeJS.ErrnoException).code==="ENOENT"?404:/inválid|fora do vídeo|evidência/.test(message)?400:409;
   if(!res.headersSent)json(res,{error:message},status);else res.end();return true;
  }
 }
 return {handleTemplates};
}
