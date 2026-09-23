import os
import re
import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tweet-drama-core' / 'scripts'))
from video_bans import check_videos, find_project

_VENDOR_DIR = Path(__file__).resolve().parent / "vendor"
if _VENDOR_DIR.is_dir() and str(_VENDOR_DIR) not in sys.path:
    sys.path.insert(0, str(_VENDOR_DIR))

_SKILL_ROOT = Path(__file__).resolve().parents[1]
_FFMPEG_DIR = _SKILL_ROOT / "tools" / "ffmpeg"
_FFMPEG_EXE = _FFMPEG_DIR / "ffmpeg.exe"
_FFPROBE_EXE = _FFMPEG_DIR / "ffprobe.exe"
if _FFMPEG_EXE.is_file():
    os.environ.setdefault("FFMPEG_BINARY", str(_FFMPEG_EXE))
    os.environ["PATH"] = str(_FFMPEG_DIR) + os.pathsep + os.environ.get("PATH", "")
if _FFPROBE_EXE.is_file():
    os.environ.setdefault("FFPROBE_BINARY", str(_FFPROBE_EXE))

import pyJianYingDraft as draft

logger = logging.getLogger(__name__)


class DraftInputError(ValueError):
    """Invalid or incomplete material input for draft generation."""

# 音频文件分析相关导入
try:
    from pydub import AudioSegment
    from pydub.silence import detect_silence
    PYDUB_AVAILABLE = True
except ImportError:
    PYDUB_AVAILABLE = False
    logger.info("pydub 未安装，将使用原始音频（不进行静音消除）")
except Exception:
    PYDUB_AVAILABLE = False


def seq_from_name(name: str) -> str | None:
    m = re.match(r"^(\d{2})", name)
    return m.group(1) if m else None


def find_first_file(folder: Path) -> Path:
    files = [p for p in folder.iterdir() if p.is_file()]
    files.sort(key=lambda p: p.name)
    if not files:
        raise DraftInputError(f"No files in: {folder}")
    return files[0]
def find_subdir_by_prefix(root: Path, prefix: str) -> Path | None:
    if not root.exists():
        return None
    matches = [p for p in root.iterdir() if p.is_dir() and p.name.startswith(prefix)]
    if not matches:
        return None
    matches.sort(key=lambda p: (len(p.name), p.name))
    return matches[0]


def has_mostly_numbered_files(folder):
    """检查文件夹中是否大多数文件以数字开头"""
    import re
    try:
        files = [f for f in folder.iterdir() if f.is_file()]
        if not files:
            return False
        numbered_count = 0
        for f in files:
            if re.match(r'^\d+', f.name):
                numbered_count += 1
        return numbered_count / len(files) >= 0.6
    except Exception:
        return False


def find_all_folders_by_type(root_path, material_type):
    """查找所有匹配类型的文件夹（返回列表）"""
    if not root_path.exists():
        return []

    type_config = {
        'audio': {
            'prefixes': ['01'],
            'keywords': ['音频', 'sound', 'voice', 'audio_files', 'sound_files', '语音素材'],
            'extensions': ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg']
        },
        'image': {
            'prefixes': ['02'],
            'keywords': ['图片', 'img', 'pic', '分镜', '场景', '画面', 'image_files', 'pic_files', '图片素材'],
            'extensions': ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']
        },
        'video': {
            'prefixes': ['02'],
            'keywords': ['视频', 'video', 'vid', '分镜', '场景', '画面', 'video_files', 'vid_files', '视频素材'],
            'extensions': ['.mp4', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.webm', '.m4v']
        },
        'media': {
            'prefixes': ['02'],
            'keywords': ['图片', 'img', 'pic', '视频', 'video', 'vid', '分镜', '场景', '画面', 'media_files', '媒体素材'],
            'extensions': ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.mp4', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.webm', '.m4v']
        },
        'bgm': {
            'prefixes': ['04'],
            'keywords': ['背景音乐', 'bgm', '音乐', '配乐', 'bgm_files', 'music_files'],
            'extensions': ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg']
        },
        'subtitle': {
            'prefixes': ['03'],
            'keywords': ['字幕', 'subtitle', 'srt', 'caption', 'sub', '字幕文件'],
            'extensions': ['.srt', '.ass', '.ssa', '.vtt']
        }
    }

    config = type_config.get(material_type)
    if not config:
        return []

    subdirs = [p for p in root_path.iterdir() if p.is_dir() and p.name.lower() != "silence"]
    matches = []

    for subdir in subdirs:
        score = 0
        for prefix in config['prefixes']:
            if subdir.name.startswith(prefix):
                score += 100
                break
        for keyword in config['keywords']:
            if keyword.lower() in subdir.name.lower():
                score += 50
                break
        try:
            file_count = 0
            for file in subdir.iterdir():
                if file.is_file() and any(file.name.lower().endswith(ext) for ext in config['extensions']):
                    file_count += 1
            if file_count > 0:
                score += min(file_count * 10, 80)
            if score > 0:
                matches.append((score, subdir))
        except Exception:
            continue

    matches.sort(key=lambda x: x[0], reverse=True)
    return [subdir for score, subdir in matches]


