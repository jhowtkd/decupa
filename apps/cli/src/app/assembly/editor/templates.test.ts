import {expect,it} from "vitest";
import {templateProposalView} from "./templates.js";
it("proposta antiga não pode ser aceita e pendências aparecem",()=>{
 const candidate={id:"x",baseRevision:2,scenes:[{objective:"Abertura",animationNotes:[{description:"Nome",destination:"Resolve"}]}],templateReport:[{status:"adapted",reason:"sem drone"}]};
 expect(templateProposalView(candidate,3)).toMatchObject({canAccept:false,stale:true});
 const view=templateProposalView(candidate,2);expect(view.canAccept).toBe(true);expect(view.lines.join(" ")).toContain("Nome");expect(view.lines.join(" ")).toContain("sem drone");
});
