"""Contrato do preparo; não importa modelos reais nem acessa a rede."""
import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


class PrepareModelsTest(unittest.TestCase):
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
