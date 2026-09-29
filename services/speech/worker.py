"""Worker residente de fala: modelos carregados uma vez por chave.

O CLI `transcribe.py` continua sendo o processo único por arquivo. Este
módulo é o serviço que reutiliza Whisper/alinhamento entre arquivos.
GPU nunca é escolhida automaticamente: `auto`/`gpu` viram CPU; `cuda`
explícito tenta e cai para CPU se falhar.
"""

from __future__ import annotations

import contextlib
import json
import logging
import sys
import threading
import time
from pathlib import Path

import whisperx

# O contrato JSON-lines exige stdout puro. O WhisperX configura o logger
# "whisperx" com StreamHandler(sys.stdout); reapontamos para stderr.
_whisperx_logger = logging.getLogger("whisperx")
_whisperx_logger.handlers.clear()
_stderr_handler = logging.StreamHandler(sys.stderr)
_stderr_handler.setFormatter(
    logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s")
)
_whisperx_logger.addHandler(_stderr_handler)
_whisperx_logger.setLevel(logging.INFO)
_whisperx_logger.propagate = False


# Linha de progresso no stderr: o cliente Node rearma o watchdog a cada uma
# e mostra o texto na tela. stdout continua só com as respostas JSON.
PROGRESS_PREFIX = "DECUPA_PROGRESS "
_progress_lock = threading.Lock()


def stderr_progress(task_id: str, stage: str, percent: float | None = None) -> None:
    payload: dict = {"taskId": task_id, "stage": stage}
    if percent is not None:
        payload["percent"] = round(float(percent), 1)
    with _progress_lock:
        # O "\n" inicial fecha uma barra `\r` que outro escritor deixou sem
        # quebra: sem ele a linha de progresso cola nela, o cliente (que só
        # reconhece linha que COMEÇA com o prefixo) a perde e o watchdog não
        # rearma. O cliente descarta a linha vazia que sobra.
        sys.stderr.write("\n" + PROGRESS_PREFIX + json.dumps(payload) + "\n")
        sys.stderr.flush()


# Enquanto um modelo carrega (o de alinhamento PT baixa mais de 1 GB na primeira
# vez), nada sai do WhisperX. Uma thread repete a etapa corrente nesse ritmo para
# o watchdog do cliente (10 min sem linha de progresso) não matar o worker com a
# causa errada. Depois do teto ela para: uma carga realmente travada volta a ser
# pega pelo watchdog. Lidas na hora do uso; o construtor de SpeechWorker aceita
# outros valores (testes).
HEARTBEAT_SECONDS = 30.0
HEARTBEAT_MAX_SECONDS = 30 * 60.0
HEARTBEAT_THREAD_NAME = "decupa-heartbeat"


class CancelledError(Exception):
    def __init__(self, task_id: str = ""):
        super().__init__(f"tarefa cancelada{f': {task_id}' if task_id else ''}")
        self.task_id = task_id


def resolve_device(requested: str | None) -> str:
    if requested in (None, "", "auto", "gpu"):
        return "cpu"
    return requested


