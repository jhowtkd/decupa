import type { AnimationNote, Project } from "./types.ts";
export type HandoffItem = AnimationNote & {sceneId:string; startFrame:number; durationFrames:number};
export function validateAnimationNotes(raw: unknown): AnimationNote[] {
  if (!Array.isArray(raw) || raw.length > 100) throw Error("notas de animação inválidas");
  const ids = new Set<string>();
  return raw.map(value => {
    if (!value || typeof value !== "object" || typeof value.id !== "string" || !value.id.trim() || value.id.length>200 || ids.has(value.id)
      || typeof value.description !== "string" || !value.description.trim() || value.description.length>5000
      || !["Resolve","After Effects"].includes(value.destination)) throw Error("nota de animação inválida");
    ids.add(value.id);
    const ref=value.reference;
    if (ref !== undefined && (!ref || typeof ref.templateId!=="string" || !ref.templateId || !Number.isSafeInteger(ref.revision) || ref.revision<1
      || !Number.isFinite(ref.start) || !Number.isFinite(ref.end) || ref.start<0 || ref.end<=ref.start)) throw Error("referência de animação inválida");
    return {id:value.id,description:value.description,destination:value.destination,...(ref ? {reference:{templateId:ref.templateId,revision:ref.revision,start:ref.start,end:ref.end}} : {})};
  });
}
export function buildHandoff(project: Project): HandoffItem[] {
  return project.scenes.flatMap(scene => {
    const notes=validateAnimationNotes(scene.animationNotes ?? []);
    if (!notes.length) return [];
    const clips=project.assembly.tracks.flatMap(t=>t.clips).filter(c=>c.sceneId===scene.id);
    if (!clips.length) throw Error(`cena ${scene.id} com animação sem clipes`);
    const startFrame=Math.min(...clips.map(c=>c.startFrame));
    const endFrame=Math.max(...clips.map(c=>c.startFrame+c.durationFrames));
    return notes.map(note=>({...note,sceneId:scene.id,startFrame,durationFrames:endFrame-startFrame}));
  });
}
