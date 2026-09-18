"""Worker residente: um load por chave, respostas isoladas por tarefa."""
from __future__ import annotations

import importlib.util
import json
import queue
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


def load_worker(whisper: Mock):
    name = f"decupa_speech_worker_test_{id(whisper)}"
    spec = importlib.util.spec_from_file_location(
        name,
        Path(__file__).with_name("worker.py"),
    )
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {"whisperx": whisper, name: module}):
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

    def test_serve_benchmark_reads_unpublished_files_after_preload(self):
        whisper = Mock()
        asr = Mock()
        asr.transcribe.return_value = {"segments": []}
        whisper.load_model.return_value = asr
        whisper.load_align_model.return_value = ("align", "meta")
        whisper.align.return_value = {"segments": []}
        read_paths: list[str] = []

        def load_audio(path: str):
            data = Path(path).read_bytes()
            self.assertGreater(len(data), 0)
            read_paths.append(path)
            return [float(b) for b in data[:8]]

        whisper.load_audio.side_effect = load_audio
        worker_mod = load_worker(whisper)
        import tempfile
        tmp = Path(tempfile.mkdtemp(prefix="speech-bench-"))
        wav_a = tmp / "inedito-a.wav"
        wav_b = tmp / "inedito-b.wav"
        wav_a.write_bytes(b"RIFF-A" + b"\x01" * 32)
        wav_b.write_bytes(b"RIFF-B" + b"\x02" * 32)
        import io
        stdin = io.StringIO(
            json.dumps({"cmd": "preload", "args": {}}) + "\n"
            + json.dumps({"cmd": "benchmark", "args": {"wavs": [str(wav_a), str(wav_b)]}}) + "\n"
        )
        stdout = io.StringIO()
        with patch.object(worker_mod.sys, "stdin", stdin), patch.object(worker_mod.sys, "stdout", stdout):
            worker_mod.serve()
        lines = [json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()]
        report = next((line for line in lines if "modelLoads" in line), None)
        self.assertIsNotNone(report)
        self.assertEqual(report["files"], 2)
        self.assertEqual(report["modelLoads"], 0)
        self.assertEqual(report["wavs"], [str(wav_a), str(wav_b)])
        self.assertEqual(read_paths, [str(wav_a), str(wav_b)])
        self.assertEqual(whisper.load_model.call_count, 1)

    def test_serve_two_requests_share_one_load(self):
        whisper = Mock()
        asr = Mock()
        asr.transcribe.return_value = {"segments": []}
        whisper.load_model.return_value = asr
        whisper.load_align_model.return_value = ("align", "meta")
        whisper.load_audio.return_value = [0.0] * 16000
        whisper.align.return_value = {"segments": []}
        worker_mod = load_worker(whisper)
        import io
        stdin = io.StringIO(
            json.dumps({"cmd": "transcribe", "args": {"task_id": "a", "wav": "a.wav"}}) + "\n"
            + json.dumps({"cmd": "transcribe", "args": {"task_id": "b", "wav": "b.wav"}}) + "\n"
        )
        stdout = io.StringIO()
        with patch.object(worker_mod.sys, "stdin", stdin), patch.object(worker_mod.sys, "stdout", stdout):
            worker_mod.serve()
        lines = [json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()]
        self.assertEqual(len(lines), 2)
        self.assertEqual(whisper.load_model.call_count, 1)

    def test_serve_cancel_in_flight_does_not_return_other_task(self):
        whisper = Mock()
        asr = Mock()
        asr.transcribe.return_value = {"segments": [{"start": 0, "end": 1, "text": "x"}]}
        whisper.load_model.return_value = asr
        whisper.load_align_model.return_value = ("align", "meta")
        whisper.load_audio.return_value = [0.0] * 16000
        worker_mod = load_worker(whisper)
        started = threading.Event()
        release = threading.Event()

        def slow_align(*_args, **_kwargs):
            started.set()
            self.assertTrue(release.wait(2))
            return {"segments": [{"words": [{"word": "lento", "start": 0.0, "end": 0.2, "score": 1}]}]}

        def fast_align(*_args, **_kwargs):
            return {"segments": [{"words": [{"word": "rapido", "start": 0.0, "end": 0.2, "score": 1}]}]}

        whisper.align.side_effect = slow_align
        incoming: queue.Queue[str | None] = queue.Queue()
        outgoing: queue.Queue[str] = queue.Queue()

        class Stdin:
            def __iter__(self):
                while True:
                    item = incoming.get()
                    if item is None:
                        return
                    yield item

        class Stdout:
            def write(self, data: str) -> int:
                for line in data.splitlines():
                    if line.strip():
                        outgoing.put(line)
                return len(data)

            def flush(self) -> None:
                return None

        errors: list[BaseException] = []

        def run_serve() -> None:
            try:
                with patch.object(worker_mod.sys, "stdin", Stdin()), patch.object(
                    worker_mod.sys, "stdout", Stdout(),
                ):
                    worker_mod.serve()
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)

        thread = threading.Thread(target=run_serve, daemon=True)
        thread.start()
        try:
            incoming.put(json.dumps({"cmd": "transcribe", "args": {"task_id": "slow", "wav": "slow.wav"}}) + "\n")
            self.assertTrue(started.wait(1))
            incoming.put(json.dumps({"cmd": "cancel", "args": {"task_id": "slow"}}) + "\n")
            time.sleep(0.05)
            release.set()
            first = json.loads(outgoing.get(timeout=2))
            self.assertIn("cancel", str(first.get("error", "")).lower())
            self.assertEqual(first.get("taskId"), "slow")
            self.assertNotIn("lento", str(first))
            whisper.align.side_effect = fast_align
            incoming.put(json.dumps({"cmd": "transcribe", "args": {"task_id": "fast", "wav": "fast.wav"}}) + "\n")
            second = json.loads(outgoing.get(timeout=2))
            self.assertEqual(second.get("taskId"), "fast")
            self.assertEqual(second["words"][0]["text"], "rapido")
            self.assertNotIn("lento", str(second))
        finally:
            incoming.put(None)
            thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
