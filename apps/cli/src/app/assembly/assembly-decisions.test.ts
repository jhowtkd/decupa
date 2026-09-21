import { expect, it } from "vitest";
import { blankProject } from "./routes.ts";
import { fixtureAssembly } from "./fixture.ts";
import { validateProposal } from "./scenes.ts";
import { createAssemblyDecisionContext, decideAssemblyCuts, resolveCutCandidates, type AssemblyDecisionContext } from "./assembly-decisions.ts";

function fixture() {
  const p = blankProject("teste");
  p.assembly = fixtureAssembly();
  p.analyses = [{sourceId:"a",key:"k",status:"ready",words:[],wordsStatus:"missing",
    visual:[],visualCoverage:{requested:[],returned:[],missing:[]},speech:[
      {id:"a:one",sourceId:"a",start:0,end:1,text:"abertura repetida"},
      {id:"a:two",sourceId:"a",start:1,end:2,text:"informação principal"},
    ]}];
  const proposal = validateProposal({id:"p",baseRevision:p.revision,changedSceneIds:["s"],explanation:"teste",
    scenes:[{id:"s",selections:[{speechId:"a:one"},{speechId:"a:two"}],support:[],gaps:[]}]},p);
  const raw = [{sceneId:"s",speechId:"a:one",reason:"repetição"}];
  return {p, proposal, raw};
}

it.each([[0,2],[0.51,2],[0.52,1],[1,1],[NaN,2],[2,2]])("decide sem perder a última fala: score %s", async (score, count) => {
  const {p,proposal,raw} = fixture();
  raw.push({sceneId:"s",speechId:"a:two",reason:"encurtar"});
  const candidates = resolveCutCandidates(p,proposal,raw);
  let state = "";
  const context: AssemblyDecisionContext = {mode:"hybrid",model:"test",client:{decide:async req => {
    state = JSON.stringify(req.state);
    return {model:"test",answers:Object.fromEntries(Object.keys(req.questions).map(id=>[id,{type:"noul" as const,noul:score}]))};
  }}};
  const result = await decideAssemblyCuts(p,proposal,candidates,context,new AbortController().signal);
  expect(result.scenes[0]!.takes).toHaveLength(count);
  expect(proposal.scenes[0]!.takes).toHaveLength(2);
  expect(state).toContain("abertura repetida");
  expect(state).toContain("informação principal");
  expect(state).not.toContain("/tmp/");
  if (!Number.isFinite(score) || score > 1) expect(result.decisionReport?.status).toBe("fallback");
});

it("exclui intervenções manuais, último take e apoio; rejeita duplicata e ID desconhecido", () => {
  const {p,proposal,raw} = fixture();
  expect(resolveCutCandidates(p,proposal,raw)).toHaveLength(1);
  expect(()=>resolveCutCandidates(p,proposal,[...raw,...raw])).toThrow();
  expect(()=>resolveCutCandidates(p,proposal,[{...raw[0],speechId:"inventado"}])).toThrow();
  proposal.scenes[0]!.takes[0]!.protected=[{start:0,end:1}];
  expect(resolveCutCandidates(p,proposal,raw)).toEqual([]);
  proposal.scenes[0]!.takes[0]!.protected=[];
  proposal.scenes[0]!.takes[0]!.removed=[{start:0,end:0.2}];
  expect(resolveCutCandidates(p,proposal,raw)).toEqual([]);
  proposal.scenes[0]!.takes[0]!.removed=[];
  proposal.scenes[0]!.support=[{visualId:"v",offsetFrames:0,durationFrames:1}];
  expect(resolveCutCandidates(p,proposal,raw)).toEqual([]);
  proposal.scenes[0]!.support=[];
  proposal.scenes[0]!.takes.pop();
  expect(resolveCutCandidates(p,proposal,raw)).toEqual([]);
});

it.each(["off","observe"] as const)("%s não aplica cortes", async mode => {
  const {p,proposal,raw}=fixture(); let calls=0;
  const result=await decideAssemblyCuts(p,proposal,resolveCutCandidates(p,proposal,raw),{mode,model:"test",client:{decide:async req=>{
    calls++; return {model:"test",answers:Object.fromEntries(Object.keys(req.questions).map(id=>[id,{type:"noul" as const,noul:1}]))};
  }}},new AbortController().signal);
  expect(calls).toBe(mode==="off"?0:1);
  expect(result.scenes[0]!.takes).toHaveLength(2);
  expect(result.decisionReport?.cuts.every(c=>!c.applied)).toBe(true);
});

it("sem candidatos não chama; erro preserva fala e não vaza segredo; cancelamento relança", async () => {
  const {p,proposal,raw}=fixture(); let calls=0;
  const context:AssemblyDecisionContext={mode:"hybrid",model:"test",client:{decide:async()=>{calls++;throw Error("sk-secret");}}};
  await decideAssemblyCuts(p,proposal,[],context,new AbortController().signal);
  expect(calls).toBe(0);
  const result=await decideAssemblyCuts(p,proposal,resolveCutCandidates(p,proposal,raw),context,new AbortController().signal);
  expect(result.scenes).toEqual(proposal.scenes);
  expect(result.decisionReport?.status).toBe("fallback");
  expect(JSON.stringify(result)).not.toContain("sk-secret");
  const c=new AbortController();c.abort();
  await expect(decideAssemblyCuts(p,proposal,resolveCutCandidates(p,proposal,raw),context,c.signal)).rejects.toThrow();
});

it("reaplica proposta normalizada preservando edições e relatório", async () => {
  const {applyProposal}=await import("./revisions.ts");
  const {p,proposal}=fixture();
  p.scenes=structuredClone(proposal.scenes);
  p.scenes[0]!.takes[1]!.removed=[{start:1,end:1.1}];
  const edited=validateProposal({id:"new",baseRevision:p.revision,changedSceneIds:["s"],explanation:"ajuste",scenes:[{
    id:"s",selections:p.scenes[0]!.takes.map(t=>({takeId:t.id})),support:[],gaps:[],
  }]},p);
  const result=await decideAssemblyCuts(p,edited,[],{mode:"off",model:"test"},new AbortController().signal);
  const applied=applyProposal(p,result);
  expect(applied.scenes[0]!.takes[1]!.removed).toEqual([{start:1,end:1.1}]);
  expect(applied.proposal?.decisionReport?.status).toBe("not-run");
});

it.each([
  [null,"1","key","hybrid",true], [{mode:"off"},"1","key","off",false],
  [{mode:"observe"},"1","key","observe",true], [null,undefined,undefined,"off",false],
] as const)("resolve configuração %j sem ping", (raw,enabled,key,mode,hasClient)=>{
  let calls=0;
  const context=createAssemblyDecisionContext(raw,{DECUPA_TYPESAFE:enabled,TYPESAFE_API_KEY:key},async()=>{calls++;throw Error("não chamar");});
  expect(context.mode).toBe(mode);expect(Boolean(context.client)).toBe(hasClient);expect(calls).toBe(0);
});
