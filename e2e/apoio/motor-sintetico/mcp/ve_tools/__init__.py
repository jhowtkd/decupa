"""Motor de render sintético dos testes de navegador (plano B, desligado).

Só entra com DECUPA_E2E_MOTOR=sintetico: o servidor de teste aponta
VE_PLUGIN_ROOT para cá e o scripts/render-assembly.py real importa este
pacote no lugar do motor. A prévia é um quadro liso do FFmpeg na duração
e no quadro da timeline, e o resto do caminho (render.ts, registro da
prévia com o assemblySha256 real, aprovação e exportação) é o de verdade.
"""
