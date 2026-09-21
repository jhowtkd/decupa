import { compileScenes, validateProposal } from "./scenes.ts";
import type { TypeSafeRequest, ChoiceQuestion } from "@decupa/typesafe";
import { expect, it } from "vitest";
import { fixtureAssembly } from "./fixture.ts";
import { blankProject } from "./routes.ts";
import { brollCandidates, candidateSupport, selectBroll } from "./broll.ts";
import { normalizeCompactSpans } from "./model.ts";

function fixture() {
  const p=blankProject("broll");p.assembly=fixtureAssembly();
  p.assembly.sources[0]!.durationSeconds=6;
  p.analyses=[{sourceId:"a",key:"a",status:"ready",words:[],wordsStatus:"missing",visual:[],visualCoverage:{requested:[],returned:[],missing:[]},speech:[{id:"a:one",sourceId:"a",start:0,end:6,text:"O público participou do evento"}]},
    {sourceId:"b",key:"b",status:"ready",speech:[],words:[],wordsStatus:"ready",visualCoverage:{requested:[],returned:[],missing:[]},visual:[0,1,2].map(start=>({id:`b:v${start}`,sourceId:"b",start,end:start+1,text:"público participando",confidence:"observed",tags:["público"]}))}];
  return p;
}
it("preserva três segundos em entradas reais consecutivas",()=>{
  const p=fixture(),c=brollCandidates(p)[0]!;
  expect(c.end-c.start).toBe(3);
  expect(candidateSupport(p,c,25,75)).toEqual([
    {visualId:"b:v0",offsetFrames:25,durationFrames:25},
    {visualId:"b:v1",offsetFrames:50,durationFrames:25},
    {visualId:"b:v2",offsetFrames:75,durationFrames:25},
  ]);
  expect(()=>candidateSupport(p,c,0,76)).toThrow();
});
it.each(["lacuna","unavailable","uncertain"])("não atravessa %s",kind=>{
  const p=fixture();
  if(kind==="lacuna") p.analyses[1]!.visual.splice(1,1);
  else p.analyses[1]!.visual[1]!.confidence=kind as "unavailable"|"uncertain";
  expect(brollCandidates(p)[0]!.end).toBe(1);
  p.assembly.sources[1]!.included=false;expect(brollCandidates(p)).toEqual([]);
});
it("usa fronteiras racionais e recusa candidato adulterado",()=>{
  const p=fixture();p.assembly.fps={num:30000,den:1001};
  p.analyses[1]!.visual=[0,0.5,1,1.5,2,2.5].map(start=>({id:`b:${start}`,sourceId:"b",start,end:start+0.5,text:"público",confidence:"observed",tags:[]}));
  const c=brollCandidates(p)[0]!;
  expect(candidateSupport(p,c,30,90).reduce((sum,e)=>sum+e.durationFrames,0)).toBe(90);
  expect(()=>candidateSupport(p,{...c,sourceId:"a"},0,30)).toThrow();
});
it("spans compactos normalizados geram candidatos ao longo da cena",()=>{
  const p=fixture();p.assembly.sources[1]!.durationSeconds=10;
  const compact=[{id:"x",sourceId:"b",start:0,end:10,text:"público participando",confidence:"observed" as const,tags:["público"]}];
  const cells=normalizeCompactSpans(compact);
  expect(cells).toHaveLength(10);
  p.analyses[1]!.visual=cells.map((span,i)=>({...span,id:`b:c${i}`}));
  expect(brollCandidates(p).map(c=>c.start)).toContain(6);
  p.analyses[1]!.visual=cells.map((span,i)=>({...span,id:`b:c${i}`,confidence:"uncertain" as const}));
  expect(brollCandidates(p)).toEqual([]);
  p.analyses[1]!.visual=cells.map((span,i)=>({...span,id:`b:c${i}`,confidence:"unavailable" as const}));
  expect(brollCandidates(p)).toEqual([]);
});

