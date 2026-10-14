"""Worker residente: um load por chave, respostas isoladas por tarefa."""
from __future__ import annotations

import importlib.util
import io
import json
import logging
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
    def test_estimated_word_keeps_text_and_time_with_null_confidence(self):
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
        worker = load_worker(whisper).SpeechWorker()
        result = worker.transcribe(task_id="estimated", wav="fake.wav")
        self.assertEqual([word["text"] for word in result["words"]], ["eu", "hã", "é", "legado"])
        self.assertEqual([word["confidence"] for word in result["words"]], [0.9, None, None, 0.0])
        self.assertEqual(result["words"][1], {"text": "hã", "startMs": 400, "endMs": 500,
                                                "confidence": None, "sentenceIndex": 0})
        self.assertEqual(result["unaligned"], ["sem tempo"])
        self.assertIsNone(json.loads(json.dumps(result))["words"][1]["confidence"])

    def test_whisperx_logger_does_not_write_to_stdout_after_import(self):
        whisper = Mock()
        logger = logging.getLogger("whisperx")
        logger.handlers.clear()
        logger.addHandler(logging.StreamHandler(sys.stdout))
        logger.propagate = True
        load_worker(whisper)
        for handler in logging.getLogger("whisperx").handlers:
            self.assertIsNot(getattr(handler, "stream", None), sys.stdout)
        self.assertFalse(logging.getLogger("whisperx").propagate)

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

    def test_concurrent_same_key_loads_once(self):
        whisper = Mock()
        asr = Mock()
        asr.transcribe.return_value = {"segments": []}
        whisper.load_align_model.return_value = ("align", "meta")
        whisper.load_audio.return_value = [0.0] * 16000
        whisper.align.return_value = {"segments": []}
        started = threading.Event()
        release = threading.Event()

        def slow_load(*_args, **_kwargs):
            started.set()
            self.assertTrue(release.wait(2))
            return asr

        whisper.load_model.side_effect = slow_load
        worker_mod = load_worker(whisper)
        worker = worker_mod.SpeechWorker()
        errors: list[BaseException] = []

        def run(task_id: str) -> None:
            try:
                worker.transcribe(task_id=task_id, wav=f"{task_id}.wav")
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)

        first = threading.Thread(target=run, args=("a",))
        second = threading.Thread(target=run, args=("b",))
        first.start()
        self.assertTrue(started.wait(1))
        second.start()
        time.sleep(0.05)
        release.set()
        first.join(2)
        second.join(2)
        self.assertEqual(errors, [])
        self.assertEqual(whisper.load_model.call_count, 1)

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

    def test_compute_type_change_creates_another_entry(self):
        whisper = Mock()
        asr = Mock()
        asr.transcribe.return_value = {"segments": []}
        whisper.load_model.return_value = asr
        whisper.load_align_model.return_value = ("align", "meta")
        whisper.load_audio.return_value = [0.0] * 16000
        whisper.align.return_value = {"segments": []}
        worker_mod = load_worker(whisper)
        worker = worker_mod.SpeechWorker()
        worker.transcribe(task_id="int8", wav="a.wav", compute_type="int8")
        worker.transcribe(task_id="fp16", wav="b.wav", compute_type="float16")
        self.assertEqual(whisper.load_model.call_count, 2)
        types = [call.kwargs["compute_type"] for call in whisper.load_model.call_args_list]
        self.assertEqual(types, ["int8", "float16"])

    def test_model_change_creates_another_entry(self):
        whisper = Mock()
        asr = Mock()
        asr.transcribe.return_value = {"segments": []}
        whisper.load_model.return_value = asr
        whisper.load_align_model.return_value = ("align", "meta")
        whisper.load_audio.return_value = [0.0] * 16000
        whisper.align.return_value = {"segments": []}
        worker_mod = load_worker(whisper)
        worker = worker_mod.SpeechWorker()
        worker.transcribe(task_id="small", wav="a.wav", model="small")
        worker.transcribe(task_id="medium", wav="b.wav", model="medium")
        self.assertEqual(whisper.load_model.call_count, 2)
        models = [call.args[0] for call in whisper.load_model.call_args_list]
        self.assertEqual(models, ["small", "medium"])

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

    def test_cancel_before_transcribe_starts_is_sticky(self):
        whisper = Mock()
        asr = Mock()
        asr.transcribe.return_value = {"segments": []}
        whisper.load_model.return_value = asr
        whisper.load_align_model.return_value = ("align", "meta")
        whisper.load_audio.return_value = [0.0] * 16000
        whisper.align.return_value = {
            "segments": [{"words": [{"word": "oi", "start": 0.1, "end": 0.4, "score": 0.9}]}],
        }
        worker_mod = load_worker(whisper)
        worker = worker_mod.SpeechWorker()
        # serve() marca a tarefa como em andamento ao ler o pedido; o cancel
        # que chega antes de a thread começar vale uma vez.
        worker.begin("soon")
        worker.cancel("soon")
        with self.assertRaises(worker_mod.CancelledError):
            worker.transcribe(task_id="soon", wav="a.wav")
        retry = worker.transcribe(task_id="soon", wav="a.wav")
        self.assertEqual(retry["words"][0]["text"], "oi")

    def _worker_que_devolve_oi(self):
        whisper = Mock()
        asr = Mock()
        asr.transcribe.return_value = {"segments": [{"start": 0, "end": 1, "text": "oi"}]}
        whisper.load_model.return_value = asr
        whisper.load_align_model.return_value = ("align", "meta")
        whisper.load_audio.return_value = [0.0] * 16000
        whisper.align.return_value = {
            "segments": [{"words": [{"word": "oi", "start": 0.1, "end": 0.4, "score": 0.9}]}],
        }
        worker_mod = load_worker(whisper)
        return worker_mod, whisper, asr, worker_mod.SpeechWorker()

    def test_cancel_after_finish_does_not_cancel_retry_with_same_id(self):
        # A chave é o conteúdo: a retomada repete o task_id. Um cancel atrasado
        # não pode ficar armado para a próxima.
        _worker_mod, _whisper, _asr, worker = self._worker_que_devolve_oi()
        primeira = worker.transcribe(task_id="same", wav="a.wav")
        self.assertEqual(primeira["words"][0]["text"], "oi")
        worker.cancel("same")
        segunda = worker.transcribe(task_id="same", wav="a.wav")
        self.assertEqual(segunda["words"][0]["text"], "oi")

    def test_transcribe_passes_progress_callback_and_writes_stderr(self):
        worker_mod, whisper, asr, worker = self._worker_que_devolve_oi()
        buf = io.StringIO()
        with patch.object(worker_mod.sys, "stderr", buf):
            worker.transcribe(task_id="a", wav="a.wav")
        self.assertIn("progress_callback", asr.transcribe.call_args.kwargs)
        self.assertIn("progress_callback", whisper.align.call_args.kwargs)
        self.assertIn("DECUPA_PROGRESS", buf.getvalue())
        self.assertIn("transcrevendo", buf.getvalue())

    def test_progress_hook_receives_stages(self):
        worker_mod, _whisper, _asr, _worker = self._worker_que_devolve_oi()
        etapas = []
        worker = worker_mod.SpeechWorker(progress=lambda task_id, stage, percent=None: etapas.append(stage))
        worker.transcribe(task_id="a", wav="a.wav")
        self.assertIn("transcrevendo", etapas)
        self.assertIn("alinhando as palavras", etapas)

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

    def test_benchmark_reuses_preloaded_language_not_defaults(self):
        whisper = Mock()
        asr = Mock()
        asr.transcribe.return_value = {"segments": []}
        whisper.load_model.return_value = asr
        whisper.load_align_model.return_value = ("align", "meta")
        whisper.load_audio.return_value = [0.0] * 16000
        whisper.align.return_value = {"segments": []}
        worker_mod = load_worker(whisper)
        worker = worker_mod.SpeechWorker()
        worker.preload(language="en")
        loads = whisper.load_model.call_count
        self.assertEqual(
            [call.kwargs["language"] for call in whisper.load_model.call_args_list],
            ["en"],
        )
        report = worker.benchmark(["inedito-en-a.wav", "inedito-en-b.wav"])
        self.assertEqual(whisper.load_model.call_count, loads)
        self.assertEqual(report["modelLoads"], 0)
        self.assertEqual(
            [call.kwargs.get("language_code") for call in whisper.load_align_model.call_args_list],
            ["en"],
        )

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

    def test_serve_keeps_going_after_malformed_stdin(self):
        whisper = Mock()
        asr = Mock()
        asr.transcribe.return_value = {"segments": []}
        whisper.load_model.return_value = asr
        whisper.load_align_model.return_value = ("align", "meta")
        whisper.load_audio.return_value = [0.0] * 16000
        whisper.align.return_value = {
            "segments": [{"words": [{"word": "ok", "start": 0.0, "end": 0.2, "score": 1}]}],
        }
        worker_mod = load_worker(whisper)
        import io
        stdin = io.StringIO(
            "not-json\n"
            + json.dumps({"cmd": "transcribe", "args": {"task_id": "a", "wav": "a.wav"}}) + "\n"
        )
        stdout = io.StringIO()
        with patch.object(worker_mod.sys, "stdin", stdin), patch.object(worker_mod.sys, "stdout", stdout):
            worker_mod.serve()
        lines = [json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()]
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0].get("taskId"), "a")
        self.assertEqual(lines[0]["words"][0]["text"], "ok")

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