def get_media_type(folder):
    """检测文件夹中的媒体类型"""
    image_extensions = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']
    video_extensions = ['.mp4', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.webm', '.m4v']

    has_images = False
    has_videos = False

    try:
        # 首先检查根目录是否有文件
        for file in folder.iterdir():
            if file.is_file():
                if any(file.name.lower().endswith(ext) for ext in image_extensions):
                    has_images = True
                if any(file.name.lower().endswith(ext) for ext in video_extensions):
                    has_videos = True

                # 如果已经找到两种类型，提前结束检查
                if has_images and has_videos:
                    break
    except Exception as e:
        logger.info(f"检测媒体类型时出错: {e}")

    # 如果根目录没有找到文件，检查子文件夹（对于分镜/图片这种包含子文件夹的情况
    if not has_images and not has_videos:
        try:
            for subfolder in folder.iterdir():
                if subfolder.is_dir():
                    # 检查子文件夹中是否有文件
                    for file in subfolder.iterdir():
                        if file.is_file():
                            if any(file.name.lower().endswith(ext) for ext in image_extensions):
                                has_images = True
                            if any(file.name.lower().endswith(ext) for ext in video_extensions):
                                has_videos = True
                        if has_images and has_videos:
                            break
                if has_images and has_videos:
                    break
        except Exception as e:
            logger.info(f"检查子文件夹媒体类型时出错: {e}")

    if has_images and has_videos:
        return 'both'
    elif has_images:
        return 'image'
    elif has_videos:
        return 'video'
    else:
        return 'unknown'


def find_media_folder_smart(root: Path) -> Path | None:
    """智能查找媒体文件夹（支持图片、视频或两者）"""
    # 首先尝试查找图片文件夹
    img_folders = find_all_folders_by_type(root, 'image')
    if img_folders:
        return img_folders[0]

    # 然后尝试查找视频文件夹
    video_folders = find_all_folders_by_type(root, 'video')
    if video_folders:
        return video_folders[0]

    # 最后尝试查找通用媒体文件夹
    media_folders = find_all_folders_by_type(root, 'media')
    if media_folders:
        return media_folders[0]

    # 如果都找不到，尝试查找以02开头的文件夹
    for p in root.iterdir():
        if p.is_dir() and (p.name.startswith('02') or any(keyword in p.name.lower() for keyword in ['图片', '视频', 'media', 'img', 'vid'])):
            return p

    return None


def find_material_folder_smart(root: Path, material_type: str, exclude_folders: list = None) -> Path | None:
    """智能查找素材文件夹"""
    if not root.exists():
        return None

    if exclude_folders is None:
        exclude_folders = []

    type_config = {
        'audio': {
            'prefixes': ['01'],
            'keywords': ['audio', 'voice', 'sound', '音频', '声音', '语音', 'audio_files', 'sound_files', '语音素材'],
            'extensions': ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg']
        },
        'image': {
            'prefixes': ['02'],
            'keywords': ['image', 'img', 'pic', 'picture', 'photo', '图片', '照片', '分镜', '场景', '画面', 'image_files', 'pic_files', '图片素材'],
            'extensions': ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']
        },
        'bgm': {
            'prefixes': ['04'],
            'keywords': ['bgm', 'music', 'background', '背景音乐', '音乐', '配乐', '背景音乐素材', 'bgm_files', 'music_files'],
            'extensions': ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg']
        },
        'subtitle': {
            'prefixes': ['03'],
            'keywords': ['subtitle', 'srt', 'caption', '字幕', 'sub', '字幕文件', 'subtitle_files', 'srt_files'],
            'extensions': ['.srt', '.ass', '.ssa', '.vtt']
        }
    }

    config = type_config.get(material_type)
    if not config:
        return None

    # 排除指定的文件夹
    subdirs = [p for p in root.iterdir() if p.is_dir() and p not in exclude_folders]
    if not subdirs:
        return None

    scored_dirs = []
    for subdir in subdirs:
        score = 0
        # 前缀匹配（最高优先级）
        for prefix in config['prefixes']:
            if subdir.name.startswith(prefix):
                score += 100
                break
        # 关键词匹配
        for keyword in config['keywords']:
            if keyword.lower() in subdir.name.lower():
                score += 50
                break
        # 内容匹配（根据文件类型统计）
        try:
            file_count = 0
            for file in subdir.iterdir():
                if file.is_file():
                    if any(file.name.lower().endswith(ext) for ext in config['extensions']):
                        file_count += 1
                        if material_type == 'bgm':
                            for keyword in ['bgm', 'music', '背景音乐']:
                                if keyword.lower() in file.name.lower():
                                    file_count += 1
            if file_count > 0:
                score += min(file_count * 10, 80)
        except Exception:
            pass
        if score > 0:
            scored_dirs.append((score, subdir))

    if scored_dirs:
        scored_dirs.sort(key=lambda x: x[0], reverse=True)
        return scored_dirs[0][1]

    # 如果没有找到匹配的文件夹，尝试直接按文件内容识别（遍历所有文件夹看是否包含特定类型的文件）
    for subdir in subdirs:
        try:
            has_files = False
            for file in subdir.iterdir():
                if file.is_file() and any(file.name.lower().endswith(ext) for ext in config['extensions']):
                    has_files = True
                    break
            if has_files:
                logger.info(f"WARN: 自动识别到文件夹 '{subdir.name}' 包含 {material_type} 素材")
                return subdir
        except Exception:
            continue

    return None


def seq_from_name_smart(name: str, strategy: str = 'first') -> str | None:
    """
    智能从文件名提取序列编号

    Args:
        name: 文件名
        strategy: 提取策略 ('first'=第一个数字, 'last'=最后一个数字, 'max'=最大数字)

    Returns:
        标准化为2位的序列编号，找不到返回None
    """
    # 提取所有数字
    numbers = re.findall(r'(\d+)', name)
    if not numbers:
        return None

    if strategy == 'first':
        num_str = numbers[0]
    elif strategy == 'last':
        num_str = numbers[-1]
    elif strategy == 'max':
        num_str = max(numbers, key=lambda x: int(x))
    else:
        num_str = numbers[0]

    # 标准化为2位数字（不足补0，超过2位取前2位）
    num = int(num_str)
    return f"{min(num, 99):02d}"


def find_img_pack_smart(media_root: Path, seq: str) -> Path | None:
    """
    智能查找媒体文件夹（支持图片、视频或两者）

    Args:
        media_root: 媒体根目录
        seq: 序列编号（2位字符串）

    Returns:
        找到的媒体文件夹路径，找不到返回None
    """
    if not media_root.exists():
        return None

    seq_num = int(seq)
    seq_1digit = str(seq_num)

    subdirs = [p for p in media_root.iterdir() if p.is_dir()]

    # 1. 精确匹配（优先）
    for subdir in subdirs:
        if subdir.name == seq:
            return subdir

    # 2. 1位数字匹配
    for subdir in subdirs:
        if subdir.name == seq_1digit:
            return subdir

    # 3. 包含匹配（文件夹名包含数字即可）
    for subdir in subdirs:
        numbers = re.findall(r'(\d+)', subdir.name)
        if numbers:
            for num_str in numbers:
                num = int(num_str)
                if num == seq_num:
                    return subdir

    return None


def detect_audio_gaps(audio_path: str, silence_threshold: int = -50, min_silence_len: int = 100) -> list:
    """
    检测音频文件中的静音间隙

    Args:
        audio_path: 音频文件路径
        silence_threshold: 静音阈值（dBFS），默认-50（越负数越安静）
        min_silence_len: 最小静音长度（毫秒），默认50ms

    Returns:
        list: 静音时间范围列表，每个元素包含[start_ms, end_ms, duration_ms]
    """
    if not PYDUB_AVAILABLE:
        return []

    try:
        audio = AudioSegment.from_file(audio_path)

        # 检测静音
        silences = detect_silence(audio, min_silence_len=min_silence_len, silence_thresh=silence_threshold)

        gaps = []
        for start, end in silences:
            duration = end - start
            gaps.append([start, end, duration])
            logger.info(f"    发现静音间隙: 开始={start}ms, 结束={end}ms, 时长={duration}ms")

        return gaps
    except Exception as e:
        logger.info(f"    音频分析失败: {e}")
        return []

def remove_audio_gaps(audio_path: str, silence_threshold: int = -50, min_silence_len: int = 100, keep_silence: int = 130) -> str:
    """
    消除音频文件中的静音间隙

    Args:
        audio_path: 原始音频文件路径
        silence_threshold: 静音阈值（dBFS），默认-50
        min_silence_len: 最小静音长度（毫秒），默认50ms
        keep_silence: 保留的静音长度（毫秒），默认20ms

    Returns:
        str: 处理后的音频文件路径
    """
    if not PYDUB_AVAILABLE:
        return audio_path

    try:
        from pathlib import Path

        audio = AudioSegment.from_file(audio_path)
        logger.info(f"  正在消除音频静音...")

        # 检测静音
        silences = detect_silence(audio, min_silence_len=min_silence_len, silence_thresh=silence_threshold)

        if not silences:
            logger.info(f"  音频没有需要消除的静音")
            return audio_path

        # 生成处理后的音频 - 保留少量静音让过渡更自然
        processed_audio = AudioSegment.empty()
        last_end = 0

        for start, end in silences:
            # 添加静音前的音频片段
            if start > last_end:
                processed_audio += audio[last_end:start]

            # 添加保留的少量静音（平滑过渡）
            processed_audio += AudioSegment.silent(duration=keep_silence)
            last_end = end

        # 添加最后一个片段
        if last_end < len(audio):
            processed_audio += audio[last_end:]

        # 保存处理后的音频文件
        original_path = Path(audio_path)
        # 创建silence文件夹（如果不存在）
        silence_folder = original_path.parent / "silence"
        silence_folder.mkdir(exist_ok=True)
        # 保存到silence文件夹，保持原文件名
        processed_path = silence_folder / f"{original_path.stem}_no_silence{original_path.suffix}"
        processed_audio.export(str(processed_path), format=original_path.suffix[1:])

        original_duration = len(audio)
        processed_duration = len(processed_audio)
        removed = original_duration - processed_duration

        logger.info(f"  原始音频时长: {original_duration}ms")
        logger.info(f"  处理后时长: {processed_duration}ms")
        logger.info(f"  消除静音总时长: {removed}ms")
        logger.info(f"  处理后音频保存至: {processed_path}")

        return str(processed_path)

    except Exception as e:
        logger.info(f"  消除音频静音失败: {e}")
        import traceback
        logger.info(f"  错误详情: {traceback.format_exc()}")
        return audio_path

# 改进的素材替换函数，添加详细的错误处理
def replace_material(script, old_name, new_material, material_type):
    """
    替换素材的函数，添加详细的错误处理和日志
    
    Args:
        script: 草稿脚本对象
        old_name: 旧素材名称
        new_material: 新素材对象
        material_type: 素材类型（用于日志）
    
    Returns:
        bool: 是否替换成功
    """
    try:
        # 尝试使用不同的替换方法
        if hasattr(script, 'replace_material_by_name'):
            logger.info(f"  Trying to replace {material_type} using replace_material_by_name: {old_name}")
            script.replace_material_by_name(old_name, new_material)
            return True
        else:
            logger.info(f"  No replace method found for {material_type}")
            return False
    except Exception as e:
        # 捕获所有异常，避免替换失败导致整个脚本停止
        logger.info(f"  Failed to replace {material_type} {old_name}: {e}")
        return False


def load_edit_timeline(timeline_path) -> dict:
    if not timeline_path or not Path(timeline_path).exists():
        return {}
    try:
        with open(timeline_path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        logger.info(f"读取语义时间轴失败 {timeline_path}: {exc}")
        return {}
    clips = {}
    for item in payload.get("clips", []):
        try:
            shot = int(item.get("shot"))
            duration = int(item.get("duration_us"))
            start = int(item.get("start_us", 0))
        except (TypeError, ValueError, AttributeError):
            continue
        if shot > 0 and duration > 0:
            clips[shot] = {"start_us": start, "duration_us": duration}
    if clips:
        logger.info(f"读取语义时间轴 {timeline_path}: {len(clips)} 个镜头")
    return clips


def _media_shot_number(media_file: Path) -> int:
    match = re.search(r"(\d+)", media_file.stem)
    return int(match.group(1)) if match else 0


def main_with_args(args):
    if not isinstance(args.name_prefix, str) or re.search(r'[<>:"/\\|?*\x00-\x1f]', args.name_prefix):
        raise DraftInputError('name_prefix 只能包含合法的草稿名称字符，不能包含路径或 Windows 保留字符。')
    drafts_dir = Path(args.drafts)
    # 如果template-dir为None，使用与drafts相同的目录
    if args.template_dir is None:
        template_dir = drafts_dir
    else:
        template_dir = Path(args.template_dir)
    root = Path(args.materials)

    logger.info(f"正在智能识别素材文件夹...")
    logger.info(f"  [根目录] 素材根目录: {root}")
    logger.info(f"  [根目录] 包含的子文件夹: {[p.name for p in root.iterdir() if p.is_dir()]}")

    audio_dir = find_material_folder_smart(root, 'audio')
    media_dir = find_media_folder_smart(root)
    if media_dir is None:
        raise DraftInputError("无法识别媒体素材文件夹（图片或视频），请确保包含图片或视频文件的文件夹")

    media_type = get_media_type(media_dir)
    if media_type == 'unknown':
        raise DraftInputError("媒体文件夹中没有找到有效的图片或视频文件")

    logger.info(f"  [media] 识别到{'图片+视频' if media_type == 'both' else '图片' if media_type == 'image' else '视频'}文件夹: {media_dir.name}")

    srt_dir = find_material_folder_smart(root, 'subtitle')
    timeline_dir = root / "05_timeline"
    bgm_dir = find_material_folder_smart(root, 'bgm', exclude_folders=[audio_dir])

    logger.info(f"  [audio] 识别到音频文件夹: {audio_dir.name if audio_dir else '未找到'}")
    logger.info(f"  [bgm] 识别到BGM文件夹: {bgm_dir.name if bgm_dir else '未找到'}")

    if audio_dir is None:
        raise DraftInputError("无法识别音频素材文件夹，请确保包含音频文件的文件夹")
    if bgm_dir is None:
        # 尝试查找所有包含音频文件的文件夹，排除音频文件夹
        logger.info(f"  [bgm] 未找到明确的BGM文件夹，尝试查找其他音频文件夹...")
        all_audio_folders = []
        for subdir in root.iterdir():
            if subdir.is_dir() and subdir != audio_dir:
                try:
                    has_audio = any(f.is_file() and f.name.lower().endswith(('.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'))
                                   for f in subdir.iterdir())
                    if has_audio:
                        all_audio_folders.append(subdir)
                        logger.info(f"  [bgm] 发现备选文件夹: {subdir.name}")
                except Exception:
                    pass
        if all_audio_folders:
            # 选择第一个非音频文件夹的音频文件夹作为BGM文件夹
            bgm_dir = all_audio_folders[0]
            logger.info(f"  [bgm] 使用备选BGM文件夹: {bgm_dir.name}")
        else:
            logger.info(f"  [bgm] 未找到BGM文件夹，将跳过背景音乐")

    has_srt_dir = (srt_dir is not None) and srt_dir.exists()
    has_timeline_dir = timeline_dir.exists()

    bgm_path = None
    if bgm_dir is not None and bgm_dir.exists():
        # 显示BGM文件夹中的所有文件
        logger.info(f"  [bgm] BGM文件夹中的文件: {[f.name for f in bgm_dir.iterdir() if f.is_file()]}")
        bgm_files = [p for p in bgm_dir.iterdir() if p.is_file()]
        if bgm_files:
            bgm_path = sorted(bgm_files, key=lambda p: p.name)[0]
            logger.info(f"  [bgm] 使用BGM文件: {bgm_path.name}")
        else:
            logger.info(f"  [bgm] BGM文件夹为空，将跳过背景音乐")
    logger.info(f"  [audio] 音频文件夹: {audio_dir.name}, 文件示例: {[f.name for f in audio_dir.iterdir() if f.is_file()][:3] if audio_dir else '无'}")

    audios = sorted([p for p in audio_dir.iterdir() if p.is_file()], key=lambda p: p.name)
    if not audios:
        raise DraftInputError("01* audio folder is empty")

    # 创建DraftFolder对象用于保存新草稿
    output_folder = draft.DraftFolder(str(drafts_dir))

    # 调试：查看DraftFolder对象的所有方法
    logger.info(f"DraftFolder methods: {dir(output_folder)}")

    # 定义更广泛的占位素材名称列表，增加替换成功率
    audio_placeholders = ["voice.wav", "voice.mp3", "voice.m4a", "audio.wav", "audio.mp3", "01.wav", "01.mp3", "audio", "voice"]
    bgm_placeholders = ["bgm.mp3", "bgm.wav", "music.mp3", "music.wav", "00.mp3", "00.wav", "bgm", "music"]
    
    # 生成图片占位名称列表，包括更多可能的格式
    image_placeholders = []
    for i in range(1, 30):
        # 2位数字格式
        image_placeholders.extend([f"{i:02d}.jpg", f"{i:02d}.jpeg", f"{i:02d}.png", f"{i:02d}.webp", f"{i:02d}.bmp"])
        # 1位数字格式
        image_placeholders.extend([f"{i}.jpg", f"{i}.jpeg", f"{i}.png", f"{i}.webp", f"{i}.bmp"])
    
    # 字幕占位名称列表
    subtitle_placeholders = ["00.srt", "sub.srt", "subtitle.srt", "subtitles.srt", "01.srt", "subtitle"]

    for a in audios:
        seq = seq_from_name_smart(a.stem, strategy='first')
        if not seq:
            logger.info(f"  无法从文件名提取序列编号: {a.name}，尝试使用文件顺序")
            # 使用文件在列表中的索引作为序号
            seq_idx = audios.index(a) + 1
            seq = f"{seq_idx:02d}"
            logger.info(f"  使用序号: {seq}")
        
        # 只处理指定的序列
        if args.seq and seq != args.seq:
            continue

        img_pack = find_img_pack_smart(media_dir, seq)
        if not img_pack:
            logger.info(f"[序列 {seq}] 无法找到对应的媒体文件夹，跳过")
            continue

        logger.info(f"[序列 {seq}] 找到媒体文件夹: {img_pack}")
        logger.info(f"[序列 {seq}] 媒体文件夹内容: {[f.name for f in img_pack.iterdir()]}")

        srt_path = (srt_dir / f"{seq}.srt") if has_srt_dir else None
        timeline_path = (timeline_dir / f"{seq}.timeline.json") if has_timeline_dir else None
        timeline_clips = load_edit_timeline(timeline_path)

        # 获取媒体文件列表 - 直接在当前序列文件夹中搜索所有图片和视频文件
        image_extensions = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']
        video_extensions = ['.mp4', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.webm', '.m4v']

        media_files = []
        for p in img_pack.iterdir():
            if p.is_file():
                if any(p.name.lower().endswith(ext) for ext in image_extensions + video_extensions):
                    media_files.append(p)

        logger.info(f"[序列 {seq}] 找到 {len(media_files)} 个媒体文件: {[f.name for f in media_files]}")

        if not media_files:
            logger.info(f"Skipped {seq}: empty media pack: {img_pack}")
            continue

        videos = [path for path in media_files if path.suffix.lower() in video_extensions]
        if videos:
            check_videos(find_project(root, getattr(args, 'project', None)), videos)

        # 使用简单的名称格式，只包含前缀和序列编号
        draft_name = f"{args.name_prefix}{seq}"

        draft_path = drafts_dir / draft_name
        if draft_path.exists():
            raise DraftInputError(f"{draft_path} 已存在，拒绝覆盖；请为新候选指定唯一 name_prefix。")

        # 复制模板草稿为新草稿
        script = None
        for attempt in range(1, 10):
            try:
                logger.info(f"[{draft_name}] Attempt {attempt}: Trying to create draft...")
                # 首先尝试创建新草稿
                script = output_folder.create_draft(draft_name, width=1440, height=2560, fps=60)
                logger.info(f"[{draft_name}] Successfully created new draft: {draft_name} with 1440x2560 at 60fps")
                break
            except Exception as ex:
                logger.info(f"[{draft_name}] Failed to create draft: {ex}")
                # 直接使用原名称重试，不添加后缀
                logger.info(f"[{draft_name}] Retrying with same name...")
                continue
        
        if script is None:
            logger.info(f"[{draft_name}] Failed to create draft after multiple attempts")
            continue

        # 禁用主轨道吸附（主轨磁吸），避免自动对齐导致的间隙
        script.maintrack_adsorb = False
        script.content.setdefault("config", {})["subtitle_sync"] = False
        script.content["config"]["lyrics_sync"] = False
        script.content["config"]["attachment_info"] = []
        script.content["relationships"] = []
        logger.info(f"[{draft_name}] Disabled main track adsorb to prevent gap issues")

        # 检查脚本对象的结构
        logger.info(f"[{draft_name}] Checking script structure...")
        logger.info(f"  Script type: {type(script)}")
        logger.info(f"  Script dir: {dir(script)}")
        
        # 尝试获取脚本的轨道信息
        try:
            if hasattr(script, 'get_tracks'):
                tracks = script.get_tracks()
                logger.info(f"[{draft_name}] Tracks: {tracks}")
            elif hasattr(script, 'tracks'):
                logger.info(f"[{draft_name}] Tracks: {script.tracks}")
        except Exception as e:
            logger.info(f"[{draft_name}] Failed to get tracks: {e}")
        
        # 检查是否是新创建的草稿（没有模板素材）
        is_new_draft = True
        logger.info(f"[{draft_name}] Forcing new draft mode - will add all materials to timeline")
        
        if is_new_draft:
            # 新创建的草稿，直接添加素材到时间线
            logger.info(f"[{draft_name}] Adding materials to new draft...")
            
            # 1) 添加主音频轨道和音频
            logger.info(f"[{draft_name}] Adding main audio...")
            try:
                # 分析音频文件是否有静音间隙
                logger.info(f"[{draft_name}] Analyzing audio file for gaps...")
                # The corrected subtitle timeline is the single source of truth.
                # Never remove pauses from the master audio in a formal draft.
                gaps = []
                processed_audio_path = str(a)
                audio_duration_probe_ms = None
                try:
                    if PYDUB_AVAILABLE:
                        audio_duration_probe_ms = len(AudioSegment.from_file(str(a)))
                except Exception:
                    audio_duration_probe_ms = None
                entire_audio_is_silence = (
                    audio_duration_probe_ms is not None
                    and len(gaps) == 1
                    and gaps[0][0] <= 10
                    and gaps[0][1] >= audio_duration_probe_ms - 10
                )
                if gaps and not entire_audio_is_silence:
                    logger.info(f"[{draft_name}] 警告: 音频文件包含 {len(gaps)} 个静音间隙")
                    total_gap_time = sum(gap[2] for gap in gaps)
                    logger.info(f"[{draft_name}] 总静音时长: {total_gap_time}ms")

                    # 消除音频内部的静音
                    processed_audio_path = remove_audio_gaps(str(a), keep_silence=130)
                    if processed_audio_path != str(a):
                        logger.info(f"[{draft_name}] 已成功消除音频内部静音")
                    else:
                        logger.info(f"[{draft_name}] 音频静音消除失败，将使用原始音频")
                elif entire_audio_is_silence:
                    logger.info(f"[{draft_name}] 音频是整段静音测试音频，跳过去静音处理")
                else:
                    logger.info(f"[{draft_name}] 音频文件分析完成，未发现明显的静音间隙")

                # 使用处理后的音频
                voice_new = draft.AudioMaterial(processed_audio_path)

                # 添加音频轨道
                from pyJianYingDraft.track import TrackSpec
                audio_track = script.append_track(TrackSpec(draft.TrackType.audio, "主音频轨道"))
                # 创建音频片段并添加到轨道
                from pyJianYingDraft.time_util import Timerange, tim
                audio_duration = voice_new.duration
                audio_segment = draft.AudioSegment(voice_new, Timerange(0, audio_duration))
                # 调整音量到15级（剪映标准）
                audio_segment.volume = 15
                script.add_segment(audio_segment, audio_track)
                logger.info(f"[{draft_name}] Successfully added main audio to timeline")
            except Exception as e:
                logger.info(f"[{draft_name}] Failed to add main audio: {e}")

            # 2) 添加 BGM 轨道和音频（确保与主音频时长一致）
            if bgm_path is not None:
                logger.info(f"[{draft_name}] Adding BGM...")
                try:
                    bgm_new = draft.AudioMaterial(str(bgm_path))
                    from pyJianYingDraft.track import TrackSpec
                    bgm_track = script.append_track(TrackSpec(draft.TrackType.audio, "BGM轨道"))

                    bgm_duration = bgm_new.duration
                    total_audio_duration = audio_duration

                    logger.info(f"[{draft_name}] Main audio duration: {total_audio_duration} us")
                    logger.info(f"[{draft_name}] BGM duration: {bgm_duration} us")

                    if bgm_duration > total_audio_duration:
                        bgm_segment = draft.AudioSegment(bgm_new, Timerange(0, total_audio_duration))
                        logger.info(f"[{draft_name}] BGM trimmed to match main audio duration")
                    else:
                        bgm_segment = draft.AudioSegment(bgm_new, Timerange(0, bgm_duration))
                        logger.info(f"[{draft_name}] BGM shorter than main audio, using full BGM duration")

                    bgm_segment.volume = 1
                    script.add_segment(bgm_segment, bgm_track)
                    logger.info(f"[{draft_name}] Successfully added BGM to timeline (volume: 1)")
                except Exception as e:
                    logger.info(f"[{draft_name}] Failed to add BGM: {e}")

            # 3) 添加视频轨道和媒体（图片或视频）
            logger.info(f"[{draft_name}] Adding media...")
            media_added_count = 0
            try:
                # 添加视频轨道
                from pyJianYingDraft.track import TrackSpec
                video_track = script.append_track(TrackSpec(draft.TrackType.video, "视频轨道"))

                # 获取媒体文件列表 - 检测当前序列文件夹中的媒体类型，支持图片+视频混合
                image_extensions = ['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']
                video_extensions = ['.mp4', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.webm', '.m4v']

                # 搜索当前序列文件夹中的所有媒体文件（图片和视频）
                media_files = []
                for p in img_pack.iterdir():
                    if p.is_file():
                        if any(p.name.lower().endswith(ext) for ext in image_extensions + video_extensions):
                            media_files.append(p)

                if not media_files:
                    logger.info(f"[{draft_name}] 序列 {seq} 的媒体文件夹为空")
                    continue

                # 对媒体文件进行排序
                def sort_media_files(files):
                    def get_file_number(file):
                        match = re.search(r'(\d+)', file.name)
                        if match:
                            return int(match.group(1))
                        return 0

                    return sorted(files, key=get_file_number)

                media_files = sort_media_files(media_files)
                logger.info(f"[{draft_name}] Sorted media files: {[f.name for f in media_files]}")

                # 有语义时间轴时按音频字幕铺镜头；否则保持旧版每个视频固定 5 秒
                from pyJianYingDraft.time_util import Timerange, tim

                CLIP_DURATION = round(5 * 1000000)
                current_time = 0

                for idx, media_file in enumerate(media_files, start=1):
                    try:
                        logger.info(f"[{draft_name}] Processing media {idx}: {str(media_file)}")

                        media_material = draft.VideoMaterial(str(media_file))

                        clip = timeline_clips.get(_media_shot_number(media_file))
                        if clip:
                            start_time = int(clip.get("start_us", current_time))
                            duration = max(int(clip.get("duration_us", CLIP_DURATION)), 500000)
                            # Container-reported duration can be a few frames longer than
                            # Jianying's decoded media duration. Keep the whole source clip
                            # without requesting an invalid overrun.
                            if media_file.suffix.lower() in video_extensions:
                                duration = min(duration, int(media_material.duration))
                        else:
                            start_time = current_time
                            duration = CLIP_DURATION

                        video_segment = draft.VideoSegment(media_material, Timerange(start_time, duration))
                        script.add_segment(video_segment, video_track)
                        logger.info(f"[{draft_name}] Successfully added media {idx} to timeline")
                        media_added_count += 1

                        current_time = max(current_time + CLIP_DURATION, start_time + duration)

                    except Exception as e:
                        logger.info(f"[{draft_name}] Failed to add media {idx}: {e}")
            except Exception as e:
                logger.info(f"[{draft_name}] Failed to add media: {e}")

            logger.info(f"[{draft_name}] Added {media_added_count} out of {len(media_files)} media files to timeline")

            # 4) 导入字幕
            if srt_path and srt_path.exists():
                logger.info(f"[{draft_name}] Importing subtitle...")
                try:
                    if hasattr(script, 'import_srt'):
                        # 导入字幕到文本轨道，设置样式
                        from pyJianYingDraft.text_segment import TextStyle, TextBorder, TextSegment
                        from pyJianYingDraft.segment import ClipSettings
                        
                        # 创建字幕样式：11号字体，黑色边框+白底字
                        text_style = TextStyle(
                            size=11.0,
                            bold=False,
                            letter_spacing=0,
                            color=(1.0, 1.0, 1.0),
                            align=1,
                            auto_wrapping=True,
                        )
                        
                        # Keep the verified relative subtitle position on the 2K canvas.
                        clip_settings = ClipSettings(transform_y=-0.465625)
                        style_reference = TextSegment(
                            "字幕样式",
                            Timerange(0, 500000),
                            style=text_style,
                            clip_settings=clip_settings,
                            border=TextBorder(alpha=1.0, color=(0.0, 0.0, 0.0), width=20.0),
                        )
                        
                        # 导入字幕
                        script.import_srt(
                            str(srt_path), 
                            "字幕轨道",
                            style_reference=style_reference,
                            clip_settings=clip_settings
                        )
                        logger.info(f"[{draft_name}] Successfully imported subtitle to timeline with style")
                    else:
                        logger.info(f"[{draft_name}] No import_srt method available")
                except Exception as e:
                    logger.info(f"[{draft_name}] Failed to import subtitle: {e}")
        else:
            # 从模板复制的草稿，尝试替换素材
            logger.info(f"[{draft_name}] Replacing materials in template...")
            
            # 1) 替换主音频
            logger.info(f"[{draft_name}] Replacing main audio...")
            voice_new = draft.AudioMaterial(str(a))
            replaced = False
            for placeholder in audio_placeholders:
                if replace_material(script, placeholder, voice_new, "audio"):
                    logger.info(f"[{draft_name}] Successfully replaced main audio using placeholder: {placeholder}")
                    replaced = True
                    break
            if not replaced:
                logger.info(f"[{draft_name}] Warning: Failed to replace main audio - no matching placeholder found")

            # 2) 替换 BGM
            if bgm_path is not None:
                logger.info(f"[{draft_name}] Replacing BGM...")
                bgm_new = draft.AudioMaterial(str(bgm_path))
                replaced = False
                for placeholder in bgm_placeholders:
                    if replace_material(script, placeholder, bgm_new, "BGM"):
                        logger.info(f"[{draft_name}] Successfully replaced BGM using placeholder: {placeholder}")
                        replaced = True
                        break
                if not replaced:
                    logger.info(f"[{draft_name}] Warning: Failed to replace BGM - no matching placeholder found")

            # 3) 替换图片
            logger.info(f"[{draft_name}] Replacing images...")
            image_replaced_count = 0
            
            # 尝试获取模板中的所有图片素材，以便更精确地替换
            template_images = []
            try:
                if hasattr(script, 'list_materials'):
                    materials = script.list_materials()
                    template_images = [m for m in materials if any(ext in m.lower() for ext in ['.jpg', '.jpeg', '.png', '.webp', '.bmp'])]
                    logger.info(f"[{draft_name}] Found {len(template_images)} image materials in template")
                    for img in template_images:
                        logger.info(f"  - {img}")
            except Exception as e:
                logger.info(f"[{draft_name}] Failed to list template images: {e}")
            
            # 策略1：如果有模板图片列表，按顺序替换
            if template_images:
                logger.info(f"[{draft_name}] Using template image list for replacement")
                for idx, (template_img, new_img) in enumerate(zip(template_images, images), start=1):
                    img_material = draft.VideoMaterial(str(new_img))
                    if replace_material(script, template_img, img_material, f"image {idx}"):
                        logger.info(f"[{draft_name}] Successfully replaced image {idx} using template name: {template_img}")
                        image_replaced_count += 1
                    else:
                        logger.info(f"[{draft_name}] Warning: Failed to replace image {idx} using template name: {template_img}")
            else:
                # 策略2：尝试使用不同的占位符格式
                logger.info(f"[{draft_name}] Using placeholder strategy for image replacement")
                for idx, img in enumerate(images, start=1):
                    replaced = False
                    img_material = draft.VideoMaterial(str(img))
                    
                    # 尝试使用数字部分进行匹配
                    img_num = str(idx)
                    img_num_2digits = f"{idx:02d}"
                    
                    # 构建更多可能的占位符
                    custom_placeholders = []
                    for num in [img_num, img_num_2digits]:
                        for ext in ['.jpg', '.jpeg', '.png', '.webp', '.bmp']:
                            custom_placeholders.extend([num + ext, 'img' + num + ext, 'image' + num + ext])
                    
                    # 先尝试自定义占位符
                    for placeholder in custom_placeholders:
                        if replace_material(script, placeholder, img_material, f"image {idx}"):
                            logger.info(f"[{draft_name}] Successfully replaced image {idx} using custom placeholder: {placeholder}")
                            replaced = True
                            image_replaced_count += 1
                            break
                    
                    # 如果自定义占位符失败，尝试通用占位符
                    if not replaced:
                        for placeholder in image_placeholders:
                            if replace_material(script, placeholder, img_material, f"image {idx}"):
                                logger.info(f"[{draft_name}] Successfully replaced image {idx} using generic placeholder: {placeholder}")
                                replaced = True
                                image_replaced_count += 1
                                break
                    
                    if not replaced:
                        logger.info(f"[{draft_name}] Warning: Failed to replace image {idx} - no matching placeholder found")
            
            logger.info(f"[{draft_name}] Replaced {image_replaced_count} out of {len(images)} images")

            # 4) 替换字幕
            if srt_path and srt_path.exists() and hasattr(draft, "SubtitleMaterial"):
                logger.info(f"[{draft_name}] Replacing subtitle...")
                srt_new = draft.SubtitleMaterial(str(srt_path))
                replaced = False
                for placeholder in subtitle_placeholders:
                    if replace_material(script, placeholder, srt_new, "subtitle"):
                        logger.info(f"[{draft_name}] Successfully replaced subtitle using placeholder: {placeholder}")
                        replaced = True
                        break
                if not replaced:
                    logger.info(f"[{draft_name}] Warning: Failed to replace subtitle - no matching placeholder found")

        # 保存草稿
        # 验证时间范围，检查音频和视频片段是否连续
        logger.info(f"[{draft_name}] Verifying time ranges for continuity...")
        try:
            # 检查轨道和片段信息
            logger.info(f"  script.tracks: {type(script.tracks)}, {len(script.tracks)} tracks")

            # 检查是否是新创建的草稿模式（is_new_draft）
            if is_new_draft:
                logger.info(f"  New draft mode: materials are being added directly to script.tracks")

            for track_name, track in script.tracks.items():
                logger.info(f"  Track: {track_name} ({len(track.segments)} segments)")
                if len(track.segments) > 0:
                    track_segments = sorted(track.segments, key=lambda x: x.start)
                    for i, seg in enumerate(track_segments):
                        start_time = seg.start
                        duration = seg.duration
                        end_time = seg.end
                        logger.info(f"    [{i}] Start: {start_time} us, Duration: {duration} us, End: {end_time} us")

                        if i > 0:
                            prev_tr = track_segments[i-1]
                            gap = start_time - prev_tr.end
                            if gap > 0:
                                logger.info(f"    WARNING: GAP of {gap} us between segment {i-1} and {i}")
                            elif gap < 0:
                                logger.info(f"    WARNING: OVERLAP of {-gap} us between segment {i-1} and {i}")
                            else:
                                logger.info(f"    Segment {i} starts exactly at end of segment {i-1}")

            logger.info(f"[{draft_name}] Time range verification completed")
        except Exception as e:
            import traceback
            logger.info(f"[{draft_name}] Time range verification failed: {e}")
            logger.info(f"[{draft_name}] Detailed error: {traceback.format_exc()}")

        try:
            script.save()
            logger.info(f"[{draft_name}] Saved draft successfully")
        except Exception as e:
            logger.info(f"[{draft_name}] Failed to save draft: {e}")
            # 尝试手动保存
            try:
                draft_path = drafts_dir / draft_name
                if not draft_path.exists():
                    draft_path.mkdir(parents=True, exist_ok=True)
                script.dump(str(draft_path / "draft_content.json"))
                logger.info(f"[{draft_name}] Manually saved draft to: {draft_path}")
            except Exception as e2:
                logger.info(f"[{draft_name}] Failed to manually save draft: {e2}")

        # 创建剪映所需的附属文件夹和文件
        draft_path = drafts_dir / draft_name
        if draft_path.exists():
            for subdir in [".backup", "Resources", "subdraft"]:
                (draft_path / subdir).mkdir(exist_ok=True)
            for fname in ["draft_settings", "draft_virtual_store.json", "template_params"]:
                fpath = draft_path / fname
                if not fpath.exists():
                    fpath.touch()

        logger.info(f"[{draft_name}] Generated successfully")


def generate_draft(
    drafts_dir: str,
    materials_dir: str,
    name_prefix: str = "",
    template_dir: str = None,
    seq: str = None,
    project: str = None,
) -> dict:
    """
    生成剪映草稿（供 DraftGenerator 直接调用）。

    参数:
        drafts_dir: 剪映草稿输出目录
        materials_dir: 素材根目录（包含 01_audio/02_media/04_bgm/03_subtitle）
        name_prefix: 草稿命名前缀
        template_dir: 模板草稿目录（默认与 drafts_dir 相同）
        seq: 只处理指定序列号（可选）
        project: 视频禁用清单所属项目；省略时从素材目录祖先定位

    返回:
        {"success": True/False, "drafts_created": N, "error": "..."}
    """
    import argparse
    args = argparse.Namespace(
        drafts=drafts_dir,
        materials=materials_dir,
        project=project,
        name_prefix=name_prefix,
        template_dir=template_dir,
        template=None,
        seq=seq,
        overwrite=True,
        new_template=None,
    )
    try:
        main_with_args(args)
        return {"success": True}
    except DraftInputError as e:
        return {"success": False, "error": str(e)}
    except Exception as e:
        logger.error(f"草稿生成失败: {e}")
        return {"success": False, "error": str(e)}