function proposalFor(p:ReturnType<typeof fixture>) {
  return validateProposal({id:"p",baseRevision:p.revision,changedSceneIds:["s"],explanation:"teste",scenes:[{id:"s",speechIds:["a:one"],support:[],gaps:[]}]},p);
}
function choose(req:TypeSafeRequest, choice?:string) {
  return {model:"test",answers:Object.fromEntries(Object.entries(req.questions).map(([id,q])=>{
    const keys=Object.keys((q as ChoiceQuestion).criteria);expect(keys.length).toBeLessThanOrEqual(21);
    const selected=choice??keys.find(k=>k!=="none")!;
    return [id,{type:"choice" as const,choice:selected,confidence:1,probabilities:Object.fromEntries(keys.map(k=>[k,k===selected?1:0]))}];
  }))};
}
it.each(["none","selected","invalid","error","observe"])("apoio %s preserva A1",async mode=>{
  const p=fixture(),proposal=proposalFor(p);let calls=0;
  const result=await selectBroll(p,proposal,{mode:mode==="observe"?"observe":"hybrid",model:"test",client:{decide:async req=>{calls++;if(mode==="error")throw Error("secret");return choose(req,mode==="none"?"none":mode==="invalid"?"inventado":undefined);}}},new AbortController().signal);
  expect(calls).toBe(1);
  expect(result.scenes[0]!.takes).toEqual(proposal.scenes[0]!.takes);
  expect(compileScenes(p,result.scenes).tracks[2]).toEqual(compileScenes(p,proposal.scenes).tracks[2]);
  expect(result.scenes[0]!.support.length).toBe(mode==="selected"?3:0);
  expect(result.decisionReport?.status).toBe(["invalid","error"].includes(mode)?"fallback":"completed");
  expect(JSON.stringify(result)).not.toContain("secret");
});
it("não consulta apoio existente, própria fonte ou modo off; cancelamento relança",async()=>{
  const p=fixture(),proposal=proposalFor(p);let calls=0;
  const context={mode:"hybrid" as const,model:"test",client:{decide:async(req:TypeSafeRequest)=>{calls++;return choose(req);}}};
  proposal.scenes[0]!.support=candidateSupport(p,brollCandidates(p)[0]!,25,75);
  expect((await selectBroll(p,proposal,context,new AbortController().signal)).scenes[0]!.support).toEqual(proposal.scenes[0]!.support);
  expect(calls).toBe(0);
  proposal.scenes[0]!.support=[];
  await selectBroll(p,proposal,{...context,mode:"off"},new AbortController().signal);expect(calls).toBe(0);
  p.assembly.sources[0]!.role="both";p.assembly.sources[1]!.included=false;
  p.analyses[0]!.visual=[{id:"a:v",sourceId:"a",start:0,end:3,text:"rosto",confidence:"observed",tags:[]}];
  await selectBroll(p,proposal,context,new AbortController().signal);expect(calls).toBe(0);
  const aborter=new AbortController();aborter.abort();await expect(selectBroll(p,proposal,context,aborter.signal)).rejects.toThrow();
});
it("limita rodadas e não reutiliza intervalo entre cenas",async()=>{
  const p=fixture();p.assembly.sources[1]!.durationSeconds=30;
  p.analyses[1]!.visual=Array.from({length:30},(_,start)=>({id:`b:v${start}`,sourceId:"b",start,end:start+1,text:"público",confidence:"observed",tags:[]}));
  const proposal=proposalFor(p);
  proposal.scenes.push({...structuredClone(proposal.scenes[0]!),id:"s2",takes:[{...proposal.scenes[0]!.takes[0]!,id:"s2:a:one"}]});proposal.changedSceneIds.push("s2");
  let calls=0;
  const result=await selectBroll(p,proposal,{mode:"hybrid",model:"test",client:{decide:async req=>{calls++;return choose(req);}}},new AbortController().signal);
  expect(calls).toBeGreaterThan(2);
  expect(result.scenes[0]!.support[0]!.visualId).toBe("b:v0");
  expect(result.scenes[1]!.support[0]!.visualId).toBe("b:v3");
});

it.each(["off","hybrid"] as const)("sem cliente em %s recusa apoio inventado pelo gerador",async mode=>{
  const {proposeScenes}=await import("./scenes.ts");const p=fixture();
  await expect(proposeScenes(p,"montar",new AbortController().signal,{
    decision:{mode,model:"test"},send:async()=>JSON.stringify({scenes:[{id:"s",speechIds:["a:one"],support:[{visualId:"b:v0",offsetFrames:25,durationFrames:25}]}],changedSceneIds:["s"]}),
  })).rejects.toThrow(/apoio novo/);
});
it.each([2,4])("ajuste com %s segundos não trunca apoio manual em 3–5s",async seconds=>{
  const {proposeScenes}=await import("./scenes.ts");const p=fixture();
  p.analyses[0]!.speech=[{id:"a:one",sourceId:"a",start:0,end:seconds,text:"tema"},{id:"a:two",sourceId:"a",start:seconds,end:6,text:"final"}];
  const previous=validateProposal({id:"p",baseRevision:p.revision,changedSceneIds:["s"],scenes:[{id:"s",speechIds:["a:one","a:two"],support:candidateSupport(p,brollCandidates(p)[0]!,75,50)}]},p);
  p.scenes=previous.scenes;const before=structuredClone(p);
  await expect(proposeScenes(p,"encurtar",new AbortController().signal,{send:async()=>JSON.stringify({scenes:[{id:"s",selections:[{takeId:p.scenes[0]!.takes[0]!.id}],support:[]}],changedSceneIds:["s"]})})).rejects.toThrow(/apoio existente/);
  expect(p).toEqual(before);
});
