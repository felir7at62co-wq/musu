"""Serial batch queue for background episode rendering."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path


def episode_ids(spec: str) -> list[str]:
    result: list[int] = []
    for item in spec.split(","):
        item = item.strip()
        match = re.fullmatch(r"(\d+)\s*-\s*(\d+)", item)
        if match:
            start, end = map(int, match.groups())
            result.extend(range(start, end + 1))
        elif item.isdigit():
            result.append(int(item))
        else:
            raise ValueError(f"Invalid episode range: {item}")
    return [f"{value:02d}" for value in dict.fromkeys(result)]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True, type=Path)
    parser.add_argument("--episodes", required=True)
    parser.add_argument("--bgm-dir", required=True, type=Path, help="Per-episode multi-track mixes: NN.mp3")
    parser.add_argument("--ending-audio", required=True, type=Path)
    parser.add_argument("--ending-effect", required=True, type=Path)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    project = args.project.resolve()
    script = Path(__file__).with_name("render_episode.py")
    ending_effect = args.ending_effect.resolve()
    ending_audio = args.ending_audio.resolve()
    for resource in (ending_effect, ending_audio):
        if not resource.is_file():
            raise FileNotFoundError(resource)
    state_path = project / "exports" / "batch_render_tasks.json"
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {"tasks": {}}

    for episode in episode_ids(args.episodes):
        try:
            videos = sorted((project / "video" / episode).glob("shot_*.mp4"))
            if not videos:
                raise FileNotFoundError(f"No videos for episode {episode}")
            last_shot = max(int(re.search(r"(\d+)", path.stem).group(1)) for path in videos)
            timeline = project / "subtitles" / f"{episode}.timeline.json"
            subtitle = project / "subtitles" / f"{episode}.display.srt"
            bgm = args.bgm_dir.resolve() / f"{episode}.mp3"
            if not bgm.is_file():
                raise FileNotFoundError(f"Missing reviewed multi-track BGM mix: {bgm}")
            cmd = [sys.executable, "-B", str(script), "--project", str(project), "--episode", episode,
                   "--timeline", str(timeline), "--subtitle-srt", str(subtitle),
                   "--last-shot", str(last_shot), "--bgm", str(bgm),
                   "--ending-audio", str(ending_audio),
                   "--ending-effect", str(ending_effect)]
            if args.force:
                cmd.append("--force")
            proc = subprocess.run(cmd, text=True, encoding="utf-8", errors="replace", capture_output=True)
            if proc.returncode:
                raise RuntimeError(proc.stderr[-3000:] or proc.stdout[-3000:])
            state["tasks"][episode] = {"status": "succeeded", "output": str(project / "exports" / f"{episode}.mp4")}
        except Exception as exc:
            state["tasks"][episode] = {"status": "failed", "error": str(exc)}
        state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(state, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
