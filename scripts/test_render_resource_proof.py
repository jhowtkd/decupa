"""Regressões do monitor: nenhum sinal real nos testes unitários."""
import importlib.util
from pathlib import Path
import signal
import os
import sys
import tempfile
import time
import subprocess
import unittest
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location('proof', Path(__file__).with_name('render-resource-proof.py'))
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


class MonitorTests(unittest.TestCase):
    def test_reused_pid_not_signalled(self):
        with patch.object(proof, '_signal_tree') as send:
            proof._signal_targets({10: ('old', proof.time.monotonic())}, {10: ('S', 'new')}, signal.SIGTERM)
            send.assert_called_once_with(set(), signal.SIGTERM)

    def test_refresh_discards_dead_and_reused_retains_reparented(self):
        known = {1: ('root', 0), 2: ('dead', 0), 3: ('old', 0), 4: ('child', 0)}
        states = {1: ('S', 'root'), 3: ('S', 'new'), 4: ('S', 'child'), 5: ('S', 'newchild')}
        current = proof._refresh_known(1, {1: [5], 99: [3, 4]}, states, known)
        self.assertEqual(set(current), {1, 4, 5})

    def test_reused_root_is_not_adopted(self):
        self.assertEqual(proof._refresh_known(1, {1: [2]}, {1: ('S', 'new'), 2: ('S', 'alien')}, {1: ('old', 0)}), {})

    def test_blind_targets_expire(self):
        with patch.object(proof.time, 'monotonic', return_value=100), patch.object(proof, '_signal_tree') as send:
            proof._signal_targets({1: ('old', 0), 2: ('recent', 99)}, {}, signal.SIGTERM)
            send.assert_called_once_with({2}, signal.SIGTERM)

    def test_no_blind_stop(self):
        with patch.object(proof, '_signal_tree') as send:
            proof._signal_targets({1: ('recent', proof.time.monotonic())}, {}, signal.SIGSTOP)
            send.assert_called_once_with(set(), signal.SIGSTOP)

    def test_interrupt_after_stop_resumes(self):
        with patch.object(proof, '_ps_table', return_value=({1: [2]}, {1: ('S', 'root'), 2: ('S', 'child')})), patch.object(proof, '_signal_tree') as send, patch.object(proof.time, 'sleep', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                proof.terminate_tree(1)
            self.assertEqual([c.args[1] for c in send.call_args_list], [signal.SIGSTOP, signal.SIGCONT])

    def test_measurement_error_is_not_zero(self):
        for result in [subprocess.CompletedProcess([], 1, '', 'permission denied'), subprocess.CompletedProcess([], 0, '', '')]:
            with patch.object(proof.subprocess, 'run', return_value=result):
                with self.assertRaises(proof.MeasurementError):
                    proof._sample_full(1)
        with patch.object(proof.subprocess, 'run', side_effect=FileNotFoundError):
            with self.assertRaises(proof.MeasurementError):
                proof._sample_full(1)

    def test_preflight_does_not_launch(self):
        with patch.object(proof.sys, 'argv', ['proof', '--', 'victim']), patch.object(proof, 'physical_memory', return_value=1024), patch.object(proof, 'swap_usage', return_value=''), patch.object(proof, '_sample_full', side_effect=proof.MeasurementError('denied')), patch.object(proof.subprocess, 'Popen') as launch, patch.object(proof, '_emit') as emit:
            proof.main()
            launch.assert_not_called()
            self.assertIsNone(emit.call_args.args[1]['exit_code'])
            self.assertIn('pre-flight', emit.call_args.args[1]['measurement_error'])

    def test_ps_failure_passes_last_snapshot(self):
        child = Mock(pid=1)
        child.poll.return_value = None
        child.returncode = -15
        known = {1: ('root', 1), 2: ('child', 1)}
        with patch.object(proof.sys, 'argv', ['proof', '--', 'victim']), patch.object(proof, 'physical_memory', return_value=1024**3), patch.object(proof, 'swap_usage', return_value=''), patch.object(proof, '_sample_full', side_effect=[(1, 0, {}), (10, 0, known), proof.MeasurementError('denied')]), patch.object(proof.subprocess, 'Popen', return_value=child), patch.object(proof, 'terminate_tree') as terminate, patch.object(proof, '_emit') as emit, patch.object(proof.time, 'sleep'):
            proof.main()
            terminate.assert_called_once_with(1, child, known)
            self.assertEqual(emit.call_args.args[1]['measurement_error'], 'denied')

    def test_parse_process_birth_and_rss(self):
        row = '1 0 10 2.5 S Mon Sep 21 06:00:00 2026\n'
        with patch.object(proof.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, row, '')):
            rss, cpu, known = proof._sample_full(1)
            self.assertEqual((rss, cpu), (10240, 2.5))
            self.assertEqual(known[1][0], 'Mon Sep 21 06:00:00 2026')

class ProcessIntegrationTests(unittest.TestCase):
    def test_separate_session_child_terminated_unrelated_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / 'child.pid'
            code = ("import subprocess,sys,time; from pathlib import Path; "
                    "p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'],start_new_session=True); "
                    "Path(sys.argv[1]).write_text(str(p.pid)); time.sleep(30)")
            unrelated = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
            parent = subprocess.Popen([sys.executable, '-c', code, str(marker)], start_new_session=True)
            child_pid = None
            try:
                deadline = time.monotonic() + 5
                while not marker.exists() and time.monotonic() < deadline:
                    time.sleep(.02)
                self.assertTrue(marker.exists())
                child_pid = int(marker.read_text())
                _, _, known = proof._sample_full(parent.pid)
                self.assertIn(child_pid, known)
                proof.terminate_tree(parent.pid, parent, known)
                parent.wait(timeout=3)
                _, states = proof._ps_table()
                self.assertFalse(proof._ps_alive(child_pid, states))
                self.assertIsNone(unrelated.poll())
            finally:
                for proc in (parent, unrelated):
                    if proc.poll() is None:
                        proc.kill()
                    proc.wait()
                if child_pid:
                    _, states = proof._ps_table()
                    if proof._ps_alive(child_pid, states):
                        os.kill(child_pid, signal.SIGKILL)

if __name__ == '__main__':
    unittest.main()
