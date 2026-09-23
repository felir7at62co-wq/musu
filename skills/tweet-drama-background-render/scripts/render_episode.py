"""Render one validated episode to MP4 without launching Jianying."""

from __future__ import annotations

import argparse
import os
import json
import re
import shutil
import subprocess
import tempfile
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tweet-drama-core' / 'scripts'))
from video_bans import check_videos

# FFmpeg/ffprobe resolve from the deployment's own variables first: this machine keeps them off PATH.
FFMPEG = os.environ.get('DSH_FFMPEG_PATH') or os.environ.get('FFMPEG_PATH') or 'ffmpeg'
FFPROBE = os.environ.get('DSH_FFPROBE_PATH') or os.environ.get('FFPROBE_PATH') or 'ffprobe'

WIDTH = 1440
HEIGHT = 2560
FPS = 60
TARGET_BITRATE = "24M"
MAX_BITRATE = "30M"
BUFFER_SIZE = "48M"


def run(cmd: list[str]) -> None:
    proc = subprocess.run(cmd, text=True, encoding="utf-8", errors="replace", capture_output=True)
    if proc.returncode:
        raise RuntimeError("FFmpeg failed:\n" + " ".join(cmd) + "\n" + proc.stderr[-4000:])


def run_capture(cmd: list[str]) -> str:
    proc = subprocess.run(cmd, text=True, encoding="utf-8", errors="replace", capture_output=True)
    if proc.returncode:
        raise RuntimeError("FFmpeg failed:\n" + " ".join(cmd) + "\n" + proc.stderr[-4000:])
    return proc.stdout


def frame_hashes(path: Path) -> list[str]:
    """framemd5 of every decoded video frame; the last entry is the file's true last frame.

    `-map 0:v:0` is required: without it framemd5 also reports the audio stream's frames, so the
    "last" hash would belong to the audio track and any frame index derived from the count would
    be wrong. `-pix_fmt rgb24` makes the video frame and the extracted PNG comparable: the PNG is
    lossless but decodes to rgb, while the video decodes to yuv420p, and framemd5 hashes raw bytes.
    """
    lines = [
        line for line in run_capture(
            [FFMPEG, "-v", "error", "-i", str(path), "-map", "0:v:0", "-pix_fmt", "rgb24",
             "-f", "framemd5", "-"]).splitlines()
        if line and not line.startswith("#")
    ]
    return [line.split(",")[-1].strip() for line in lines]


def extract_tail_frame(video: Path, target: Path) -> None:
    """Write the video's real last frame and prove it before anything renders from it.

    `-sseof -0.05` can write no file while still exiting 0 (observed on the 13.041667 s episode-2
    clips), which silently produces an empty ending. The seek is therefore fixed at -0.1, the file
    is asserted, and the frame is proven by comparing its framemd5 with the last frame of a full
    sequential decode; a mismatch re-extracts that exact frame index, and a second mismatch stops
    the render instead of shipping a frozen frame that is not the tail.
    """
    expected = frame_hashes(video)
    if not expected:
        raise RuntimeError(f"{video}: full decode produced no frames")
    run([FFMPEG, "-y", "-v", "error", "-sseof", "-0.1", "-i", str(video),
         "-frames:v", "1", str(target)])
    if target.exists() and target.stat().st_size > 0 and frame_hashes(target)[-1:] == expected[-1:]:
        return
    # The container duration can exceed the real frame tail (the episode-2 clips report
    # 13.041667 s while their frames end at 13.0 s), so both -0.05 and -0.1 can land past the
    # last frame and write nothing. The frame count from the full decode is the authoritative
    # index, so a failed or unproven seek falls back to that exact frame.
    index = len(expected) - 1
    target.unlink(missing_ok=True)
    run([FFMPEG, "-y", "-v", "error", "-i", str(video), "-vf", f"select=eq(n\\,{index})",
         "-frames:v", "1", str(target)])
    if not target.exists() or target.stat().st_size == 0:
        raise RuntimeError(f"{video}: frame-index extraction (n={index}) wrote no file")
    if frame_hashes(target)[-1:] != expected[-1:]:
        raise RuntimeError(
            f"{video}: tail frame still differs from the last decoded frame; refusing to render")


def probe(path: Path) -> dict:
    proc = subprocess.run([
        FFPROBE, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)
    ], text=True, encoding="utf-8", errors="replace", capture_output=True, check=True)
    return json.loads(proc.stdout)


