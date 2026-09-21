#!/usr/bin/env python3
"""Unittest do caminho de render com recursos limitados.

Importa o motor via VE_PLUGIN_ROOT (default: work/video-agent-kit-plugin
relativo à raiz do repo), sem infraestrutura nova.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_ROOT = Path(os.environ.get("VE_PLUGIN_ROOT", REPO_ROOT / "work" / "video-agent-kit-plugin"))
sys.path.insert(0, str(PLUGIN_ROOT / "mcp"))

from ve_tools.render import (
    build_project_ffmpeg_command,
    render_intervals,
    slice_render_plan,
    video_output_args,
)


class VideoOutputArgsTest(unittest.TestCase):
    def test_encoder(self):
        self.assertIn("h264_videotoolbox", video_output_args("h264_videotoolbox"))
        self.assertNotIn("-crf", video_output_args("h264_videotoolbox"))
        self.assertIn("-threads", video_output_args("libx264"))
        with self.assertRaises(ValueError):
            video_output_args("invalid")


def _clip(source="/orig/fala.mp4", start=0.0, ts=0.0, dur=6.0, speed=1.0, muted=True):
    return {
        "source": source,
        "start": start,
        "end": start + dur * speed,
        "source_duration": dur * speed,
        "render_duration": dur,
        "timeline_start": ts,
        "timeline_end": ts + dur,
        "speed": speed,
        "muted": muted,
        "volume": 0.0 if muted else 1.0,
        "opacity": 1.0,
    }


def _plan(fps=25, duration=12.0, video=(), audio=(), overlay=(), text=()):
    return {
        "fps": fps,
        "duration": duration,
        "width": 320,
        "height": 240,
        "video_clips": list(video),
        "audio_clips": list(audio),
        "overlay_clips": list(overlay),
        "text_clips": list(text),
    }


def _assert_coverage(test, intervals, total):
    test.assertTrue(intervals)
    test.assertEqual(intervals[0][0], 0)
    test.assertEqual(intervals[-1][1], total)
    for (_, prev_end), (start, _) in zip(intervals, intervals[1:]):
        test.assertEqual(prev_end, start)


class RenderIntervalsTest(unittest.TestCase):
    def test_intervals(self):
        plan = {"fps": 25, "duration": 12, "video_clips": [], "overlay_clips": []}
        self.assertEqual(render_intervals(plan), [(0, 125), (125, 250), (250, 300)])

    def test_intervals_v2_crossing(self):
        plan = _plan(video=[_clip(ts=0.0, dur=12.0), _clip("/orig/apoio.mp4", ts=4.0, dur=2.0)])
        intervals = render_intervals(plan)
        bounds = {b for iv in intervals for b in iv}
        self.assertIn(100, bounds)
        self.assertIn(150, bounds)
        for start, end in intervals:
            self.assertLessEqual(end - start, 125)
        _assert_coverage(self, intervals, 300)

    def test_intervals_sequential_v1(self):
        plan = _plan(video=[_clip(ts=0.0, dur=6.0), _clip(ts=6.0, dur=6.0)])
        self.assertEqual(
            render_intervals(plan), [(0, 125), (125, 150), (150, 275), (275, 300)])

    def test_intervals_fractional_fps(self):
        fps = 30000 / 1001
        frame = 1001 / 30000
        plan = _plan(fps=fps, video=[
            _clip(ts=0.0, dur=12.0),
            _clip("/orig/apoio.mp4", ts=100 * frame, dur=50 * frame),
        ])
        intervals = render_intervals(plan)
        bounds = {b for iv in intervals for b in iv}
        self.assertIn(100, bounds)
        self.assertIn(150, bounds)
        for start, end in intervals:
            self.assertLessEqual(end - start, 149)
        _assert_coverage(self, intervals, 360)

    def test_slice_bounds_inputs_and_source(self):
        import copy
        plan = _plan(video=[
            _clip(ts=0.0, dur=12.0),
            _clip("/orig/apoio.mp4", ts=4.0, dur=2.0),
        ])
        frozen = copy.deepcopy(plan)
        for start, end in render_intervals(plan):
            sliced = slice_render_plan(plan, start, end)
            self.assertLessEqual(len(sliced["video_clips"]), 2)
            self.assertEqual(sliced["audio_clips"], [])
            with tempfile.TemporaryDirectory(prefix="seg-") as tmp:
                cmd, _ = build_project_ffmpeg_command(
                    sliced, Path(tmp) / "seg.mp4", Path(tmp),
                    encoder="libx264", hwaccel="", include_audio=False)
            inputs = [cmd[i + 1] for i, v in enumerate(cmd) if v == "-i"]
            self.assertLessEqual(len(inputs), 2)
            for path in inputs:
                self.assertTrue(path.startswith("/orig/"), path)
                self.assertNotIn("proxy.mp4", path)
            self.assertIn("-an", cmd)
            self.assertIn("-threads", cmd)
            self.assertIn("-filter_complex_threads", cmd)
        self.assertEqual(plan, frozen)

    def test_slice_rejects_triple_overlap(self):
        plan = _plan(video=[
            _clip(ts=0.0, dur=12.0),
            _clip("/orig/b.mp4", ts=0.0, dur=12.0),
            _clip("/orig/c.mp4", ts=0.0, dur=12.0),
        ])
        with self.assertRaises(RuntimeError):
            slice_render_plan(plan, 0, 125)

    def test_slice_source_offset_respects_speed(self):
        plan = _plan(video=[_clip(start=10.0, ts=4.0, dur=2.0, speed=2.0)])
        sliced = slice_render_plan(plan, 125, 150)
        (clip,) = sliced["video_clips"]
        self.assertAlmostEqual(clip["start"], 12.0)
        self.assertAlmostEqual(clip["render_duration"], 1.0)
        self.assertAlmostEqual(clip["source_duration"], 2.0)
        self.assertAlmostEqual(clip["timeline_start"], 0.0)
        self.assertAlmostEqual(clip["timeline_end"], 1.0)

    def test_gap_interval_renders_black_base(self):
        plan = _plan(video=[_clip(ts=0.0, dur=2.0), _clip(ts=10.0, dur=2.0)])
        intervals = render_intervals(plan)
        _assert_coverage(self, intervals, 300)
        sliced = slice_render_plan(plan, 125, 250)
        self.assertEqual(sliced["video_clips"], [])
        with tempfile.TemporaryDirectory(prefix="gap-") as tmp:
            cmd, _ = build_project_ffmpeg_command(
                sliced, Path(tmp) / "gap.mp4", Path(tmp),
                encoder="libx264", hwaccel="", include_audio=False)
        self.assertTrue(any("color=c=black" in v for v in cmd))
        self.assertIn("-an", cmd)


if __name__ == "__main__":
    unittest.main()
