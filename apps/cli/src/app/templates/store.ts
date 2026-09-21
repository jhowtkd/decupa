import {readFile,readdir} from "node:fs/promises";
import {isAbsolute,join} from "node:path";
import {randomUUID} from "node:crypto";
import {publishAtomic} from "@decupa/cache";
import {createFileCoordinator} from "@decupa/coordinator";
import {RULE_CATEGORIES,type Recipe,type Rule} from "./types.ts";
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function recipeId(id:string){if(!uuid.test(id))throw Error("ID de template inválido");return id;}
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
function text(v:unknown,max=5000):v is string{return typeof v==="string"&&!!v.trim()&&v.length<=max;}
export function validateRules(raw:unknown,duration:number):Rule[]{
 if(!Array.isArray(raw)||raw.length>200)throw Error("orientações inválidas");
 const ids=new Set<string>();
 return raw.map(r=>{
  if(!record(r)||!text(r.id,200)||ids.has(r.id)||!RULE_CATEGORIES.includes(r.category as Rule["category"])||!text(r.observation)||!text(r.instruction)||typeof r.enabled!=="boolean"||!["observed","uncertain","unavailable"].includes(String(r.confidence))||!Array.isArray(r.evidence))throw Error("orientação inválida");
  ids.add(r.id);
  if(r.evidence.length>500|| (r.confidence!=="unavailable"&&!r.evidence.length))throw Error("evidência ausente");
  const evidence=r.evidence.map(e=>{if(!record(e)||typeof e.start!=="number"||typeof e.end!=="number"||!Number.isFinite(e.start)||!Number.isFinite(e.end)||e.start<0||e.end<=e.start||e.end>duration)throw Error("evidência fora do vídeo");return {start:e.start,end:e.end};});
  return {id:r.id,category:r.category as Rule["category"],observation:r.observation,instruction:r.instruction,enabled:r.enabled,confidence:r.confidence as Rule["confidence"],evidence};
 });
}
export function validateRecipe(raw:unknown):Recipe{
 if(!record(raw)||!text(raw.id,100))throw Error("template inválido");recipeId(raw.id);
 if(!Number.isSafeInteger(raw.revision)||(raw.revision as number)<1||!text(raw.name,200)||!["draft","approved"].includes(String(raw.status))||!record(raw.source)||!record(raw.analysis))throw Error("template inválido");
 const s=raw.source,a=raw.analysis;
 if(!text(s.path,8192)||!isAbsolute(s.path)||typeof s.sha256!=="string"||!/^[a-f0-9]{64}$/.test(s.sha256)||typeof s.durationSeconds!=="number"||!Number.isFinite(s.durationSeconds)||s.durationSeconds<=0)throw Error("mídia base inválida");
 if(!["pending","running","ready","error","cancelled"].includes(String(a.status))||!text(a.stage,200)|| (a.error!==undefined&&!text(a.error,10000))||(a.pid!==undefined&&(!Number.isSafeInteger(a.pid)||(a.pid as number)<1)))throw Error("análise inválida");
 if(raw.status==="approved"&&a.status!=="ready")throw Error("análise incompleta");
 return {id:raw.id,revision:raw.revision as number,name:raw.name,status:raw.status as Recipe["status"],source:{path:s.path,sha256:s.sha256,durationSeconds:s.durationSeconds},analysis:{status:a.status as Recipe["analysis"]["status"],stage:a.stage,...(a.error?{error:a.error as string}:{}),...(a.pid?{pid:a.pid as number}:{})},rules:validateRules(raw.rules,s.durationSeconds)};
}
export function approveRecipe(recipe:Recipe,expectedRevision:number):Recipe{
 if(recipe.revision!==expectedRevision)throw Error("revisão desatualizada");
 if(recipe.analysis.status!=="ready")throw Error("análise incompleta");
 return validateRecipe({...recipe,status:"approved"});
}
type LibraryEntry={current:Recipe;approved:Recipe[]};
const entryPath=(root:string,id:string)=>join(root,recipeId(id),"recipe.json");
async function entry(root:string,id:string):Promise<LibraryEntry>{return JSON.parse(await readFile(entryPath(root,id),"utf8"));}
export async function saveRecipe(root:string,recipe:Recipe,expectedRevision:number|null):Promise<void>{
 const valid=validateRecipe(recipe);
 await createFileCoordinator(join(root,".writers"),{limit:1}).run({id:randomUUID(),stage:"save-template",build:async()=>{
  let old:LibraryEntry|undefined;try{old=await entry(root,valid.id);}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  if((old?.current.revision??null)!==expectedRevision)throw Error("revisão desatualizada");
  if(old?.current.status==="approved" && valid.revision<=old.current.revision)throw Error("revisão aprovada é imutável");
  if(valid.revision!==(expectedRevision??0)+1 && !(old?.current.status==="draft"&&valid.revision===expectedRevision))throw Error("revisão inválida");
  const approved=old?.approved??[];
  if(valid.status==="approved"){
   if(!old||old.current.status!=="draft"||JSON.stringify({...old.current,status:"approved"})!==JSON.stringify(valid))throw Error("aprove somente o rascunho salvo");
   if(approved.some(r=>r.revision===valid.revision))throw Error("revisão aprovada é imutável");
   approved.push(structuredClone(valid));
  }
  await publishAtomic(entryPath(root,valid.id),JSON.stringify({current:valid,approved}));
 }});
}
export async function loadRecipe(root:string,id:string,revision?:number):Promise<Recipe>{
 const data=await entry(root,id);
 const found=revision===undefined?data.current:data.approved.find(r=>r.revision===revision);
 if(!found)throw Error("revisão aprovada não encontrada");return validateRecipe(found);
}
export async function listRecipes(root:string):Promise<Recipe[]>{
 let names:string[];try{names=await readdir(root);}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return [];throw e;}
 const result:Recipe[]=[];
 for(const id of names.filter(n=>uuid.test(n))){const data=await entry(root,id);result.push(validateRecipe(data.current));const last=data.approved.at(-1);if(last&&last.revision!==data.current.revision)result.push(validateRecipe(last));}
 return result;
}

export function approvedSnapshot(raw:unknown):Recipe|null{
 if(raw===null||raw===undefined)return null;
 if(!record(raw)||raw.status!=="approved")throw Error("template não aprovado");
 return structuredClone(validateRecipe(raw));
}
export function validateTemplateReport(raw:unknown,recipe:Recipe|null):import("../assembly/types.ts").TemplateReport {
 const rules=recipe?.rules.filter(r=>r.enabled)??[];
 if(!Array.isArray(raw)||raw.length!==rules.length)throw Error("relatório do template incompleto");
 const seen=new Set<string>();
 return raw.map(r=>{
  if(!record(r)||typeof r.ruleId!=="string"||seen.has(r.ruleId)||!rules.some(rule=>rule.id===r.ruleId)||!["applied","adapted","unavailable"].includes(String(r.status))||!text(r.reason))throw Error("relatório do template inválido");
  const sceneIds=r.sceneIds;
  if(sceneIds!==undefined&&(!Array.isArray(sceneIds)||sceneIds.length>200||sceneIds.some(id=>typeof id!=="string"||!id.trim())))throw Error("relatório do template inválido");
  seen.add(r.ruleId);return {ruleId:r.ruleId,status:r.status as "applied"|"adapted"|"unavailable",reason:r.reason,...(sceneIds?{sceneIds:[...new Set(sceneIds as string[])]}:{})};
 });
}