def choose_encoder() -> tuple[str, list[str], str]:
    test = subprocess.run([
        # Some NVIDIA generations reject 64x64 as below NVENC's minimum frame size.
        FFMPEG, "-v", "error", "-f", "lavfi", "-i", "color=black:s=256x256:d=0.1",
        "-frames:v", "1", "-c:v", "h264_nvenc", "-f", "null", "-"
    ], text=True, encoding="utf-8", errors="replace", capture_output=True)
    if test.returncode == 0:
        return "h264_nvenc", [
            "-preset", "p5", "-rc", "vbr", "-cq", "19",
            "-b:v", TARGET_BITRATE, "-maxrate", MAX_BITRATE,
            "-bufsize", BUFFER_SIZE, "-g", str(FPS * 2),
            "-profile:v", "high", "-level", "5.1",
        ], ""
    reason = (test.stderr or test.stdout or "NVENC probe failed").strip()[-1000:]
    return "libx264", [
        "-preset", "medium", "-b:v", TARGET_BITRATE,
        "-maxrate", MAX_BITRATE, "-bufsize", BUFFER_SIZE,
        "-g", str(FPS * 2), "-profile:v", "high", "-level", "5.1",
    ], reason


def parse_srt(path: Path) -> list[tuple[str, str, str]]:
    text = path.read_text(encoding="utf-8-sig").replace("\r\n", "\n")
    result = []
    for block in re.split(r"\n\s*\n", text.strip()):
        lines = block.splitlines()
        if len(lines) < 3 or "-->" not in lines[1]:
            continue
        start, end = [item.strip().replace(",", ".") for item in lines[1].split("-->")]
        result.append((start, end, "".join(lines[2:])))
    return result


def write_ass(srt: Path, ass: Path) -> None:
    header = """[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Default,SimHei,68,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,-2,0,1,7,0,2,40,40,520,1
Style: Watermark,Microsoft YaHei,44,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,2,20,20,20,1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
"""
    family = os.environ.get('MUSE_FONT_FAMILY')
    if family is not None:
        if not family.strip() or any(ord(c) < 32 or c in ',{}' for c in family):
            raise ValueError('MUSE_FONT_FAMILY must be a nonempty ASS font family without delimiters')
        header = header.replace('Default,SimHei,', f'Default,{family},').replace('Watermark,Microsoft YaHei,', f'Watermark,{family},')
    events = []
    for start, end, text in parse_srt(srt):
        def ass_time(value: str) -> str:
            h, m, sec = value.split(":")
            return f"{int(h)}:{int(m):02d}:{float(sec):05.2f}"
        safe = text.replace("{", "（").replace("}", "）")
        events.append(f"Dialogue: 0,{ass_time(start)},{ass_time(end)},Default,,0,0,0,,{safe}")
    # The top-right vertical notice was removed at the operator's request; only the
    # bottom-right AI-content mark is emitted now. The Watermark style stays because
    # that remaining event uses it.
    events.append(r"Dialogue: 1,0:00:00.00,9:59:59.00,Watermark,,0,0,0,,{\an3\pos(1025,1810)}内容由AI生成")
    ass.write_text(header + "\n".join(events) + "\n", encoding="utf-8-sig")


def find_audio(project: Path, episode: str) -> Path:
    for ext in ("flac", "wav", "mp3", "m4a", "aac"):
        path = project / "audio" / f"{episode}.{ext}"
        if path.exists():
            return path
    raise FileNotFoundError(f"Missing master audio for episode {episode}")


