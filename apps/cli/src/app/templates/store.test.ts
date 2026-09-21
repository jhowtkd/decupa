import {expect,it} from "vitest";
import {mkdtemp} from "node:fs/promises";import {join} from "node:path";import {tmpdir} from "node:os";
import {approveRecipe,saveRecipe,loadRecipe,listRecipes,validateRecipe} from "./store.ts";
import type {Recipe} from "./types.ts";
export const recipe=():Recipe=>({id:"11111111-1111-4111-8111-111111111111",revision:1,name:"Evento",status:"draft",source:{path:"/tmp/base.mp4",sha256:"a".repeat(64),durationSeconds:2},analysis:{status:"pending",stage:"media"},rules:[]});
it("análise incompleta e aprovação stale são recusadas",()=>{
 expect(()=>approveRecipe(recipe(),1)).toThrow(/análise/);expect(()=>approveRecipe(recipe(),0)).toThrow(/revisão/);
});
it("aprovação permanece imutável enquanto rascunho evolui",async()=>{
 const root=await mkdtemp(join(tmpdir(),"recipes-"));const r=recipe();r.analysis.status="ready";
 await saveRecipe(root,r,null);await saveRecipe(root,approveRecipe(r,1),1);
 await saveRecipe(root,{...r,revision:2,name:"Novo"},1);
 expect((await loadRecipe(root,r.id,1)).status).toBe("approved");expect((await loadRecipe(root,r.id)).name).toBe("Novo");
 expect((await listRecipes(root)).map(r=>r.status)).toEqual(["draft","approved"]);
 await expect(saveRecipe(root,{...r,name:"Hack",status:"approved"},2)).rejects.toThrow();
});
it("edição concorrente e travessia de paths são rejeitadas",async()=>{
 const root=await mkdtemp(join(tmpdir(),"recipes-"));const r=recipe();await saveRecipe(root,r,null);
 const results=await Promise.allSettled([saveRecipe(root,{...r,revision:2,name:"A"},1),saveRecipe(root,{...r,revision:2,name:"B"},1)]);
 expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
 await expect(loadRecipe(root,"../secret")).rejects.toThrow();
 expect(()=>validateRecipe({...r,source:{...r.source,durationSeconds:Infinity}})).toThrow();
});
