"""Contrato do preparo; não importa modelos reais nem acessa a rede."""
import importlib.util
import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


class PrepareModelsTest(unittest.TestCase):
    def test_transcribe_emits_null_for_interpolated_words_without_dropping_text(self):
        whisper = Mock()
        asr = Mock()
        asr.transcribe.return_value = {"segments": []}
        whisper.load_model.return_value = asr
        whisper.load_align_model.return_value = ("align", "meta")
        whisper.load_audio.return_value = [0.0] * 16000
        whisper.align.return_value = {"segments": [{"words": [
            {"word": " eu ", "start": 0.1, "end": 0.3, "score": 0.9},
            {"word": "hã", "start": 0.4, "end": 0.5},
            {"word": "é", "start": 0.6, "end": 0.7, "score": None},
            {"word": "legado", "start": 0.8, "end": 0.9, "score": 0.0},
            {"word": "sem tempo"},
        ]}]}
        spec = importlib.util.spec_from_file_location("decupa_transcribe_estimated", Path(__file__).with_name("transcribe.py"))
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"whisperx": whisper}):
            spec.loader.exec_module(module)
        output = io.StringIO()
        with patch.object(sys, "argv", ["transcribe.py", "--wav", "fake.wav"]), patch.object(sys, "stdout", output):
            self.assertEqual(module.main(), 0)
        result = json.loads(output.getvalue())
        self.assertEqual([word["text"] for word in result["words"]], ["eu", "hã", "é", "legado"])
        self.assertEqual([word["confidence"] for word in result["words"]], [0.9, None, None, 0.0])
        self.assertEqual(result["words"][1], {"text": "hã", "startMs": 400, "endMs": 500,
                                                "confidence": None, "sentenceIndex": 0})
        self.assertEqual(result["unaligned"], ["sem tempo"])

    def test_loads_defaults_without_media_and_propagates_failure(self):
        whisper = Mock()
        spec = importlib.util.spec_from_file_location("decupa_transcribe_test", Path(__file__).with_name("transcribe.py"))
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"whisperx": whisper}):
            spec.loader.exec_module(module)
        with patch.object(sys, "argv", ["transcribe.py", "--prepare-models"]):
            self.assertEqual(module.main(), 0)
            whisper.load_model.assert_called_once_with("small", "cpu", compute_type="int8", language="pt")
            whisper.load_align_model.assert_called_once_with(language_code="pt", device="cpu")
            whisper.load_audio.assert_not_called()
            whisper.load_align_model.side_effect = RuntimeError("download interrompido")
            with self.assertRaisesRegex(RuntimeError, "download interrompido"):
                module.main()


if __name__ == "__main__":
    unittest.main()