def render(args: argparse.Namespace) -> dict:
    project = args.project.resolve()
    for resource in (args.bgm, args.ending_audio, args.ending_effect):
        if not resource.is_file():
            raise FileNotFoundError(resource)
    episode = str(args.episode).zfill(2)
    timeline = json.loads(args.timeline.read_text(encoding="utf-8"))
    clips = [item for item in timeline.get("clips", []) if int(item.get("shot", 0)) <= args.last_shot]
    if len(clips) != args.last_shot:
        raise ValueError(f"Expected {args.last_shot} body clips, got {len(clips)}")
    sources = [project / 'video' / episode / f"shot_{int(clip['shot']):03d}.mp4" for clip in clips]
    source_hashes = check_videos(project, sources)
    sources.append(args.ending_effect.resolve())
    source_hashes.update(check_videos(project, [sources[-1]]))
    body_end_us = max(int(item["start_us"]) + int(item["duration_us"]) for item in clips)
    body_end = body_end_us / 1_000_000
    total_duration = body_end + args.ending_duration
    output = args.output or project / "exports" / f"{episode}.mp4"
    output.parent.mkdir(parents=True, exist_ok=True)
    final_output = output
    staging = Path(tempfile.mkdtemp(prefix='.render-', dir=output.parent))
    output = staging / 'output.mp4'
    cache = project / "exports" / ".render_cache" / episode / "2k60_h264_24m"
    cache.mkdir(parents=True, exist_ok=True)
    identity = cache / 'source-hashes.json'
    try:
        cached_hashes = json.loads(identity.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        cached_hashes = None
    force = args.force or cached_hashes != source_hashes
    identity.unlink(missing_ok=True)
    encoder, encoder_args, encoder_fallback_reason = choose_encoder()
    common_vf = (
        f"scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=increase,"
        f"crop={WIDTH}:{HEIGHT},fps={FPS},format=yuv420p"
    )

    rendered = []
    for clip in clips:
        shot = int(clip["shot"])
        source = project / "video" / episode / f"shot_{shot:03d}.mp4"
        if not source.exists():
            raise FileNotFoundError(source)
        target = cache / f"shot_{shot:03d}.mp4"
        duration = int(clip["duration_us"]) / 1_000_000
        if force or not target.exists():
            run([FFMPEG, "-y", "-v", "error", "-i", str(source), "-t", f"{duration:.6f}",
                 "-vf", common_vf, "-an", "-c:v", encoder, *encoder_args, str(target)])
        rendered.append(target)

    if args.freeze_image:
        freeze_image = args.freeze_image.resolve()
    else:
        last_video = project / "video" / episode / f"shot_{args.last_shot:03d}.mp4"
        freeze_image = cache / "last_video_tail_frame.png"
        if force or not freeze_image.exists():
            extract_tail_frame(last_video, freeze_image)
    freeze = cache / "ending.mp4"
    if force or not freeze.exists():
        ending_effect = args.ending_effect.resolve()
        if not ending_effect.exists():
            raise FileNotFoundError(ending_effect)
        effect_filter = (
            f"[0:v]scale={WIDTH}:{HEIGHT}:force_original_aspect_ratio=increase,"
            f"crop={WIDTH}:{HEIGHT},fps={FPS},format=gbrp[base];"
            f"[1:v]setpts=(PTS-STARTPTS)/{args.effect_speed:.3f},"
            "scale=540:960:force_original_aspect_ratio=increase,"
            "crop=540:960,minterpolate=fps=120:mi_mode=mci:mc_mode=aobmc:me_mode=bidir,"
            f"tmix=frames=2:weights='1 1',tpad=stop_mode=add:stop_duration={args.ending_duration:.3f}:color=black,"
            f"trim=0:{args.ending_duration:.3f},fps={FPS},scale={WIDTH}:{HEIGHT}:flags=lanczos,"
            "eq=contrast=1.28:brightness=-0.14:saturation=1.15,format=gbrp[fx];"
            "[base][fx]blend=all_mode=screen:all_opacity=0.90:shortest=1,"
            "format=yuv420p[v]"
        )
        run([FFMPEG, "-y", "-v", "error", "-loop", "1", "-i", str(freeze_image),
             "-i", str(ending_effect), "-filter_complex", effect_filter, "-map", "[v]",
             "-t", f"{args.ending_duration:.3f}", "-an",
             "-c:v", encoder, *encoder_args, str(freeze)])
    rendered.append(freeze)

    check_videos(project, rendered)
    concat_file = cache / "concat.txt"
    concat_file.write_text("\n".join(f"file '{p.as_posix()}'" for p in rendered), encoding="utf-8")
    base = cache / "base.mp4"
    run([FFMPEG, "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(concat_file), "-c", "copy", str(base)])
    ass = cache / "display.ass"
    write_ass(args.subtitle_srt, ass)
    subtitled = cache / "subtitled.mp4"
    ass_filter = subtitle_filter(ass)
    run([FFMPEG, "-y", "-v", "error", "-i", str(base), "-vf", ass_filter,
         "-an", "-c:v", encoder, *encoder_args, str(subtitled)])

    master = find_audio(project, episode)
    bgm = args.bgm.resolve()
    ending_audio = args.ending_audio.resolve()
    filter_audio = (
        f"[1:a]apad,atrim=0:{total_duration:.6f},volume={args.master_volume}[a0];"
        f"[2:a]atrim=0:{body_end:.6f},volume={args.bgm_volume}[a1];"
        f"[3:a]atrim=0:{args.ending_duration:.6f},adelay={round(body_end*1000)}|{round(body_end*1000)},volume=1[a2];"
        f"[a0][a1][a2]amix=inputs=3:duration=longest:normalize=0,"
        f"atrim=0:{total_duration:.6f},alimiter=limit=0.95:level=false[a]"
    )
    run([FFMPEG, "-y", "-v", "error", "-i", str(subtitled), "-i", str(master),
         "-stream_loop", "-1", "-i", str(bgm), "-i", str(ending_audio),
         "-filter_complex", filter_audio, "-map", "0:v:0", "-map", "[a]", "-c:v", "copy",
         "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", str(output)])
    info = probe(output)
    video = next(stream for stream in info["streams"] if stream["codec_type"] == "video")
    audio = next((stream for stream in info["streams"] if stream["codec_type"] == "audio"), None)
    actual = float(info["format"]["duration"])
    rate = video.get("avg_frame_rate") or video.get("r_frame_rate") or "0/1"
    numerator, denominator = (int(value) for value in rate.split("/"))
    actual_fps = numerator / denominator if denominator else 0
    if (video.get("width") != WIDTH or video.get("height") != HEIGHT
            or abs(actual_fps - FPS) > 0.01 or video.get("codec_name") != "h264"
            or not audio or abs(actual - total_duration) > 0.15):
        raise RuntimeError(f"Render validation failed: {video.get('width')}x{video.get('height')}, audio={bool(audio)}, duration={actual}")
    if check_videos(project, sources) != source_hashes:
        raise ValueError('Video sources changed during render; rerun with current bytes')
    check_videos(project, [output])
    output.replace(final_output)
    staging.rmdir()
    output = final_output
    identity.write_text(json.dumps(source_hashes), encoding='utf-8')
    return {"episode": episode, "status": "succeeded", "output": str(output), "encoder": encoder,
            "gpu_requested": True, "gpu_used": encoder == "h264_nvenc",
            "encoder_fallback_reason": encoder_fallback_reason,
            "codec": "h264", "fps": FPS, "target_bitrate": TARGET_BITRATE,
            "max_bitrate": MAX_BITRATE, "duration": actual,
            "expected_duration": total_duration, "width": WIDTH, "height": HEIGHT}


def subtitle_filter(ass: Path) -> str:
    """Use system font discovery unless a licensed font directory is configured."""
    fonts = os.environ.get('MUSE_FONTS_DIR') or os.environ.get('DSH_FONTS_DIR', '')
    font_option = ":fontsdir='" + Path(fonts).as_posix().replace(":", "\\:") + "'" if fonts else ""
    return (f"scale={WIDTH * 2}:{HEIGHT * 2}:flags=lanczos,"
            + "ass='" + ass.as_posix().replace(":", "\\:") + "'" + font_option
            + f",scale={WIDTH}:{HEIGHT}:flags=lanczos")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True, type=Path)
    parser.add_argument("--episode", required=True)
    parser.add_argument("--timeline", required=True, type=Path)
    parser.add_argument("--subtitle-srt", required=True, type=Path)
    parser.add_argument("--last-shot", type=int, required=True)
    parser.add_argument("--freeze-image", type=Path)
    parser.add_argument("--bgm", type=Path, required=True)
    parser.add_argument("--ending-audio", type=Path, required=True)
    parser.add_argument("--ending-effect", type=Path, required=True)
    parser.add_argument("--ending-duration", type=float, default=2.0)
    parser.add_argument("--effect-speed", type=float, default=0.728571)
    parser.add_argument("--master-volume", type=float, default=1.45)
    parser.add_argument("--bgm-volume", type=float, default=0.24)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    result = render(args)
    state_path = args.project / "exports" / "render_tasks.json"
    state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {"tasks": {}}
    state["tasks"][result["episode"]] = result
    state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
