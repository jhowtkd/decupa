import { parseDecisionConfig } from "@decupa/typesafe/config";
import { authorizesCut, TypeSafeHttpError, TypeSafeClient } from "@decupa/typesafe";
import { effectiveSpanText, speechCatalog, validateResolvedProposal } from "./scenes.ts";
import type { DecisionReport, Project, Proposal } from "./types.ts";

export type CutCandidate = {id:string;sceneId:string;takeId:string;text:string;before:string;after:string;reason:string};
export type DecisionClient = Pick<TypeSafeClient,"decide">;
export type AssemblyDecisionContext = {mode:"off"|"observe"|"hybrid";client?:DecisionClient;model:string};

export function resolveCutCandidates(project:Project, proposal:Proposal, raw:unknown):CutCandidate[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw Error("cutCandidates precisa ser um array");
  const speech=speechCatalog(project), seen=new Set<string>(), resolved=new Map<string,CutCandidate>();
  for (const item of raw) {
    if (!item || typeof item!=="object" || typeof item.reason!=="string" || !item.reason.trim()) throw Error("candidato de corte inválido");
    const scene=proposal.scenes.find(s=>s.id===item.sceneId);
    const matching=scene?.takes.filter(t=>t.speechId===item.speechId)??[];
    if (!scene || matching.length!==1 || !proposal.changedSceneIds.includes(scene.id)) throw Error("referência de corte inválida");
    const take=matching[0]!, id=`cut:${scene.id}:${take.id}`;
    if (seen.has(id)) throw Error("candidato de corte duplicado");
    seen.add(id);
    if (take.removed.length || take.protected.length || scene.support.length || project.scenes.find(s=>s.id===scene.id)?.support.length || scene.takes.length<2) continue;
    const span=speech.get(take.speechId!);
    if (!span) throw Error("fala do corte ausente");
    const neighbors=[...speech.values()].filter(s=>s.sourceId===span.sourceId).sort((a,b)=>a.start-b.start);
    const i=neighbors.findIndex(s=>s.id===span.id);
    const text=(n:number)=>neighbors[n]?effectiveSpanText(project,span.sourceId,neighbors[n]!):"";
    resolved.set(id,{id,sceneId:scene.id,takeId:take.id,text:text(i),before:text(i-1),after:text(i+1),reason:item.reason.trim()});
  }
  return proposal.scenes.flatMap(s=>s.takes.flatMap(t=>resolved.get(`cut:${s.id}:${t.id}`)??[]));
}

export function decisionFailure(error:unknown):string {
  if (error instanceof TypeSafeHttpError) {
    if ([401,422].includes(error.status)) return "configuração do Jev";
    if ([429,529].includes(error.status)) return "Jev indisponível";
  }
  return "falha na decisão Jev";
}

