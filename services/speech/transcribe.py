"""Transcreve e alinha um WAV, emitindo tokens com tempo em ms inteiros.

Contrato de saída (stdout, JSON):
  {"language": "pt", "words": [
     {"text": "eu", "startMs": 120, "endMs": 260,
      "confidence": 0.91, "sentenceIndex": 0}, ...],
   "unaligned": ["palavra sem tempo", ...]}

Com --text-file, pula a ASR e alinha o texto dado no áudio recortado.
Palavras sem tempo nunca ganham tempo inventado: vão para `unaligned`.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys

import whisperx

# O contrato de saída exige JSON puro no stdout. O WhisperX configura o logger
# "whisperx" com um StreamHandler(sys.stdout) (whisperx.log_utils), o que vaza
# linhas de log para o stdout e quebraria o parse no lado TypeScript.
# Reapontamos esse logger para o stderr antes de qualquer chamada.
_whisperx_logger = logging.getLogger("whisperx")
_whisperx_logger.handlers.clear()
_stderr_handler = logging.StreamHandler(sys.stderr)
_stderr_handler.setFormatter(
    logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s")
)
_whisperx_logger.addHandler(_stderr_handler)
_whisperx_logger.setLevel(logging.INFO)
_whisperx_logger.propagate = False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wav", required=True)
    parser.add_argument("--language", default="pt")
    parser.add_argument("--model", default="small")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--text-file", default=None)
    args = parser.parse_args()

    audio = whisperx.load_audio(args.wav)

    if args.text_file:
        from pathlib import Path

        text = Path(args.text_file).read_text(encoding="utf-8").strip()
        if not text:
            raise ValueError("texto vazio para alinhamento")
        segments = [{"start": 0.0, "end": len(audio) / 16000, "text": text}]
    else:
        asr = whisperx.load_model(
            args.model,
            args.device,
            compute_type=args.compute_type,
            language=args.language,
        )
        segments = asr.transcribe(audio, batch_size=args.batch_size)["segments"]

    align_model, align_meta = whisperx.load_align_model(
        language_code=args.language, device=args.device
    )
    aligned = whisperx.align(
        segments,
        align_model,
        align_meta,
        audio,
        args.device,
        return_char_alignments=False,
    )

    words = []
    unaligned = []
    for sentence_index, segment in enumerate(aligned["segments"]):
        for word in segment.get("words", []):
            # Palavras sem tempo acontecem quando o alinhador não acha o áudio
            # correspondente. Registrar é melhor que descartar em silêncio ou
            # inventar um tempo.
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

    json.dump(
        {"language": args.language, "words": words, "unaligned": unaligned},
        sys.stdout,
        ensure_ascii=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
