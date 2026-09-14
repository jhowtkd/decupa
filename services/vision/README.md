# services/vision

Sidecar de índice visual por unidade. Python 3.12 fixado via uv, porque
MediaPipe não tem wheel para o 3.14 do sistema.

    uv sync --python 3.12
    uv run python visual_index.py --prepare-models
    uv run python visual_index.py --video caminho.mp4 --index speech_index.json --fps 4

Escreve JSON em stdout. Logs em stderr. A saída agrupa por **ID de unidade**
(`u005`), nunca por timestamp de corte — o lado TypeScript resolve ID → tempo
pelo `speech_index.json`.

Os modelos Face Landmarker e Hand Landmarker (`.task`) são baixados e carregados pelo
setup da raiz via `--prepare-models`, reutilizando os arquivos em `services/vision/.models/`. Não commitar esses blobs.

Calibração é **relativa a este vídeo**: limiar = mediana dos scores do próprio
arquivo + margem. Pose neutra do falante (câmera alta/baixa) não vira
`looks_away`.

A dependência está pinada em `mediapipe>=0.10.21,<1`. A série 1.0 aborta no
macOS (`DrishtiMetalHelper` / `service_ Service is unavailable`) mesmo com
delegate CPU. O grafo roda em CPU.

Se o MediaPipe não estiver instalado, o script sai com código ≠ 0 e uma
mensagem em português apontando para este README.
