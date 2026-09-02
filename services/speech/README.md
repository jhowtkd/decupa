# services/speech

Sidecar de transcrição e alinhamento forçado. Python 3.11 fixado via uv, porque
`torch` e `ctranslate2` não têm wheels para o 3.14 do sistema.

    uv sync --python 3.11
    uv run python transcribe.py --wav caminho.wav --language pt

Escreve JSON em stdout. Tempo sempre em milissegundo inteiro — o lado
TypeScript nunca vê segundo fracionário.

O modelo de alinhamento de PT é baixado pelo WhisperX na primeira execução.
Se ele mudar de nome ou sumir, é aqui que se conserta, mantendo o formato de
saída intacto.
