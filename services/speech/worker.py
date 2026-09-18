"""Worker residente de fala: modelos carregados uma vez por chave.

O CLI `transcribe.py` continua sendo o processo único por arquivo. Este
módulo é o serviço que reutiliza Whisper/alinhamento entre arquivos.
GPU nunca é escolhida automaticamente: `auto`/`gpu` viram CPU; `cuda`
explícito tenta e cai para CPU se falhar.
"""

from __future__ import annotations

import threading
from pathlib import Path

import whisperx


class CancelledError(Exception):
    def __init__(self, task_id: str = ""):
        super().__init__(f"tarefa cancelada{f': {task_id}' if task_id else ''}")
        self.task_id = task_id


def resolve_device(requested: str | None) -> str:
    if requested in (None, "", "auto", "gpu"):
        return "cpu"
    return requested


class SpeechWorker:
    def __init__(self) -> None:
        self._asr: dict[tuple[str, str, str, str], object] = {}
        self._align: dict[tuple[str, str], tuple[object, object]] = {}
        self._cancel: dict[str, bool] = {}
        self._lock = threading.Lock()
        self.model_loads = 0

    def _check(self, task_id: str) -> None:
        if self._cancel.get(task_id):
            raise CancelledError(task_id)

    def cancel(self, task_id: str) -> None:
        self._cancel[task_id] = True

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
            asr = whisperx.load_model(model, tried, compute_type=compute_type, language=language)
        with self._lock:
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
        with self._lock:
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
        self._cancel[task_id] = False
        asr, device = self._asr_for(model, language, compute_type, device)
        self._check(task_id)
        audio = whisperx.load_audio(wav)
        self._check(task_id)
        if text_file:
            text = Path(text_file).read_text(encoding="utf-8").strip()
            if not text:
                raise ValueError("texto vazio para alinhamento")
            segments = [{"start": 0.0, "end": len(audio) / 16000, "text": text}]
        else:
            segments = asr.transcribe(audio, batch_size=batch_size)["segments"]
        self._check(task_id)
        align_model, align_meta = self._align_for(language, device)
        aligned = whisperx.align(
            segments,
            align_model,
            align_meta,
            audio,
            device,
            return_char_alignments=False,
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

    def benchmark(self, wavs: list[str]) -> dict:
        before = self.model_loads
        for index, wav in enumerate(wavs):
            self.transcribe(task_id=f"bench-{index}", wav=wav)
        return {
            "files": len(wavs),
            "modelLoads": self.model_loads - before,
            "wavs": list(wavs),
        }
