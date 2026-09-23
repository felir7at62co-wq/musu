import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from build_spoken_subtitles import build_spoken_cues


class SpokenSubtitleTests(unittest.TestCase):
    def test_only_speech_becomes_cues(self):
        shots = [{"speech_type": kind, "text": "原文", "duration": 2}
                 for kind in ("action", "scene", "dialogue", "vo", "台词", "画外音")]
        cues = build_spoken_cues(shots, video_state={"subtitle_cleanup": "clean"}, draft=True)
        self.assertEqual([c["speech_type"] for c in cues], ["dialogue", "vo", "台词", "画外音"])

    def test_narration_preserves_text_speaker_and_actual_timing(self):
        for kind in ("os", "OS", "心声", "旁白", "解说", "画外声", "narration"):
            with self.subTest(kind=kind):
                cue = build_spoken_cues([{"speech_type": kind, "text": "原文不能改", "speaker": "林薇",
                    "actual_speech_start": 1.2, "actual_speech_end": 3.8}],
                    video_state={"subtitle_cleanup": "not_required"})[0]
                self.assertEqual((cue["text"], cue["speaker"], cue["start"], cue["end"]),
                                 ("原文不能改", "林薇", 1.2, 3.8))
                self.assertEqual(cue["timing_source"], "actual_audio")

    def test_unverified_narration_is_reported_not_silently_dropped(self):
        with self.assertRaisesRegex(ValueError, "actual speech timing"):
            build_spoken_cues([{"speech_type": "os", "text": "不能漏"}],
                             video_state={"subtitle_cleanup": "clean"})

    def test_all_final_speech_requires_actual_timing_including_compiled_vo(self):
        for kind in ("vo", "dialogue", "台词", "画外音", "os", "narration"):
            shot = {"voice_type": kind, "text": "原文不能漏", "speaker": "林薇", "duration": 2}
            with self.subTest(kind=kind):
                with self.assertRaisesRegex(ValueError, "actual speech timing"):
                    build_spoken_cues([shot], video_state={"subtitle_cleanup": "clean"})
                cue = build_spoken_cues([shot], video_state={"subtitle_cleanup": "clean"}, draft=True)[0]
                self.assertEqual(cue["timing_source"], "9_chars_per_second")
                self.assertEqual(cue["speaker"], "林薇")

    def test_pending_requires_explicit_draft_mode(self):
        with self.assertRaisesRegex(ValueError, "clean or not_required"):
            build_spoken_cues([], video_state={"subtitle_cleanup": "pending"})
        cues = build_spoken_cues([{"speech_type": "dialogue", "text": "你好"}],
                                video_state={"subtitle_cleanup": "pending"}, draft=True)
        self.assertEqual(cues[0]["text"], "你好")

    def test_unknown_and_failed_states_are_rejected_even_for_draft(self):
        for state in (None, "unknown", "failed"):
            with self.assertRaises(ValueError):
                build_spoken_cues([], video_state={"subtitle_cleanup": state}, draft=True)

    def test_invalid_audio_timing_is_rejected(self):
        for start, end in ((-1, 2), (3, 2), (1, 1), (float("nan"), 2), (1, float("inf")), (1, None)):
            with self.subTest(start=start, end=end), self.assertRaises(ValueError):
                build_spoken_cues([{"speech_type": "dialogue", "text": "你好",
                    "actual_speech_start": start, "actual_speech_end": end}],
                    video_state={"subtitle_cleanup": "clean"})

    def test_actual_timing_overrides_estimate(self):
        cue = build_spoken_cues([{"speech_type": "dialogue", "text": "甲" * 40,
            "start": 0, "actual_speech_start": 10.4, "actual_speech_end": 16.7}],
            video_state={"subtitle_cleanup": "clean"})[0]
        self.assertEqual((cue["start"], cue["end"]), (10.4, 16.7))


if __name__ == "__main__":
    unittest.main()
