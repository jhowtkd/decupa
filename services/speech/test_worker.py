"""Worker residente: um load por chave, respostas isoladas por tarefa."""
from __future__ import annotations

import importlib.util
import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


def load_worker(whisper: Mock):
    spec = importlib.util.spec_from_file_location(
        "decupa_speech_worker_test",
        Path(__file__).with_name("worker.py"),
    )
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {"whisperx": whisper}):
        spec.loader.exec_module(module)
    return module


class ResidentWorkerTest(unittest.TestCase):
    def test_two_files_share_one_load_per_key(self):
        whisper = Mock()
        asr = Mock()
        asr.transcribe.return_value = {"segments": [{"start": 0.0, "end": 1.0, "text": "oi"}]}
        whisper.load_model.return_value = asr
        whisper.load_align_model.return_value = ("align", "meta")
        whisper.load_audio.return_value = [0.0] * 16000
        whisper.align.return_value = {
            "segments": [{"words": [{"word": "oi", "start": 0.1, "end": 0.4, "score": 0.9}]}],
        }
        worker_mod = load_worker(whisper)
        worker = worker_mod.SpeechWorker()
        first = worker.transcribe(task_id="a", wav="um.wav")
        second = worker.transcribe(task_id="b", wav="dois.wav")
        self.assertEqual(whisper.load_model.call_count, 1)
        self.assertEqual(whisper.load_align_model.call_count, 1)
        self.assertEqual(first["words"][0]["text"], "oi")
        self.assertEqual(second["words"][0]["text"], "oi")
        whisper.load_model.assert_called_with("small", "cpu", compute_type="int8", language="pt")

    def test_language_change_creates_another_entry(self):
        whisper = Mock()
        asr = Mock()
        asr.transcribe.return_value = {"segments": []}
        whisper.load_model.return_value = asr
        whisper.load_align_model.return_value = ("align", "meta")
        whisper.load_audio.return_value = [0.0] * 16000
        whisper.align.return_value = {"segments": []}
        worker_mod = load_worker(whisper)
        worker = worker_mod.SpeechWorker()
        worker.transcribe(task_id="pt", wav="a.wav", language="pt")
        worker.transcribe(task_id="en", wav="b.wav", language="en")
        self.assertEqual(whisper.load_model.call_count, 2)
        langs = [call.kwargs["language"] for call in whisper.load_model.call_args_list]
        self.assertEqual(langs, ["pt", "en"])

    def test_never_returns_another_task_and_cancel_is_local(self):
        whisper = Mock()
        asr = Mock()
        whisper.load_model.return_value = asr
        whisper.load_align_model.return_value = ("align", "meta")
        whisper.load_audio.return_value = [0.0] * 16000
        worker_mod = load_worker(whisper)
        worker = worker_mod.SpeechWorker()
        started = threading.Event()
        release = threading.Event()

        def slow_align(*_args, **_kwargs):
            started.set()
            release.wait(1)
            return {"segments": [{"words": [{"word": "lento", "start": 0.0, "end": 0.2, "score": 1}]}]}

        def fast_align(*_args, **_kwargs):
            return {"segments": [{"words": [{"word": "rapido", "start": 0.0, "end": 0.2, "score": 1}]}]}

        asr.transcribe.return_value = {"segments": [{"start": 0, "end": 1, "text": "x"}]}
        whisper.align.side_effect = slow_align
        errors = []
        slow = {}

        def run_slow():
            try:
                slow["out"] = worker.transcribe(task_id="slow", wav="slow.wav")
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

        thread = threading.Thread(target=run_slow)
        thread.start()
        self.assertTrue(started.wait(1))
        worker.cancel("slow")
        release.set()
        thread.join(1)
        self.assertTrue(errors)
        self.assertIn("cancel", str(errors[0]).lower())
        whisper.align.side_effect = fast_align
        other = worker.transcribe(task_id="fast", wav="fast.wav")
        self.assertEqual(other["words"][0]["text"], "rapido")
        self.assertNotIn("lento", str(other))

    def test_cpu_fallback_without_automatic_gpu(self):
        whisper = Mock()
        asr = Mock()
        asr.transcribe.return_value = {"segments": []}
        whisper.load_model.return_value = asr
        whisper.load_align_model.return_value = ("align", "meta")
        whisper.load_audio.return_value = [0.0] * 8000
        whisper.align.return_value = {"segments": []}
        worker_mod = load_worker(whisper)
        worker = worker_mod.SpeechWorker()
        worker.transcribe(task_id="auto", wav="a.wav", device="auto")
        whisper.load_model.assert_called_with("small", "cpu", compute_type="int8", language="pt")
        whisper.load_model.reset_mock()
        whisper.load_model.side_effect = [RuntimeError("cuda missing"), asr]
        worker = worker_mod.SpeechWorker()
        worker.transcribe(task_id="gpu", wav="b.wav", device="cuda")
        devices = [call.args[1] for call in whisper.load_model.call_args_list]
        self.assertEqual(devices, ["cuda", "cpu"])

    def test_benchmark_loaded_models_not_cache_replay(self):
        whisper = Mock()
        asr = Mock()
        asr.transcribe.return_value = {"segments": []}
        whisper.load_model.return_value = asr
        whisper.load_align_model.return_value = ("align", "meta")
        whisper.load_audio.return_value = [0.0] * 16000
        whisper.align.return_value = {"segments": []}
        worker_mod = load_worker(whisper)
        worker = worker_mod.SpeechWorker()
        worker.preload()
        loads = whisper.load_model.call_count
        report = worker.benchmark(["novo-a.wav", "novo-b.wav"])
        self.assertEqual(whisper.load_model.call_count, loads)
        self.assertEqual(report["files"], 2)
        self.assertEqual(report["modelLoads"], 0)
        self.assertEqual(whisper.load_audio.call_count, 2)
        self.assertNotEqual(report["wavs"], ["cached"])


if __name__ == "__main__":
    unittest.main()
