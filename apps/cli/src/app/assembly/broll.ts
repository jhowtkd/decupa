import type { ChoiceQuestion } from "@decupa/typesafe";
import { decisionFailure, type AssemblyDecisionContext } from "./assembly-decisions.ts";
import { compileScenes, effectiveSpanText, speechCatalog, validateResolvedProposal, visualCatalog } from "./scenes.ts";
import type { Project, Proposal, Scene } from "./types.ts";

export type BrollCandidate={id:string;sourceId:string;visualIds:string[];start:number;end:number;description:string};

export function brollCandidates(project:Project):BrollCandidate[] {
  const fps=project.assembly.fps.num/project.assembly.fps.den;
  const result:BrollCandidate[]=[];
  const visual=[...visualCatalog(project).values()];
  for(const source of [...project.assembly.sources].sort((a,b)=>a.id.localeCompare(b.id))) {
    if(!source.included || !source.hasVideo || source.role==="speech") continue;
    const spans=visual.filter(s=>s.sourceId===source.id && s.confidence==="observed" && Number.isFinite(s.start) && Number.isFinite(s.end) && s.start>=0 && s.end<=source.durationSeconds && Math.round(s.end*fps)>Math.round(s.start*fps)).sort((a,b)=>a.start-b.start||a.id.localeCompare(b.id));
    spans.forEach((first,i)=>{
      let endFrame=Math.round(first.start*fps);
      const limit=Math.round((first.start+3)*fps), ids:string[]=[],texts:string[]=[];
      for(const span of spans.slice(i)) {
        // A cobertura precisa ser contígua nos frames que o render realmente usa.
        if(Math.round(span.start*fps)!==endFrame || endFrame>=limit) break;
        ids.push(span.id);texts.push(span.text);
        endFrame=Math.min(limit,Math.round(span.end*fps));
      }
      if(ids.length) result.push({id:`broll:${source.id}:${first.id}`,sourceId:source.id,visualIds:ids,start:first.start,end:endFrame/fps,description:[...new Set(texts)].join(" · ")});
    });
  }
  return result;
}

export function candidateSupport(project:Project,candidate:BrollCandidate,offsetFrames:number,durationFrames:number):Scene["support"] {
  const canonical=brollCandidates(project).find(c=>c.id===candidate.id);
  if(!canonical || JSON.stringify(canonical)!==JSON.stringify(candidate)) throw Error("candidato de apoio inválido");
  const fps=project.assembly.fps.num/project.assembly.fps.den;
  const first=Math.round(candidate.start*fps), last=first+durationFrames;
  if(!Number.isSafeInteger(offsetFrames)||offsetFrames<0||!Number.isSafeInteger(durationFrames)||durationFrames<=0||last>Math.round(candidate.end*fps)) throw Error("duração ou posição do apoio inválida");
  const catalog=visualCatalog(project),entries:Scene["support"]=[];
  let cursor=first;
  for(const id of candidate.visualIds) {
    const span=catalog.get(id)!;
    if(cursor>=last) break;
    if(Math.round(span.start*fps)!==cursor) throw Error("lacuna no apoio");
    const end=Math.min(last,Math.round(span.end*fps));
    entries.push({visualId:id,offsetFrames:offsetFrames+cursor-first,durationFrames:end-cursor});
    cursor=end;
  }
  if(cursor!==last) throw Error("cobertura insuficiente no apoio");
  return entries;
}

