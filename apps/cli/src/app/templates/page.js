const $=id=>document.getElementById(id);
let current=null,dirty=false,poll=null,busy=false;
const statuses={pending:"Aguardando análise",running:"Analisando",ready:"Pronta para revisão",error:"Análise interrompida",cancelled:"Cancelada"};
const stages={media:"Conferindo referência",audio:"Analisando áudio",visual:"Analisando imagens",synthesis:"Organizando receita",complete:"Análise concluída"};
const labels={narrative:"Estrutura narrativa",speech:"Falas e sequência",broll:"Imagens de apoio",rhythm:"Ritmo",format:"Formato",duration:"Durações",animation:"Animações"};
async function api(path,method="GET",data){const res=await fetch("/templates/api"+path,{method,headers:{"content-type":"application/json"},...(data?{body:JSON.stringify(data)}:{})});const value=await res.json();if(!res.ok)throw Error(value.error||"Falha na operação");return value;}
async function act(work){if(busy)return;busy=true;$("message").textContent="Processando…";try{if(await work()!==false)$("message").textContent="Atualizado.";}catch(error){$("message").textContent=error.message;}finally{busy=false;}}
// Só a referência escolhida chega à API de templates. Cancelar ou falhar no
// envio deixa o formulário e a receita salvos exatamente como estavam.
function selectReference(){return new Promise(resolve=>{
 const dialog=document.createElement("dialog");dialog.id="referencePicker";
 dialog.setAttribute("aria-labelledby","referencePickerTitle");dialog.style.maxWidth="min(560px, 90vw)";
 const title=document.createElement("h2");title.id="referencePickerTitle";title.textContent="Escolher vídeo de referência";
 const hint=document.createElement("p");hint.textContent="Use um vídeo do acervo, incluindo arquivos já importados do R2 ou Drive, ou envie um novo arquivo.";
 const label=document.createElement("label");label.textContent="Vídeo do acervo";
 const media=document.createElement("select");media.id="referenceMedia";media.style.width="100%";media.style.font="inherit";
 const empty=document.createElement("option");empty.value="";empty.textContent="Selecione um vídeo";media.append(empty);label.append(media);
 const use=document.createElement("button");use.id="useReference";use.type="button";use.textContent="Usar vídeo do acervo";use.disabled=true;
 const fileLabel=document.createElement("label");fileLabel.textContent="Enviar vídeo deste dispositivo";
 const file=document.createElement("input");file.id="referenceUpload";file.type="file";file.accept="video/*";fileLabel.append(file);
 const progress=document.createElement("p");progress.id="referenceProgress";progress.setAttribute("role","status");progress.setAttribute("aria-live","polite");progress.textContent="Carregando acervo…";
 const cancel=document.createElement("button");cancel.id="cancelReference";cancel.type="button";cancel.textContent="Cancelar seleção";
 dialog.append(title,hint,label,use,fileLabel,progress,cancel);document.body.append(dialog);
 let closed=false,upload=null,uploading=false;const controller=new AbortController();
 function finish(id){if(closed)return;closed=true;controller.abort();upload?.pause();dialog.close();dialog.remove();resolve(id);}
 cancel.onclick=()=>finish(null);dialog.oncancel=e=>{e.preventDefault();finish(null);};dialog.onclose=()=>finish(null);
 media.onchange=()=>{use.disabled=uploading||!media.value;};use.onclick=()=>{if(media.value&&!uploading)finish(media.value);};
 file.onchange=async()=>{
  const selected=file.files?.[0];if(!selected||uploading||closed)return;
  uploading=true;file.disabled=true;media.disabled=true;use.disabled=true;progress.textContent="Preparando envio…";
  try{
   const {ResumableMediaUpload}=await import("/templates/media-upload.js");if(closed)return;
   upload=new ResumableMediaUpload({onProgress:state=>{
    if(closed)return;
    progress.textContent=state.state==="importing"?"Importando vídeo para o acervo…":state.state==="verifying"?"Conferindo vídeo…":"Enviando vídeo: "+Math.round(state.percent)+"%";
   }});
   const result=await upload.start(selected);if(!closed)finish(result.mediaId);
  }catch(error){if(!closed)progress.textContent="Falha no envio: "+error.message+". Selecione o arquivo novamente para retomar.";}
  finally{uploading=false;if(!closed){file.disabled=false;file.value="";media.disabled=false;use.disabled=!media.value;}}
 };
 dialog.showModal();
 void (async()=>{try{
  const response=await fetch("/api/media",{signal:controller.signal});const items=await response.json();
  if(!response.ok)throw Error(items.error||"Acervo indisponível");if(closed)return;
  for(const item of items){const option=document.createElement("option");option.value=item.id;option.textContent=item.nome;media.append(option);}
  if(!uploading)progress.textContent=items.length?"Escolha um vídeo ou envie um arquivo novo.":"O acervo está vazio. Envie um vídeo para começar.";
 }catch(error){if(!closed&&!uploading)progress.textContent="Não foi possível carregar o acervo: "+error.message;}})();
});}
async function library(){const {recipes}=await api("");$("library").replaceChildren();for(const r of recipes){const b=document.createElement("button");b.textContent=r.name+" · r"+r.revision+" · "+(r.status==="approved"?"Aprovado":"Rascunho");b.setAttribute("aria-current",String(current?.id===r.id&&current?.revision===r.revision));b.onclick=()=>act(async()=>{if(dirty&&!confirm("Descartar alterações ainda não salvas?"))return;const data=await api("/"+r.id+(r.status==="approved"?"?revision="+r.revision:""));show(data.recipe);});$("library").append(b);}}
function show(r){clearTimeout(poll);current=r;dirty=false;$("detail").hidden=false;$("empty").hidden=true;$("title").textContent=r.name;$("name").value=r.name;$("status").textContent="Revisão "+r.revision+" · "+(r.status==="approved"?"Aprovada por você":statuses[r.analysis.status])+" · "+stages[r.analysis.stage]+(r.analysis.error?" — "+r.analysis.error:"");
 const src="/templates/api/"+r.id+"/media"+(r.status==="approved"?"?revision="+r.revision:"");if($("reference").getAttribute("src")!==src)$("reference").src=src;
 $("rules").replaceChildren();for(const rule of r.rules){const box=document.createElement("article");box.className="rule";box.dataset.id=rule.id;const h=document.createElement("h3");h.textContent=labels[rule.category]+" · "+({observed:"observado",uncertain:"incerto",unavailable:"indisponível"}[rule.confidence]);const p=document.createElement("p");p.textContent=rule.observation;const label=document.createElement("label");const check=document.createElement("input");check.type="checkbox";check.checked=rule.enabled;label.append(check," Usar esta orientação");const instruction=document.createElement("textarea");instruction.value=rule.instruction;instruction.setAttribute("aria-label","Orientação de "+labels[rule.category]);const times=document.createElement("div");times.className="evidence";for(const e of rule.evidence){const b=document.createElement("button");b.type="button";b.textContent=e.start.toFixed(1)+"–"+e.end.toFixed(1)+"s";b.onclick=()=>{$("reference").currentTime=e.start;$("reference").play().catch(()=>{});};times.append(b);}box.append(h,p,times,label,instruction);$("rules").append(box);}
 const running=r.analysis.status==="running";const step=["media","audio","visual","synthesis"].indexOf(r.analysis.stage);$("analysisProgress").hidden=!running;$("analysisStep").textContent=`Etapa ${step+1} de 4 — ${stages[r.analysis.stage]}`;$("analysisBar").value=Math.max(0,step);$("analysisDetail").textContent={media:"Conferindo o arquivo e a duração do vídeo.",audio:"Transcrevendo as falas da referência.",visual:"Examinando imagens do vídeo para identificar cenas e elementos visuais. Esta etapa pode levar alguns minutos.",synthesis:"Reunindo narrativa, ritmo e orientações para sua revisão."}[r.analysis.stage]||"Processando referência…";$("name").disabled=running;for(const input of $("rules").querySelectorAll("input,textarea"))input.disabled=running;$("cancel").hidden=!running;for(const id of ["save","analyze","relink"])$(id).disabled=running;$("approve").disabled=r.analysis.status!=="ready"||r.status==="approved";
 if(running)schedulePoll(r.id);
}
// Tick que cai durante outra ação (act ocupado) ou que falha não encerra o
// acompanhamento: reagenda enquanto a mesma receita segue em análise.
function schedulePoll(id){clearTimeout(poll);poll=setTimeout(async function tick(){if(current?.id!==id)return;if(busy){poll=setTimeout(tick,1000);return;}let shown=false;await act(async()=>{show((await api("/"+id)).recipe);shown=true;});if(!shown&&current?.id===id&&current.analysis.status==="running")poll=setTimeout(tick,1000);},1000);}
$("reference").onerror=()=>{$("message").textContent="Referência indisponível. Use Religar vídeo para localizar o original.";};
$("create").onsubmit=e=>{e.preventDefault();act(async()=>{if(dirty)throw Error("Salve suas alterações antes de criar outro template.");const name=$("newName").value;const mediaId=await selectReference();if(!mediaId){$("message").textContent="Seleção cancelada. Rascunho preservado.";return false;}const data=await api("","POST",{name,mediaId});if(data.recipe){show(data.recipe);await library();}});};
$("edit").oninput=()=>{dirty=true;$("approve").disabled=true;};
$("edit").onsubmit=e=>{e.preventDefault();act(async()=>{const rules=current.rules.map(r=>{const box=[...$("rules").children].find(b=>b.dataset.id===r.id);return {...r,enabled:box.querySelector("input").checked,instruction:box.querySelector("textarea").value};});show((await api("/"+current.id,"PATCH",{baseRevision:current.revision,name:$("name").value,rules})).recipe);await library();$("save").focus();});};
$("approve").onclick=()=>act(async()=>{if(dirty)throw Error("Salve suas alterações antes de aprovar.");show((await api("/"+current.id+"/approve","POST",{baseRevision:current.revision})).recipe);await library();});
$("analyze").onclick=()=>act(async()=>{if(!$("consent").checked)throw Error("Marque a autorização de análise externa para continuar.");if(dirty)throw Error("Salve suas alterações antes de analisar.");show((await api("/"+current.id+"/analyze","POST",{baseRevision:current.revision,modelOptIn:true,visualOptIn:true})).recipe);await library();});
$("cancel").onclick=()=>act(async()=>{await api("/"+current.id+"/cancel","POST",{baseRevision:current.revision});show((await api("/"+current.id)).recipe);});
$("relink").onclick=()=>act(async()=>{if(dirty)throw Error("Salve suas alterações antes de religar o vídeo.");const mediaId=await selectReference();if(!mediaId){$("message").textContent="Seleção cancelada. Rascunho preservado.";return false;}const data=await api("/"+current.id+"/relink","POST",{baseRevision:current.revision,mediaId});if(data.recipe){show(data.recipe);await library();}});
act(library);
