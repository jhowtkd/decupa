"""Testes puros do formato JSON e da calibração — sem chamar MediaPipe."""

from __future__ import annotations

import json
import unittest

from visual_index import aggregate_units, calibrate_threshold, median, ratio


class CalibrationTest(unittest.TestCase):
    def test_median_of_odd_list(self) -> None:
        self.assertEqual(median([0.1, 0.3, 0.2]), 0.2)

    def test_threshold_is_median_plus_margin(self) -> None:
        self.assertAlmostEqual(calibrate_threshold([0.1, 0.2, 0.3], 0.1), 0.3)

    def test_ratio_empty_is_zero(self) -> None:
        self.assertEqual(ratio([]), 0.0)


class AggregateTest(unittest.TestCase):
    def test_groups_samples_by_unit_id(self) -> None:
        units = [
            {"id": "u001", "start": 0.0, "end": 1.0},
            {"id": "u002", "start": 1.0, "end": 2.0},
        ]
        samples = [
            {"t": 0.0, "look_down": True, "look_side": False, "hand_on_face": False, "face": True},
            {"t": 0.5, "look_down": False, "look_side": False, "hand_on_face": False, "face": True},
            {"t": 1.25, "look_down": False, "look_side": True, "hand_on_face": False, "face": True},
        ]
        out = aggregate_units(units, samples)
        self.assertEqual([u["id"] for u in out], ["u001", "u002"])
        self.assertAlmostEqual(out[0]["look_down_ratio"], 0.5)
        self.assertAlmostEqual(out[1]["look_side_ratio"], 1.0)
        self.assertEqual(len(out[0]["samples"]), 2)

    def test_json_shape_matches_contract(self) -> None:
        payload = {
            "video": "proxy.mp4",
            "fps": 4,
            "units": aggregate_units(
                [{"id": "u005", "start": 25.0, "end": 28.0}],
                [{"t": 25.5, "look_down": False, "look_side": False,
                  "hand_on_face": False, "face": True}],
            ),
        }
        encoded = json.dumps(payload)
        parsed = json.loads(encoded)
        unit = parsed["units"][0]
        self.assertEqual(unit["id"], "u005")
        for key in (
            "look_down_ratio",
            "look_side_ratio",
            "hand_on_face_ratio",
            "face_missing_ratio",
            "samples",
        ):
            self.assertIn(key, unit)
        sample = unit["samples"][0]
        self.assertEqual(
            set(sample),
            {"t", "look_down", "look_side", "hand_on_face", "face"},
        )


class PrepareModelsTest(unittest.TestCase):
    def test_prepares_without_video_and_propagates_failure(self):
        import sys
        from unittest.mock import Mock, patch
        import visual_index
        face, hand = Mock(), Mock()
        with patch.object(sys, "argv", ["visual_index.py", "--prepare-models"]), patch.object(visual_index, "create_landmarkers", return_value=(face, hand)) as create:
            self.assertEqual(visual_index.main(), 0)
            face.close.assert_called_once()
            hand.close.assert_called_once()
            create.side_effect = RuntimeError("modelo inválido")
            with self.assertRaisesRegex(RuntimeError, "modelo inválido"):
                visual_index.main()


if __name__ == "__main__":
    unittest.main()
