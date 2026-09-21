export const RULE_CATEGORIES = ["narrative","speech","broll","rhythm","format","duration","animation"] as const;
export type Rule = {
 id:string;category:typeof RULE_CATEGORIES[number];observation:string;instruction:string;enabled:boolean;
 confidence:"observed"|"uncertain"|"unavailable";evidence:{start:number;end:number}[];
};
export type Recipe = {
 id:string;revision:number;name:string;status:"draft"|"approved";
 source:{path:string;sha256:string;durationSeconds:number};
 analysis:{status:"pending"|"running"|"ready"|"error"|"cancelled";stage:string;error?:string;pid?:number};
 rules:Rule[];
};
