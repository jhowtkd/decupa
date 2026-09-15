# decupa · jornada do usuário por tela

Fluxogramas derivados do código (server.ts, editor/*.js, mark-web/server.ts).
Visualizável em `work/ui-screens/fluxograma.html` (ou colar os blocos Mermaid
abaixo em qualquer renderizador — GitHub renderiza direto).

## Jornada macro

```mermaid
flowchart LR
  bruto["Vídeo(s) brutos"] --> limpar["TELA LIMPAR<br/>transcrever · triar · revisar texto"]
  limpar -->|"EDL · MP4 · SRT · TXT"| corte["Corte de fala limpo"]
  bruto --> montar["TELA MONTAR<br/>edição texto-centrado por cenas"]
  montar -->|"timeline.otio · reference.mp4"| davinci["DaVinci / finalização"]
  mark["TELA MARCAR --web<br/>medição às cegas"] -.->|"truth.json"| ouro["Medida-ouro do alinhador"]
```

## 1 · Limpar fala — `decupa limpar --input vídeo.mp4`

```mermaid
flowchart TD
  start(["decupa limpar --input"]) --> open["Servidor sobe + navegador abre"]
  open --> ingest["Ingestão (etapas listadas na tela)<br/>preflight → proxy → transcrição → índice de unidades"]
  ingest --> plan["Planejamento local do motor<br/>(keep-list inicial = tudo)"]
  plan --> review["REVISÃO: prosa clicável<br/>N/N trechos · Ns de Ns"]
  review -->|"clica no trecho"| tirar["Tira o trecho (colapsa em chip)"]
  review -->|"clica no chip"| voltar["Traz de volta"]
  tirar --> debounce["debounce 250ms → replanifica"]
  voltar --> debounce
  debounce --> review
  review -->|"sugerir cortes"| previa["PRÉVIA DA TRIAGEM<br/>vai cair (motivo) · olhe isto · stats"]
  previa -->|"aplicar"| aplicado["Keep-list da triagem vira o corte"]
  previa -->|"descartar"| review
  aplicado --> review
  review -->|"ouvir trecho / ouvir junção"| ouvir["Toca ±0,7s dos dois lados na fonte"]
  review --> exp{"Exportar<br/>(sempre replanifica antes)"}
  exp -->|"exportar EDL"| f1["decupa.edl"]
  exp -->|"exportar MP4"| f2["corte final .mp4"]
  exp -->|"legendas"| f3[".srt"]
  exp -->|"transcrição"| f4[".txt"]
  review -->|"cancelar"| fim(["job encerrado"])
```

## 2 · Montagem — `decupa montar --project dir`

```mermaid
flowchart TD
  start(["decupa montar --project"]) --> editor["EDITOR aberto<br/>rail · texto (centro) · contexto · faixa"]
  editor --> materiais["RAIL · Materiais<br/>importar (arraste/picker) · categorizar Fala/Apoio<br/>incluir/excluir seleção · relink · ver original"]
  materiais --> briefing["RAIL · Briefing<br/>tipo (briefing/roteiro) + texto + duração alvo"]
  briefing --> guardar["Guardar briefing"]
  guardar --> prep["PREPARAÇÃO por fonte:<br/>mídia → áudio → visual"]
  prep --> ajuste{"Propor mudanças?<br/>(modelo pago · pedido escrito)"}
  ajuste -->|"sim"| cenas["Proposta de cenas:<br/>takes · evidência visual · lacunas"]
  ajuste -->|"não"| editar
  cenas --> editar["EDITAR PELO TEXTO<br/>tirar/restaurar · preservar/liberar<br/>corrigir grafia (overlay alinhado)<br/>incluir zona omitida · mover ↥↧ · excluir cena · desfazer"]
  editar --> faixa["FAIXA · sequência da montagem<br/>blocos por cena · playhead · seek · waveforms"]
  faixa --> previa["ATUALIZAR PRÉVIA<br/>(render no servidor, trava 2º clique)"]
  previa -->|"assistir até o fim"| aprovou{"Aprovar prévia assistida?"}
  previa -->|"pedir ajuste"| editar
  aprovou -->|"sim"| entrega["ENTREGA LIBERADA<br/>Baixar timeline.otio · reference.mp4"]
  aprovou -->|"não"| editar
```

Notas: a correção de grafia vai a `pending` e o servidor a alinha sozinho
(`aligned`) sem nova ASR; a entrega é duplamente travada — UI exige assistir a
prévia até o fim e o servidor recusa export sem aprovação (`exportApproved`).

## 3 · Marcar fronteiras — `decupa mark --web --input áudio --out truth.json`

```mermaid
flowchart TD
  start(["decupa mark --web"]) --> calc["Proxy + peaks calculados antes de abrir"]
  calc --> page["TELA: vídeo + forma de onda<br/>cursor · zoom · lista de marcas"]
  page -->|"espaço"| ouvir["Ouve em loop a partir do cursor"]
  page -->|"← → ±10ms · shift ±50ms · [ ] ±1s"| mover["Ajusta cursor às cegas"]
  mover -->|"enter"| marcar["Marca fronteira"]
  page -->|"⌫"| apagar["Apaga marca mais próxima"]
  marcar --> page
  apagar --> page
  page -->|"⌘S salvar"| salvar["POST /truth → grava truth.json<br/>terminal fecha sozinho"]
```

Nota: a tela nunca mostra transcrição nem predição — só vídeo e onda, para não
invalidar a medição do alinhador.
