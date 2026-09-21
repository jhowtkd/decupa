import { expect, it } from "vitest";
import { buildHandoff } from "./handoff.ts";
import { blankProject } from "./routes.ts";
import { fixtureAssembly } from "./fixture.ts";
import { validateProject } from "./store.ts";
import { approveFinal } from "./revisions.ts";
function project() {
  const p = blankProject("p"); p.assembly = fixtureAssembly();
  p.scenes = [{id:"s1",objective:"abrir",rationale:"",speechIds:[],takes:[],visualEvidenceIds:[],support:[],gaps:[],animationNotes:[{id:"n1",description:"Nome do entrevistado",destination:"Resolve"}]}];
  return p;
}
it("projeta pendência na posição atual e preserva no armazenamento", () => {
 const p = validateProject(project());
 expect(buildHandoff(p)).toEqual([{id:"n1",sceneId:"s1",startFrame:0,durationFrames:50,description:"Nome do entrevistado",destination:"Resolve"}]);
 for (const t of p.assembly.tracks) for (const c of t.clips) c.startFrame += 100;
 expect(buildHandoff(p)[0]!.startFrame).toBe(100);
 p.scenes=[]; expect(buildHandoff(p)).toEqual([]);
});
it("recusa nota sem clipes e dados malformados",()=>{
 const p=project(); p.assembly.tracks=[]; expect(()=>buildHandoff(p)).toThrow(/clipes/);
 const q=project(); q.scenes[0]!.animationNotes![0]!.description="";
 expect(()=>validateProject(q)).toThrow(/animação/);
});
it("handoff não relaxa lacunas editoriais",()=>{
 const p=project();p.previewRevision=0;p.previewArtifact={revision:0,assemblySha256:"a".repeat(64),sha256:"b".repeat(64),relativePath:"preview.mp4"};
 expect(approveFinal(p,0).finalApprovedRevision).toBe(0);
 p.scenes[0]!.gaps=["fala ausente"];expect(()=>approveFinal(p,0)).toThrow(/lacunas/);
});