class HeartbeatDuringModelLoadTest(unittest.TestCase):
    """O download do modelo não emite progresso; sem batimento o watchdog do
    cliente (10 min) mata o worker com a causa errada.

    Nada aqui depende de janela de tempo apertada: a carga espera (com teto
    largo) até ver o número de batimentos que o teste quer, e o teto do
    batimento é conferido com uma folga de mais de um segundo."""

    STAGE_ASR = "carregando o modelo de fala"
    STAGE_ALIGN = "carregando o modelo de alinhamento"
    HEARTBEAT = 0.02
    WAIT_LIMIT = 10.0

    def build(self, asr_hold=None, align_hold=None, heartbeat_max=None):
        """`*_hold`: ("beats", n) segura a carga até o estágio ter n linhas de
        progresso; ("sleep", s) segura por s segundos."""
        whisper = Mock()
        asr = Mock()
        asr.transcribe.return_value = {"segments": [{"start": 0.0, "end": 1.0, "text": "oi"}]}
        marks: dict[str, float] = {}
        records: list[tuple[str, float]] = []
        lock = threading.Lock()
        wanted: dict[str, int] = {}
        reached = {self.STAGE_ASR: threading.Event(), self.STAGE_ALIGN: threading.Event()}

        def progress(task_id, stage, percent=None):
            with lock:
                records.append((stage, time.monotonic()))
                total = sum(1 for name, _ in records if name == stage)
                if stage in reached and total >= wanted.get(stage, 1 << 30):
                    reached[stage].set()

        def hold_for(stage, hold):
            if hold is None:
                return
            kind, value = hold
            if kind == "sleep":
                time.sleep(value)
                return
            wanted[stage] = value
            with lock:
                if sum(1 for name, _ in records if name == stage) >= value:
                    reached[stage].set()
            if not reached[stage].wait(self.WAIT_LIMIT):
                raise AssertionError(f"o batimento de '{stage}' não repetiu durante a carga do modelo")

        def load_model(*args, **kwargs):
            marks["asr_start"] = time.monotonic()
            hold_for(self.STAGE_ASR, asr_hold)
            return asr

        def load_align_model(*args, **kwargs):
            marks["align_start"] = time.monotonic()
            hold_for(self.STAGE_ALIGN, align_hold)
            return ("align", "meta")

        whisper.load_model.side_effect = load_model
        whisper.load_align_model.side_effect = load_align_model
        whisper.load_audio.return_value = [0.0] * 16000
        whisper.align.return_value = {
            "segments": [{"words": [{"word": "oi", "start": 0.1, "end": 0.4, "score": 0.9}]}],
        }
        worker_mod = load_worker(whisper)
        worker = worker_mod.SpeechWorker(
            progress=progress,
            heartbeat_seconds=self.HEARTBEAT,
            heartbeat_max_seconds=heartbeat_max,
        )

        def stamps(stage: str) -> list[float]:
            with lock:
                return [at for name, at in records if name == stage]

        return worker, stamps, marks

    def heartbeat_threads(self):
        return [t for t in threading.enumerate() if t.name == "decupa-heartbeat" and t.is_alive()]

    def test_heartbeat_while_speech_model_loads(self):
        worker, stamps, _ = self.build(asr_hold=("beats", 3))
        worker.transcribe(task_id="a", wav="a.wav")
        # A chamada única de antes da carga não basta: tem de repetir.
        self.assertGreaterEqual(len(stamps(self.STAGE_ASR)), 3)

    def test_heartbeat_while_align_model_loads(self):
        worker, stamps, _ = self.build(align_hold=("beats", 3))
        worker.transcribe(task_id="a", wav="a.wav")
        self.assertGreaterEqual(len(stamps(self.STAGE_ALIGN)), 3)

    def test_heartbeat_stops_after_the_cap(self):
        # Carga travada: depois do teto o watchdog do cliente volta a valer.
        cap = 0.3
        worker, stamps, marks = self.build(asr_hold=("sleep", 3.0), heartbeat_max=cap)
        worker.transcribe(task_id="a", wav="a.wav")
        beats = stamps(self.STAGE_ASR)
        self.assertGreaterEqual(len(beats), 2, "sem batimento o teto não é exercitado")
        # Com o batimento sem teto, o último chegaria perto de 3 s; a folga de
        # mais de 1 s cobre CI carregado sem deixar esse caso passar.
        self.assertLessEqual(max(beats) - marks["asr_start"], cap + 1.2)

    def test_heartbeat_thread_dies_with_the_load(self):
        worker, stamps, _ = self.build(asr_hold=("beats", 3))
        worker.transcribe(task_id="a", wav="a.wav")
        beats_after_return = len(stamps(self.STAGE_ASR))
        self.assertGreaterEqual(beats_after_return, 3, "sem batimento o teste seria vazio")
        self.assertEqual(self.heartbeat_threads(), [])
        time.sleep(0.3)
        self.assertEqual(len(stamps(self.STAGE_ASR)), beats_after_return)


    def test_progress_line_starts_on_its_own_line_after_an_unfinished_stderr_line(self):
        # O stderr pode ter uma barra com \r sem quebra de linha; se a linha de
        # progresso colar nela, o cliente (que só reconhece linha que COMEÇA
        # com o prefixo) a perde: o watchdog não rearma e o JSON vaza.
        worker_mod = load_worker(Mock())
        buf = io.StringIO()
        buf.write("\r  10%|#####     |")
        with patch.object(worker_mod.sys, "stderr", buf):
            worker_mod.stderr_progress("a", "transcrevendo", 42)
        linhas = [l for l in buf.getvalue().split("\n") if l.startswith("DECUPA_PROGRESS ")]
        self.assertEqual(len(linhas), 1, repr(buf.getvalue()))
        payload = json.loads(linhas[0][len("DECUPA_PROGRESS "):])
        self.assertEqual(payload["taskId"], "a")
        self.assertEqual(payload["percent"], 42)


if __name__ == "__main__":
    unittest.main()
