"""
AIGC Pipeline — 统一路径解析

在正常 Python 环境和 PyInstaller 冻结模式下都能正确解析路径。
所有模块统一通过此模块获取文件路径，不再直接使用 __file__。
"""
import os
import sys
import shutil


def get_app_dir() -> str:
    """应用根目录 — config.yaml、prompts/、workflows/ 等只读数据文件所在位置。"""
    if getattr(sys, "frozen", False):
        return sys._MEIPASS
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def get_data_dir() -> str:
    """用户数据目录 — projects/ 等可写数据所在位置（exe 旁）。"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return get_app_dir()


def get_projects_root() -> str:
    """项目目录根路径，确保目录存在。"""
    root = os.path.join(get_data_dir(), "projects")
    os.makedirs(root, exist_ok=True)
    return root


def get_config_path() -> str:
    return os.path.join(get_app_dir(), "config.yaml")


def get_workflows_dir() -> str:
    return os.path.join(get_app_dir(), "workflows")


def get_prompts_dir() -> str:
    return os.path.join(get_app_dir(), "prompts")


def get_voices_dir() -> str:
    return os.path.join(get_app_dir(), "voices")


def get_models_dir() -> str:
    """Writable model cache under DSH_HOME, never inside installed skill resources."""
    home = os.environ.get('DSH_HOME') or os.path.join(os.path.expanduser('~'), '.dsh')
    return os.path.join(os.path.abspath(os.path.expanduser(home)), 'cache', 'models')


def get_voice_library_dir() -> str:
    """User-managed voice clips and metadata."""
    path = os.path.join(get_data_dir(), "data", "voices")
    os.makedirs(path, exist_ok=True)
    return path


def get_ffmpeg_path() -> str:
    return os.getenv("DSH_FFMPEG_PATH") or os.getenv("FFMPEG_PATH") or shutil.which("ffmpeg") or "ffmpeg"


def get_ffprobe_path() -> str:
    return os.getenv("DSH_FFPROBE_PATH") or os.getenv("FFPROBE_PATH") or shutil.which("ffprobe") or "ffprobe"


def configure_ffmpeg_environment(ffmpeg_path: str = "") -> str:
    """Expose the configured or PATH-resolved FFmpeg before media imports."""
    target = ffmpeg_path.strip() or get_ffmpeg_path()
    if not os.path.isfile(target):
        return ""

    ffmpeg_dir = os.path.dirname(os.path.abspath(target))
    path_entries = os.environ.get("PATH", "").split(os.pathsep)
    if ffmpeg_dir not in path_entries:
        os.environ["PATH"] = ffmpeg_dir + os.pathsep + os.environ.get("PATH", "")
    os.environ.setdefault("FFMPEG_BINARY", target)

    probe = get_ffprobe_path()
    if os.path.isfile(probe):
        os.environ.setdefault("FFPROBE_BINARY", probe)
    return target


def get_env_path() -> str:
    """.env 文件路径（放在 exe 旁，用户可写）。"""
    return os.path.join(get_data_dir(), ".env")


def get_user_config_path() -> str:
    """用户可写的配置文件路径（放在 exe 旁，覆盖内置 config.yaml）。"""
    if getattr(sys, "frozen", False):
        return os.path.join(get_data_dir(), "user_config.yaml")
    return os.path.join(get_data_dir(), "config.yaml")