export async function selectBroll(project:Project,proposal:Proposal,context:AssemblyDecisionContext,signal:AbortSignal,onDecision?:()=>Promise<void>):Promise<Proposal> {
  signal.throwIfAborted();
  const next=structuredClone(proposal),fps=project.assembly.fps.num/project.assembly.fps.den;
  const report=next.decisionReport??{mode:context.mode,status:"not-run" as const,model:context.client?context.model:null,elapsedMs:0,cuts:[]};
  next.decisionReport=report;report.supports=[];
  // Apoio anterior pertence à revisão humana, mesmo se o gerador o omitiu.
  for(const scene of next.scenes) {
    const previous=project.scenes.find(s=>s.id===scene.id);
    if(previous?.support.length) scene.support=structuredClone(previous.support);
  }
  const compiled=compileScenes(project,next.scenes),catalog=visualCatalog(project),speech=speechCatalog(project);
  const candidates=brollCandidates(project);
  const used=next.scenes.flatMap(s=>s.support.map(e=>{const span=catalog.get(e.visualId)!;return {sourceId:span.sourceId,start:Math.round(span.start*fps),end:Math.round(span.start*fps)+e.durationFrames};}));
  for(const scene of next.scenes) {
    if(!next.changedSceneIds.includes(scene.id)||scene.support.length) continue;
    signal.throwIfAborted();
    const clips=compiled.tracks.find(t=>t.name==="A1")!.clips.filter(c=>c.sceneId===scene.id);
    const video=compiled.tracks.find(t=>t.name==="V1")!.clips.filter(c=>c.sceneId===scene.id);
    const duration=Math.max(0,...[...clips,...video].map(c=>c.startFrame+c.durationFrames))-Math.min(Infinity,...[...clips,...video].map(c=>c.startFrame));
    const own=new Set(scene.takes.map(t=>t.sourceId));
    let pool=candidates.filter(c=>!own.has(c.sourceId)&&!used.some(u=>u.sourceId===c.sourceId&&Math.round(c.start*fps)<u.end&&u.start<Math.round(c.end*fps)));
    if(context.mode==="off"||!context.client||duration<Math.round(2*fps)||!pool.length) {
      report.supports.push({sceneId:scene.id,candidateId:null,outcome:"none",reason:"Sem apoio automático: sem candidato elegível ou Jev inativo"});continue;
    }
    const started=performance.now();
    try {
      await onDecision?.();
      let round=0;
      do {
        const winners:BrollCandidate[]=[];
        for(let i=0;i<pool.length;i+=20) {
          signal.throwIfAborted();
          const batch=pool.slice(i,i+20),id=`support:${scene.id}:${round}:${i/20}`;
          const question:ChoiceQuestion={type:"choice",instructions:"Escolha a imagem que evidencia o assunto desta fala. Escolha none se não houver relação suficiente.",criteria:{none:"Manter vídeo principal",...Object.fromEntries(batch.map(c=>[c.id,`${c.sourceId} [${c.start}, ${c.end}]: ${c.description}`]))}};
          const response=await context.client.decide({model:context.model,state:{brief:project.input,request:project.preparation?.request??"",objective:scene.objective,speech:scene.takes.map(t=>{const span=speech.get(t.speechId??"");return span?effectiveSpanText(project,t.sourceId,span):"";})},questions:{[id]:question}},signal);
          signal.throwIfAborted();
          const answer=response.answers[id];
          if(answer?.type!=="choice"||!Object.hasOwn(question.criteria,answer.choice)||!Number.isFinite(answer.confidence)||answer.confidence<0||answer.confidence>1) throw Error("escolha inválida");
          if(answer.choice!=="none") winners.push(batch.find(c=>c.id===answer.choice)!);
        }
        pool=winners;round++;
      } while(pool.length>1);
      if(report.status!=="fallback") {report.status="completed";delete report.reason;}
      const selected=pool[0];
      if(!selected) {report.supports.push({sceneId:scene.id,candidateId:null,outcome:"none",reason:"Sem apoio automático: Jev escolheu manter o vídeo principal"});continue;}
      const offset=Math.round(fps),frames=Math.min(Math.round(selected.end*fps)-Math.round(selected.start*fps),Math.round(3*fps),duration-offset);
      if(context.mode==="hybrid") {
        scene.support=candidateSupport(project,selected,offset,frames);
        scene.visualEvidenceIds=[...new Set([...scene.visualEvidenceIds,...scene.support.map(e=>e.visualId)])];
        used.push({sourceId:selected.sourceId,start:Math.round(selected.start*fps),end:Math.round(selected.start*fps)+frames});
      }
      report.supports.push({sceneId:scene.id,candidateId:selected.id,outcome:"selected",reason:`${context.mode==="observe"?"Sugestão não aplicada: ":"Imagem selecionada: "}${selected.description}`});
    } catch(error) {
      signal.throwIfAborted();report.status="fallback";report.reason=decisionFailure(error);
      report.supports.push({sceneId:scene.id,candidateId:null,outcome:"fallback",reason:"Sem apoio automático: "+decisionFailure(error)});
    } finally {report.elapsedMs+=Math.max(0,performance.now()-started);}
  }
  return validateResolvedProposal(next,project);
}
