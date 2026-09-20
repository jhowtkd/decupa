#!/usr/bin/env python3
"""Unittest do caminho de render com recursos limitados.

Importa o motor via VE_PLUGIN_ROOT (default: work/video-agent-kit-plugin
relativo à raiz do repo), sem infraestrutura nova.
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_ROOT = Path(os.environ.get("VE_PLUGIN_ROOT", REPO_ROOT / "work" / "video-agent-kit-plugin"))
sys.path.insert(0, str(PLUGIN_ROOT / "mcp"))

from ve_tools.render import video_output_args


class VideoOutputArgsTest(unittest.TestCase):
    def test_encoder(self):
        self.assertIn("h264_videotoolbox", video_output_args("h264_videotoolbox"))
        self.assertNotIn("-crf", video_output_args("h264_videotoolbox"))
        self.assertIn("-threads", video_output_args("libx264"))
        with self.assertRaises(ValueError):
            video_output_args("invalid")


if __name__ == "__main__":
    unittest.main()
