"""
AIGC Pipeline — 剪映草稿生成 Agent

直接调用 tools.jianying_draft 模块生成剪映草稿。
功能: 音频 + 视频 + 字幕 + BGM → 剪映草稿文件
"""
import os
import sys
import shutil
import logging
import re
from typing import Dict, Any, Optional
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tweet-drama-core' / 'scripts'))
from video_bans import check_videos, find_project

logger = logging.getLogger(__name__)


class DraftGenerator:
    """
    剪映草稿生成 Agent

    直接调用 tools.jianying_draft.generate_draft，不再依赖外部工具路径。
    """

    def __init__(self, ffmpeg_path: str = ""):
        self.ffmpeg_path = ffmpeg_path

    def _setup_ffmpeg(self):
        """Configure an external FFmpeg without importing another skill's paths module."""
        target = (self.ffmpeg_path or os.getenv("DSH_FFMPEG_PATH")
                  or os.getenv("FFMPEG_PATH") or shutil.which("ffmpeg"))
        if not target or not os.path.isfile(target):
            raise FileNotFoundError("Configure DSH_FFMPEG_PATH or install ffmpeg on PATH")
        ffmpeg_dir = os.path.dirname(os.path.abspath(target))
        os.environ["PATH"] = ffmpeg_dir + os.pathsep + os.environ.get("PATH", "")
        os.environ["FFMPEG_BINARY"] = target
        logger.info(f"FFmpeg 路径已设置: {target}")

    def prepare_materials(
        self,
        audio_dir: str,
        video_dir: str,
        output_materials_dir: str,
        subtitle_dir: Optional[str] = None,
        timeline_dir: Optional[str] = None,
        bgm_dir: Optional[str] = None,
        fallback_video_dir: Optional[str] = None,
        project: Optional[str] = None,
    ) -> str:
        """
        将项目各步骤的输出整理为 jianji 期望的目录结构。

        期望结构:
            output_materials_dir/
              01_audio/       ← 01.flac, 02.flac, ...
              02_media/
                01/           ← 第1集的视频/图片文件
                02/           ← 第2集的视频/图片文件
              03_subtitle/    ← 01.srt, 02.srt, ... (可选)
              04_bgm/         ← bgm.mp3 (可选)
              05_timeline/    ← 01.timeline.json, ... (可选)
        """
        selected = {}
        for directory in (fallback_video_dir, video_dir):
            if directory:
                for path in Path(directory).glob('*/*'):
                    if path.is_file() and path.parent.name.isdigit():
                        selected[(path.parent.name, path.name)] = path
        videos = [path for path in selected.values() if path.suffix.lower() in {'.mp4', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.webm', '.m4v'}]
        if videos:
            check_videos(find_project(Path(video_dir), project), videos)
        # 先清空已存在的素材目录，确保每次都是全新的素材
        if os.path.exists(output_materials_dir):
            shutil.rmtree(output_materials_dir)
        os.makedirs(output_materials_dir, exist_ok=True)

        audio_out = os.path.join(output_materials_dir, "01_audio")
        media_out = os.path.join(output_materials_dir, "02_media")
        os.makedirs(audio_out, exist_ok=True)
        os.makedirs(media_out, exist_ok=True)

        episodes = set()

        if os.path.exists(audio_dir):
            for f in os.listdir(audio_dir):
                name = os.path.splitext(f)[0]
                if name.isdigit():
                    episodes.add(name)

        video_dirs = [
            path for path in (fallback_video_dir, video_dir)
            if path and os.path.exists(path)
        ]
        for source_dir in video_dirs:
            for d in os.listdir(source_dir):
                if os.path.isdir(os.path.join(source_dir, d)) and d.isdigit():
                    episodes.add(d)

        logger.info(f"整理 {len(episodes)} 集素材")

        for ep_num in sorted(episodes):
            for ext in (".flac", ".mp3", ".wav"):
                src = os.path.join(audio_dir, f"{ep_num}{ext}")
                if os.path.exists(src):
                    shutil.copy2(src, audio_out)

            ep_media_out = os.path.join(media_out, ep_num)
            for source_dir in video_dirs:
                video_ep_dir = os.path.join(source_dir, ep_num)
                if not os.path.exists(video_ep_dir):
                    continue
                os.makedirs(ep_media_out, exist_ok=True)
                for f in os.listdir(video_ep_dir):
                    src = os.path.join(video_ep_dir, f)
                    if os.path.isfile(src):
                        # fallback is copied first; sorted video_dir overwrites
                        # the same shot while leaving unmatched shots intact.
                        shutil.copy2(src, ep_media_out)

        if subtitle_dir and os.path.exists(subtitle_dir):
            subtitle_out = os.path.join(output_materials_dir, "03_subtitle")
            os.makedirs(subtitle_out, exist_ok=True)
            for ep_num in sorted(episodes):
                for ext in (".srt", ".ass", ".vtt"):
                    src = os.path.join(subtitle_dir, f"{ep_num}{ext}")
                    if os.path.exists(src):
                        shutil.copy2(src, subtitle_out)

        if timeline_dir and os.path.exists(timeline_dir):
            timeline_out = os.path.join(output_materials_dir, "05_timeline")
            os.makedirs(timeline_out, exist_ok=True)
            for ep_num in sorted(episodes):
                src = os.path.join(timeline_dir, f"{ep_num}.timeline.json")
                if os.path.exists(src):
                    shutil.copy2(src, timeline_out)

        if bgm_dir and os.path.exists(bgm_dir):
            bgm_out = os.path.join(output_materials_dir, "04_bgm")
            os.makedirs(bgm_out, exist_ok=True)
            for f in os.listdir(bgm_dir):
                src = os.path.join(bgm_dir, f)
                if os.path.isfile(src):
                    shutil.copy2(src, bgm_out)
                    break

        return output_materials_dir

    def process(
        self,
        materials_dir: str,
        drafts_dir: str,
        name_prefix: str = "",
        template: Optional[str] = None,
        seq: Optional[str] = None,
        project: Optional[str] = None,
    ) -> Dict[str, Any]:
        os.makedirs(drafts_dir, exist_ok=True)

        # 配置 ffmpeg
        self._setup_ffmpeg()

        # 直接调用本地模块
        from jianying_draft import generate_draft

        existing_dirs = set()
        try:
            existing_dirs = {
                d for d in os.listdir(drafts_dir)
                if os.path.isdir(os.path.join(drafts_dir, d))
            }
        except OSError:
            pass

        result = generate_draft(
            drafts_dir=drafts_dir,
            materials_dir=materials_dir,
            name_prefix=name_prefix,
            template_dir=drafts_dir,
            seq=seq,
            project=project,
        )

        if not result.get("success"):
            return result

        new_dirs = {
            d for d in os.listdir(drafts_dir)
            if os.path.isdir(os.path.join(drafts_dir, d))
        } - existing_dirs
        draft_count = len(new_dirs)

        logger.info(f"剪映草稿生成完成: {draft_count} 个新草稿")
        return {
            "success": True,
            "drafts_created": draft_count,
        }


def _read_text_if_exists(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read()
    except OSError:
        return ""


def _collect_media_shots(ep_num: str, *roots: str) -> list[int]:
    shots = set()
    for root in roots:
        ep_dir = os.path.join(root or "", ep_num)
        if not os.path.isdir(ep_dir):
            continue
        for name in os.listdir(ep_dir):
            if not name.lower().endswith((".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v")):
                continue
            match = re.search(r"(\d+)", os.path.splitext(name)[0])
            if match:
                shots.add(int(match.group(1)))
    return sorted(shots)
