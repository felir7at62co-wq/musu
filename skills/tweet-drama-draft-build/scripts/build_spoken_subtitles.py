"""Build speech cues; estimated timing and draft cues are not final-output QA."""
from __future__ import annotations

import math
import re
from typing import Any, Iterable


SPOKEN_TYPES = {"dialogue", "台词", "vo", "画外音"}
NARRATION_TYPES = {"os", "心声", "旁白", "解说", "画外声", "narration"}


def effective_character_count(text: str) -> int:
    return len(re.findall(r"[\u4e00-\u9fffA-Za-z0-9]", text or ""))


def build_spoken_cues(
    shots: Iterable[dict[str, Any]],
    *,
    video_state: dict[str, Any],
    draft: bool = False,
) -> list[dict[str, Any]]:
    """Require actual timing for final cues; only explicit drafts may estimate."""
    cleanup = video_state.get("subtitle_cleanup")
    if cleanup not in {"clean", "not_required"} and not (draft and cleanup == "pending"):
        raise ValueError("editing requires subtitle_cleanup=clean or not_required; pending requires draft=True")
    cues: list[dict[str, Any]] = []
    for shot in shots:
        speech_type = str(shot.get("speech_type") or shot.get("voice_type") or "").casefold()
        if speech_type not in SPOKEN_TYPES | NARRATION_TYPES:
            continue
        text = str(shot.get("text") or "").strip()
        if not text:
            continue
        actual_start = shot.get("actual_speech_start")
        actual_end = shot.get("actual_speech_end")
        if actual_start is not None or actual_end is not None or not draft:
            if actual_start is None or actual_end is None:
                raise ValueError(f"shot {shot.get('shot')}: actual speech timing required; review audio")
            start, end, source = float(actual_start), float(actual_end), "actual_audio"
        else:
            start = float(shot.get("start", 0))
            planned = max(1, math.ceil(effective_character_count(text) / 9))
            end = min(start + float(shot.get("duration", planned)), start + planned)
            source = "9_chars_per_second"
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
            raise ValueError(f"shot {shot.get('shot')}: invalid speech timing")
        cue = {
            "shot": shot.get("shot"),
            "speech_type": speech_type,
            "text": text,
            "start": start,
            "end": end,
            "timing_source": source,
        }
        if "speaker" in shot:
            cue["speaker"] = shot["speaker"]
        cues.append(cue)
    return cues
