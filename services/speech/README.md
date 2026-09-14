# services/speech

Sidecar de transcrição e alinhamento forçado. Python 3.11 fixado via uv, porque
`torch` e `ctranslate2` não têm wheels para o 3.14 do sistema.

    uv sync --python 3.11
    uv run python transcribe.py --prepare-models
    uv run python transcribe.py --wav caminho.wav --language pt

Escreve JSON em stdout. Tempo sempre em milissegundo inteiro — o lado
TypeScript nunca vê segundo fracionário.

O setup da raiz executa `--prepare-models` para baixar e carregar Whisper small,
VAD e alinhamento PT-BR antes do primeiro vídeo, reutilizando o cache.
Outros idiomas/modelos ainda podem exigir downloads no processamento.
Se ele mudar de nome ou sumir, é aqui que se conserta, mantendo o formato de
saída intacto.
