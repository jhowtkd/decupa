"""Instala e verifica os dados NLTK usados pelo alinhamento do WhisperX."""
from __future__ import annotations

import argparse
import sys


def validate_punkt() -> None:
    import nltk

    # Mesmo caminho usado pelo WhisperX: valida os arquivos e sua leitura,
    # não apenas a presença de um diretório ou o import da biblioteca.
    tokenizer = nltk.data.load("tokenizers/punkt_tab/portuguese.pickle")
    if tokenizer.tokenize("Olá, mundo. Esta é outra frase.") != [
        "Olá, mundo.", "Esta é outra frase."
    ]:
        raise RuntimeError("punkt_tab não separou as frases de validação em português")


def prepare_punkt(download_dir: str | None = None) -> None:
    import nltk

    if download_dir is not None and download_dir not in nltk.data.path:
        nltk.data.path.insert(0, download_dir)
    try:
        validate_punkt()
        return
    except LookupError:
        pass
    if not nltk.download(
        "punkt_tab", download_dir=download_dir, quiet=True, raise_on_error=True
    ):
        raise RuntimeError("falha ao baixar os dados NLTK punkt_tab")
    validate_punkt()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download-dir")
    parser.add_argument("--check", action="store_true", help="valida sem baixar dados")
    args = parser.parse_args()
    try:
        if args.check:
            validate_punkt()
        else:
            prepare_punkt(args.download_dir)
    except Exception as error:
        print(f"falha ao preparar tokenizador de fala: {error}", file=sys.stderr)
        return 1
    print("NLTK punkt_tab português OK", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
