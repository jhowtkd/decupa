import {createHash, randomUUID} from "node:crypto";
import {mkdir,readFile,rename,stat,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {createServer} from "node:net";
import {fileURLToPath} from "node:url";
import type {Executor} from "../pipeline.ts";
import type {Project} from "./types.ts";
import {exportApproved} from "./export.ts";
import {buildHandoff} from "./handoff.ts";
import {loadProject} from "./store.ts";
export type DeliveryRecord={operationId:string;revision:number;assemblySha256:string;status:"running"|"ready"|"error";stage:string;projectName:string;pid:number;error?:string;drpPath?:string;previousReady?:DeliveryRecord;created?:boolean};
const active=new Set<string>();
const recordPath=(dir:string,rev:number)=>join(dir,"deliveries",String(rev),"resolve-delivery.json");
async function atomic(path:string,value:unknown){const temp=path+"."+randomUUID();await writeFile(temp,JSON.stringify(value,null,2));await rename(temp,path);}
export async function readDelivery(dir:string,revision:number):Promise<DeliveryRecord|null>{
 let record:DeliveryRecord;try{record=JSON.parse(await readFile(recordPath(dir,revision),"utf8"));}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw e;}
 if(record.status==="running"){
  let alive=true;try{process.kill(record.pid,0);}catch{alive=false;}
  if(!alive || (record.pid===process.pid&&!active.has(record.operationId)))return record.previousReady?{...record.previousReady,error:"Abertura interrompida; projeto salvo preservado. Tente novamente."}:{...record,status:"error",error:"Entrega interrompida; projeto parcial preservado. Solicite outra cópia."};
 }
 return record;
}
export async function deliverApproved(project:Project,dir:string,exec:Executor,signal:AbortSignal,options:{exportDrp?:boolean;newCopy?:boolean}={}):Promise<DeliveryRecord>{
 if(project.finalApprovedRevision!==project.revision)throw Error("aprovação final desatualizada");
 // ponytail: one local Resolve session; the OS releases this mutex on process death.
 const lock=createServer(socket=>socket.destroy());
 await new Promise<void>((resolve,reject)=>{lock.once("error",()=>reject(Error("Outra entrega ao Resolve está em andamento (porta local 47789 ocupada).")));lock.listen({host:"127.0.0.1",port:47789,exclusive:true},resolve);});
 let previousReady:DeliveryRecord|undefined;let activeOperationId:string|undefined;
 let record:DeliveryRecord|undefined;let saveChain=Promise.resolve();
 try{
  const previous=await readDelivery(dir,project.revision);
  if(previous?.status==="running")throw Error("entrega em andamento");
  if(previous?.status==="error"&&previous.created!==false&&!options.newCopy)throw Error("Entrega anterior incompleta. Solicite uma nova cópia; o projeto anterior será preservado.");
  if(options.exportDrp&&(!previous||previous.status!=="ready"))throw Error("Crie e verifique o projeto no Resolve antes de exportar DRP.");
  const dest=await exportApproved(project,dir);
  const root=join(dir,"deliveries",String(project.revision));await mkdir(root,{recursive:true});
  const same=previous?.status==="ready"&&!options.newCopy;
  if(same)previousReady=previous;
  const operationId=randomUUID();
  const mode=options.exportDrp?"export":same?"open":"create";
  record={operationId,revision:project.revision,assemblySha256:createHash("sha256").update(JSON.stringify(project.assembly)).digest("hex"),status:"running",stage:"connecting",created:false,projectName:same?previous.projectName:`${project.assembly.name.slice(0,70)}-${project.id.slice(0,8)}-r${project.revision}-${operationId.slice(0,8)}`,pid:process.pid,...(previousReady?{previousReady}:{}),...(same&&previous.drpPath?{drpPath:previous.drpPath}:{})};
  if(same&&previous.assemblySha256!==record.assemblySha256)throw Error("montagem difere da entrega registrada");
  activeOperationId=operationId;active.add(operationId);await atomic(recordPath(dir,project.revision),record);
  const requestPath=join(root,`request-${operationId}.json`);
  const drpPath=options.exportDrp?join(root,`project-${operationId}.drp`):undefined;
  await atomic(requestPath,{...record,mode,projectId:project.id,otioPath:join(dest,"timeline.otio"),assembly:project.assembly,handoff:buildHandoff(project),drpPath});
  const result=await exec.run({command:"python3",args:[fileURLToPath(new URL("../../../../../scripts/davinci-delivery.py",import.meta.url)),"--request",requestPath],signal,onLine:line=>{
   try{const event=JSON.parse(line);if(typeof event.stage==="string"&&record){if(event.stage==="created")record.created=true;if(event.stage!=="error")record.stage=event.stage;const snapshot={...record};saveChain=saveChain.then(()=>atomic(recordPath(dir,project.revision),snapshot));}}catch{/* non-JSON diagnostics are not protocol events */}
  }});
  await saveChain;
  const last=result.stdout.trim().split("\n").at(-1);const output=last?JSON.parse(last):null;
  if(result.code!==0||!output?.ok||output.projectName!==record.projectName||(mode==="create"&&output.verified!==true))throw Error(output?.error||"Ponte do Resolve não confirmou a entrega.");
  if(drpPath){if(output.drpPath!==drpPath||(await stat(drpPath)).size===0)throw Error("DRP não foi gravado");record.drpPath=drpPath;}
  delete record.previousReady;
  record={...record,status:"ready",stage:drpPath?"exported":"saved"};await atomic(recordPath(dir,project.revision),record);
  if((await loadProject(dir)).revision!==project.revision)throw Error("revisão mudou durante entrega; projeto entregue pertence à revisão anterior");
  return record;
 }catch(error){
  await saveChain.catch(()=>{});
  if(record&&record.status!=="ready"){record={...(previousReady??record),status:previousReady?"ready":"error",error:error instanceof Error?error.message:String(error)};await atomic(recordPath(dir,project.revision),record);}
  throw error;
 }finally{if(activeOperationId)active.delete(activeOperationId);await new Promise<void>(resolve=>lock.close(()=>resolve()));}
}