export async function decideAssemblyCuts(project:Project, proposal:Proposal, candidates:CutCandidate[], context:AssemblyDecisionContext, signal:AbortSignal):Promise<Proposal> {
  signal.throwIfAborted();
  const next=structuredClone(proposal);
  const report:DecisionReport={mode:context.mode,status:"not-run",model:context.client?context.model:null,elapsedMs:0,cuts:[]};
  next.decisionReport=report;
  if (context.mode==="off" || !candidates.length || !context.client) {
    report.reason=context.mode==="off"?"Jev desativado":!candidates.length?"Sem candidatos elegíveis":"Jev sem cliente configurado";
    return next;
  }
  const started=performance.now();
  for (let offset=0;offset<candidates.length;offset+=20) {
    const batch=candidates.slice(offset,offset+20);
    try {
      signal.throwIfAborted();
      const result=await context.client.decide({model:context.model,state:{brief:project.input,request:project.preparation?.request??"",candidates:batch},questions:Object.fromEntries(batch.map(c=>[c.id,{
        type:"noul" as const,instructions:`Candidato ${c.id}: a remoção integral atende ao briefing sem perder informação necessária? Na dúvida mantenha.`,
        criteria:{true:"Corte justificado pelo contexto",false:"Preservar informação, ressalva ou contexto"},
      }]))},signal);
      signal.throwIfAborted();
      const scores=batch.map(c=>{
        const answer=result.answers[c.id];
        if (answer?.type!=="noul" || !Number.isFinite(answer.noul) || answer.noul<0 || answer.noul>1) throw Error("resposta inválida");
        return answer.noul;
      });
      batch.forEach((candidate,i)=>{
        const scene=next.scenes.find(s=>s.id===candidate.sceneId)!;
        const applied=context.mode==="hybrid" && authorizesCut(scores[i]!) && scene.takes.length>1;
        if (applied) {
          scene.takes=scene.takes.filter(t=>t.id!==candidate.takeId);
          scene.speechIds=scene.takes.flatMap(t=>t.speechId?[t.speechId]:[]);
        }
        report.cuts.push({id:candidate.id,sceneId:candidate.sceneId,takeId:candidate.takeId,applied,score:scores[i]!});
      });
      if (report.status!=="fallback") report.status="completed";
    } catch(error) {
      signal.throwIfAborted();
      report.status="fallback"; report.reason=decisionFailure(error);
      report.cuts.push(...batch.map(c=>({id:c.id,sceneId:c.sceneId,takeId:c.takeId,applied:false,score:null})));
    }
  }
  report.elapsedMs=Math.max(0,performance.now()-started);
  return validateResolvedProposal(next, project);
}

export function validateDecisionReport(raw:unknown):DecisionReport {
  const fail=():never=>{throw Error("relatório de decisão inválido");};
  const obj=(v:unknown):Record<string,unknown>=>v && typeof v==="object" && !Array.isArray(v)?v as Record<string,unknown>:fail();
  const text=(v:unknown):string=>typeof v==="string"?v:fail();
  const r=obj(raw);
  if (!["off","observe","hybrid"].includes(String(r.mode)) || !["not-run","completed","fallback"].includes(String(r.status)) || typeof r.elapsedMs!=="number" || !Number.isFinite(r.elapsedMs) || r.elapsedMs<0 || !Array.isArray(r.cuts)) fail();
  const report:DecisionReport={mode:r.mode as DecisionReport["mode"],status:r.status as DecisionReport["status"],model:r.model===null?null:text(r.model),elapsedMs:r.elapsedMs as number,cuts:(r.cuts as unknown[]).map(v=>{
    const c=obj(v);
    if(typeof c.applied!=="boolean" || (c.score!==null && (typeof c.score!=="number" || !Number.isFinite(c.score) || c.score<0 || c.score>1))) fail();
    return {id:text(c.id),sceneId:text(c.sceneId),takeId:text(c.takeId),applied:c.applied as boolean,score:c.score as number|null};
  })};
  if(r.reason!==undefined) report.reason=text(r.reason);
  if(r.supports!==undefined) {
    if(!Array.isArray(r.supports)) fail();
    report.supports=(r.supports as unknown[]).map(v=>{
      const s=obj(v); if(!["selected","none","fallback"].includes(String(s.outcome))) fail();
      return {sceneId:text(s.sceneId),candidateId:s.candidateId===null?null:text(s.candidateId),outcome:s.outcome as "selected"|"none"|"fallback",reason:text(s.reason)};
    });
  }
  return report;
}

export function createAssemblyDecisionContext(raw:unknown, env:Record<string,string|undefined>, fetchImpl?:typeof fetch):AssemblyDecisionContext {
  const defaultMode=env.DECUPA_TYPESAFE==="1" && env.TYPESAFE_API_KEY?"hybrid":"off";
  const config=parseDecisionConfig(raw??{mode:defaultMode},env);
  const client=config.mode!=="off" && env.DECUPA_TYPESAFE==="1" && env.TYPESAFE_API_KEY
    ? new TypeSafeClient({apiKey:env.TYPESAFE_API_KEY,model:config.model,fetchImpl}):undefined;
  return {mode:config.mode,model:config.model,client};
}