class SpeechWorker:
    def __init__(
        self,
        progress=stderr_progress,
        heartbeat_seconds: float | None = None,
        heartbeat_max_seconds: float | None = None,
    ) -> None:
        self._heartbeat_seconds = heartbeat_seconds
        self._heartbeat_max_seconds = heartbeat_max_seconds
        self._asr: dict[tuple[str, str, str, str], object] = {}
        self._align: dict[tuple[str, str], tuple[object, object]] = {}
        # Cancelamento só vale para tarefa em andamento: um cancel que chega
        # depois do fim não pode ficar guardado e matar a próxima com a mesma
        # chave (a chave é o conteúdo, então a retomada repete o id).
        self._active: set[str] = set()
        self._cancel: set[str] = set()
        self._state = threading.Lock()
        self._progress = progress
        self._lock = threading.Lock()
        self.model_loads = 0
        self._preload = {
            "model": "small",
            "language": "pt",
            "compute_type": "int8",
            "device": "cpu",
        }

    def _check(self, task_id: str) -> None:
        with self._state:
            cancelled = task_id in self._cancel
        if cancelled:
            raise CancelledError(task_id)

    def begin(self, task_id: str) -> None:
        """Marca a tarefa como em andamento antes da thread começar."""
        with self._state:
            self._active.add(task_id)

    def end(self, task_id: str) -> None:
        with self._state:
            self._active.discard(task_id)
            self._cancel.discard(task_id)

    def cancel(self, task_id: str) -> None:
        with self._state:
            if task_id in self._active:
                self._cancel.add(task_id)

    def _report(self, task_id: str, stage: str, percent: float | None = None) -> None:
        try:
            self._progress(task_id, stage, percent)
        except Exception:  # noqa: BLE001 - progresso nunca derruba a tarefa
            pass

    @contextlib.contextmanager
    def _heartbeat(self, task_id: str, stage: str):
        """Repete `stage` enquanto o bloco roda, até o teto de batimento."""
        every = self._heartbeat_seconds if self._heartbeat_seconds is not None else HEARTBEAT_SECONDS
        cap = (
            self._heartbeat_max_seconds
            if self._heartbeat_max_seconds is not None
            else HEARTBEAT_MAX_SECONDS
        )
        stop = threading.Event()
        started = time.monotonic()

        def beat() -> None:
            while not stop.wait(every):
                if time.monotonic() - started >= cap:
                    return
                self._report(task_id, stage)

        thread = threading.Thread(target=beat, name=HEARTBEAT_THREAD_NAME, daemon=True)
        thread.start()
        try:
            yield
        finally:
            stop.set()
            thread.join(timeout=5)

    def _percent_reporter(self, task_id: str, stage: str):
        last = [-1]

        def report(percent: float) -> None:
            whole = int(percent)
            if whole == last[0]:
                return
            last[0] = whole
            self._report(task_id, stage, percent)

        return report

    def _asr_for(self, model: str, language: str, compute_type: str, device: str):
        wanted = resolve_device(device)
        key = (model, language, compute_type, wanted)
        with self._lock:
            cached = self._asr.get(key)
            if cached is not None:
                return cached, wanted
            tried = wanted
            try:
                asr = whisperx.load_model(model, tried, compute_type=compute_type, language=language)
            except Exception:
                if tried == "cpu":
                    raise
                tried = "cpu"
                key = (model, language, compute_type, tried)
                cached = self._asr.get(key)
                if cached is not None:
                    return cached, tried
                asr = whisperx.load_model(model, tried, compute_type=compute_type, language=language)
            self.model_loads += 1
            self._asr.setdefault(key, asr)
            return self._asr[key], tried

    def _align_for(self, language: str, device: str):
        key = (language, device)
        with self._lock:
            cached = self._align.get(key)
            if cached is not None:
                return cached
            loaded = whisperx.load_align_model(language_code=language, device=device)
            self._align.setdefault(key, loaded)
            return self._align[key]

    def preload(
        self,
        model: str = "small",
        language: str = "pt",
        compute_type: str = "int8",
        device: str = "cpu",
    ) -> None:
        resolved = resolve_device(device)
        self._preload = {
            "model": model,
            "language": language,
            "compute_type": compute_type,
            "device": resolved,
        }
        self._asr_for(model, language, compute_type, resolved)
        self._align_for(language, resolved)

    def transcribe(
        self,
        task_id: str,
        wav: str,
        language: str = "pt",
        model: str = "small",
        compute_type: str = "int8",
        device: str = "cpu",
        batch_size: int = 8,
        text_file: str | None = None,
    ) -> dict:
        self.begin(task_id)
        try:
            self._check(task_id)
            self._report(task_id, "carregando o modelo de fala")
            with self._heartbeat(task_id, "carregando o modelo de fala"):
                asr, device = self._asr_for(model, language, compute_type, device)
            self._check(task_id)
            self._report(task_id, "lendo o áudio")
            audio = whisperx.load_audio(wav)
            self._check(task_id)
            if text_file:
                text = Path(text_file).read_text(encoding="utf-8").strip()
                if not text:
                    raise ValueError("texto vazio para alinhamento")
                segments = [{"start": 0.0, "end": len(audio) / 16000, "text": text}]
            else:
                self._report(task_id, "transcrevendo", 0)
                segments = asr.transcribe(
                    audio,
                    batch_size=batch_size,
                    progress_callback=self._percent_reporter(task_id, "transcrevendo"),
                )["segments"]
            self._check(task_id)
            self._report(task_id, "carregando o modelo de alinhamento")
            with self._heartbeat(task_id, "carregando o modelo de alinhamento"):
                align_model, align_meta = self._align_for(language, device)
            self._report(task_id, "alinhando as palavras", 0)
            aligned = whisperx.align(
                segments,
                align_model,
                align_meta,
                audio,
                device,
                return_char_alignments=False,
                progress_callback=self._percent_reporter(task_id, "alinhando as palavras"),
            )
            self._check(task_id)
            words = []
            unaligned: list[str] = []
            for sentence_index, segment in enumerate(aligned["segments"]):
                for word in segment.get("words", []):
                    if "start" not in word or "end" not in word:
                        missing = str(word.get("word", "")).strip()
                        if missing:
                            unaligned.append(missing)
                        continue
                    words.append(
                        {
                            "text": word["word"].strip(),
                            "startMs": int(round(word["start"] * 1000)),
                            "endMs": int(round(word["end"] * 1000)),
                            "confidence": float(word.get("score", 0.0)),
                            "sentenceIndex": sentence_index,
                        }
                    )
            return {"language": language, "words": words, "unaligned": unaligned, "taskId": task_id}
        finally:
            self.end(task_id)

    def benchmark(self, wavs: list[str]) -> dict:
        before = self.model_loads
        cfg = self._preload
        for index, wav in enumerate(wavs):
            self.transcribe(
                task_id=f"bench-{index}",
                wav=wav,
                language=str(cfg["language"]),
                model=str(cfg["model"]),
                compute_type=str(cfg["compute_type"]),
                device=str(cfg["device"]),
            )
        return {
            "files": len(wavs),
            "modelLoads": self.model_loads - before,
            "wavs": list(wavs),
        }


