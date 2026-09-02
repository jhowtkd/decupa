"""Transcreve e alinha um WAV, emitindo tokens com tempo em ms inteiros.

Contrato de saída (stdout, JSON):
  {"language": "pt", "words": [
     {"text": "eu", "startMs": 120, "endMs": 260,
      "confidence": 0.91, "sentenceIndex": 0}, ...]}
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
    args = parser.parse_args()

    audio = whisperx.load_audio(args.wav)

    asr = whisperx.load_model(
        args.model,
        args.device,
        compute_type=args.compute_type,
        language=args.language,
    )
    transcription = asr.transcribe(audio, batch_size=args.batch_size)

    align_model, align_meta = whisperx.load_align_model(
        language_code=args.language, device=args.device
    )
    aligned = whisperx.align(
        transcription["segments"],
        align_model,
        align_meta,
        audio,
        args.device,
        return_char_alignments=False,
    )

    words = []
    for sentence_index, segment in enumerate(aligned["segments"]):
        for word in segment.get("words", []):
            # Palavras sem tempo acontecem quando o alinhador não acha o áudio
            # correspondente. Descartar é melhor que inventar um tempo.
            if "start" not in word or "end" not in word:
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

    json.dump({"language": args.language, "words": words}, sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