def serve() -> None:
    worker = SpeechWorker()
    jobs: list[threading.Thread] = []
    out_lock = threading.Lock()

    def reply(payload: dict) -> None:
        with out_lock:
            sys.stdout.write(json.dumps(payload) + "\n")
            sys.stdout.flush()

    def run_transcribe(args: dict) -> None:
        task_id = str(args.get("task_id") or "")
        try:
            reply(worker.transcribe(**args))
        except CancelledError as exc:
            reply({"error": str(exc), "taskId": exc.task_id or task_id})
        except Exception as exc:
            reply({"error": str(exc), "taskId": task_id})
        finally:
            # Argumento inválido estoura antes de transcribe começar; sem isto
            # a tarefa ficaria "em andamento" para sempre.
            worker.end(task_id)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        cmd = req.get("cmd") or "transcribe"
        args = req.get("args") or {}
        if cmd == "cancel":
            worker.cancel(str(args.get("task_id") or ""))
            continue
        if cmd == "preload":
            worker.preload(**{k: v for k, v in args.items() if k in {"model", "language", "compute_type", "device"}})
            continue
        if cmd == "benchmark":
            wavs = [str(item) for item in (args.get("wavs") or [])]
            try:
                reply(worker.benchmark(wavs))
            except Exception as exc:
                reply({"error": str(exc)})
            continue
        # Em andamento já na leitura da linha: um cancel que chega antes de a
        # thread começar ainda vale, e um que chega depois do fim é ignorado.
        worker.begin(str(args.get("task_id") or ""))
        thread = threading.Thread(target=run_transcribe, args=(args,), daemon=True)
        jobs.append(thread)
        thread.start()
    for job in jobs:
        job.join()


if __name__ == "__main__":
    if "--serve" in sys.argv:
        serve()
