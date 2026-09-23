"""Place one episode's script lines onto their real positions in each shot.

The shot script already states every word, so only the timing is missing. A local
speech model transcribes each shot with word-level times, and the script's own
text is matched against those times: the model contributes timestamps only, so a
misheard word can never reach a subtitle, and a line the model did not match is
reported rather than silently given a guessed time.

Every shot carries the strategy it was placed with, and `drama_render subtitles`
refuses any shot whose strategy is not `asr_aligned`; the alignment's honesty
label is therefore enforced by the tool instead of by a reader's attention.

The audio is loudness-normalised before transcription, because a quiet shot makes
the model's own no-speech filter discard real dialogue. Everything runs locally
on the CPU; nothing is uploaded and nothing is charged. The model itself comes
from an explicit directory or a pinned archive — the script never reaches for a
model registry on its own.

    python -B align_subtitles.py --project <项目根> --episode 4 \\
        [--shots _probe/ep04-render-shots.json] [--lines _probe/ep04-lines.json] \\
        [--out _probe/ep04-aligned.json] [--model-dir <本地模型目录>] \\
        [--model-url <模型包 URL>] [--model-sha256 <64 位十六进制>] [--strict]
"""

import argparse
import difflib
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from paths import get_ffmpeg_path, get_models_dir  # noqa: E402  (needs the path above)

SAMPLE_RATE = 16000
PUNCT = "，。！？；：、,.!?;:\"'“”‘’（）()《》【】…—-·"
MIN_CUE_SECONDS = 0.80
MAX_CUE_SECONDS = 9.0
SECONDS_PER_CHARACTER = 1 / 6
SECONDS_PER_CHARACTER_PAD = 0.5
WINDOW_FACTOR = 3
WINDOW_PAD = 20
SEARCH_STEP_FACTOR = 2
SHORT_LINE_CHARS = 3
MEDIUM_LINE_CHARS = 5
SHORT_LINE_SCORE = 0.34
MEDIUM_LINE_SCORE = 0.40
LONG_LINE_SCORE = 0.55
MODEL_FILES = ("config.json", "model.bin", "tokenizer.json", "vocabulary.txt")
ALL_ALIGNED = "asr_aligned"


try:
    from zhconv import convert as _zh_convert
except Exception:  # pragma: no cover - folding is best effort
    _zh_convert = None


def to_simplified(text: str) -> str:
    """Fold traditional characters onto the script's own variant.

    The pinned recognizer intermittently emits traditional characters for syllables it
    otherwise writes simplified. A character-level comparison then scores a correctly
    heard line near zero and refuses to anchor it, which reads as "the take is different"
    when only the character variant differs. Folding both sides before scoring removes
    that false negative; every acceptance threshold stays exactly where it was.
    """
    if _zh_convert is None or not text:
        return text
    return _zh_convert(text, "zh-cn")


def normalise(text: str) -> str:
    """Drop punctuation and whitespace so recognized and script text can be compared."""
    for char in PUNCT:
        text = text.replace(char, "")
    return to_simplified(re.sub(r"\s+", "", text))


def required_seconds(text: str) -> float:
    """How long this line plausibly takes at the measured delivery rate."""
    spoken = len(normalise(text))
    return min(MAX_CUE_SECONDS, max(MIN_CUE_SECONDS, spoken * SECONDS_PER_CHARACTER + SECONDS_PER_CHARACTER_PAD))


def acceptance_score(line: str) -> float:
    """The match score a line must reach before its span is trusted."""
    length = len(normalise(line))
    if length <= SHORT_LINE_CHARS:
        return SHORT_LINE_SCORE
    if length <= MEDIUM_LINE_CHARS:
        return MEDIUM_LINE_SCORE
    return LONG_LINE_SCORE


def decode(video: Path, target: Path) -> None:
    """Write the shot's audio as mono 16 kHz PCM, loudness-normalised for the model."""
    subprocess.run(
        [get_ffmpeg_path(), "-hide_banner", "-loglevel", "error", "-y", "-i", str(video),
         "-vn", "-af", "loudnorm=I=-18:LRA=11:TP=-1.5",
         "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "wav", str(target)],
        check=True,
    )


def probe_seconds(video: Path) -> float:
    """Read the shot's own duration, which bounds every cue placed inside it."""
    done = subprocess.run(
        [get_ffmpeg_path(), "-hide_banner", "-i", str(video), "-f", "null", "-"],
        capture_output=True, text=True, encoding="utf-8", errors="replace", check=False,
    )
    matches = re.findall(r"Duration: (\d+):(\d+):(\d+\.\d+)", done.stderr or "")
    if not matches:
        raise SystemExit(f"无法读出时长：{video}")
    hours, minutes, seconds = matches[0]
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def transcribe(video: Path, work: Path, model) -> list:
    """Return (char, start, end) for every recognized character of one shot.

    Decoding is pinned to one thread and one temperature. Multi-threaded int8
    beam search is not reproducible: two runs over the same shot returned 34 and
    30 characters, which is enough to make one line anchor on one run and not on
    the next. Temperature fallback is off for the same reason.
    """
    wav = work / f"{video.stem}.asr.wav"
    decode(video, wav)
    segments, _ = model.transcribe(str(wav), language="zh", word_timestamps=True, beam_size=5,
                                   vad_filter=False, no_speech_threshold=0.95,
                                   temperature=0.0, condition_on_previous_text=False)
    chars: list = []
    for segment in segments:
        for word in segment.words or []:
            piece = normalise(word.word)
            if not piece:
                continue
            span = (word.end - word.start) / len(piece)
            for offset, char in enumerate(piece):
                chars.append((char, word.start + offset * span, word.start + (offset + 1) * span))
    return chars


def align(line: str, chars: list, floor_index: int) -> tuple:
    """Find the span best matching one line, searching forward from a floor.

    The candidate window is scored with difflib, whose match blocks carry an index
    into each side: `a` indexes the line and `b` indexes the recognized characters.
    Reading the character span from `a` shifts every line earlier by however many
    characters the window opened with, so the span is read from `b`.

    Returns (start, end, score, end_index); end_index is where the next line may
    begin, so lines can never be matched out of order.
    """
    target = normalise(line)
    if not target or floor_index >= len(chars):
        return 0.0, 0.0, 0.0, floor_index
    haystack = "".join(char for char, _, _ in chars)
    window = len(target) * WINDOW_FACTOR + WINDOW_PAD
    best = (0.0, 0.0, 0.0, floor_index)
    start = floor_index
    while start < len(haystack):
        candidate = haystack[start:min(len(haystack), start + window)]
        matcher = difflib.SequenceMatcher(None, target, candidate, autojunk=False)
        blocks = [block for block in matcher.get_matching_blocks() if block.size > 0]
        score = sum(block.size for block in blocks) / len(target)
        if score > best[2]:
            first, last = blocks[0], blocks[-1]
            first_index = min(len(chars) - 1, start + first.b)
            last_index = min(len(chars) - 1, start + last.b + last.size - 1)
            if last_index >= first_index:
                best = (chars[first_index][1], chars[last_index][2], score, last_index + 1)
        start += max(1, len(target) // SEARCH_STEP_FACTOR)
    return best


def anchor(lines: list, chars: list) -> list:
    """Match every line forward in order, keeping only the spans that earn their score."""
    anchors: list = [None] * len(lines)
    cursor = 0
    for index, line in enumerate(lines):
        start, end, score, cursor_next = align(line, chars, cursor)
        if end > start and score >= acceptance_score(line):
            anchors[index] = (round(start, 3), round(end, 3))
            cursor = max(cursor, cursor_next)
    return anchors


def place(lines: list, anchors: list, shot_end: float) -> tuple:
    """Assign every line a cue: matched spans first, then the gap they leave behind.

    A line the model matched keeps its measured span. A run of unmatched lines is
    laid out inside the gap between its neighbours — the previous cue's end and the
    next anchor's start — in proportion to the time each line needs, so a guess stays
    inside measured speech instead of sliding across the whole shot.
    """
    if not lines:
        return [], "no_lines"
    cues: list = [None] * len(lines)
    index = 0
    while index < len(lines):
        if anchors[index] is not None:
            cues[index] = anchors[index]
            index += 1
            continue
        run_end = index
        while run_end < len(lines) and anchors[run_end] is None:
            run_end += 1
        gap_start = max((cue[1] for cue in cues[:index] if cue), default=0.0)
        gap_end = anchors[run_end][0] if run_end < len(lines) else shot_end
        gap_end = max(gap_start, gap_end)
        needed = sum(required_seconds(lines[position]) for position in range(index, run_end))
        scale = min(1.0, (gap_end - gap_start) / needed) if needed else 1.0
        clock = gap_start
        for position in range(index, run_end):
            length = required_seconds(lines[position]) * scale
            cues[position] = (round(clock, 3), round(min(shot_end, clock + length), 3))
            clock += length
        index = run_end

    found = sum(1 for item in anchors if item is not None)
    strategy = ALL_ALIGNED if found == len(lines) else ("anchored" if found else "estimated_total")
    return settle(cues, shot_end), strategy


def monotonic(cues: list, shot_end: float, min_seconds: float) -> list:
    """Order the cues so each starts after the previous one ends and none leaves the shot.

    `end` is derived from the clamped `start`, not from the original one: measuring the
    minimum length from an unclamped start produced inverted spans. The cursor itself
    stays inside the shot, so a cue is never pushed backwards into its predecessor.
    """
    out = []
    clock = 0.0
    for cue in cues:
        if cue is None:
            out.append(None)
            continue
        clock = min(clock, shot_end)
        start = max(cue[0], clock)
        end = min(max(cue[1], start + min_seconds), shot_end)
        if end < start:
            start = end
        out.append((round(start, 3), round(end, 3)))
        clock = end
    return out


def settle(cues: list, shot_end: float) -> list:
    """Order the cues, then compress the whole shot if its intended span overruns.

    The overrun must be measured before clamping: once every cue is clamped to the
    shot boundary the maximum end equals the boundary, so a "did it fit" test on the
    clamped values always passes and the tail collapses into zero-length cues.
    Compression drops the minimum-length target, since that target is what could not fit.
    """
    raw = [cue[1] for cue in cues if cue]
    if raw and max(raw) > shot_end:
        scale = shot_end / max(raw)
        result = monotonic([(round(cue[0] * scale, 3), round(cue[1] * scale, 3)) if cue else None
                            for cue in cues], shot_end, 0.0)
    else:
        result = monotonic(cues, shot_end, MIN_CUE_SECONDS)

    present = [index for index, cue in enumerate(cues) if cue]
    valid = [cue for cue in result if cue]
    if not present or (valid and all(cue[1] > cue[0] for cue in valid)):
        return result

    # Last resort that cannot drop a line: lay every cue across the shot in proportion
    # to the time it asked for, so a crowded shot yields short cues rather than no
    # subtitles at all.
    first = min(cues[index][0] for index in present)
    span = max(0.1, shot_end - first)
    weights = [max(0.5, cues[index][1] - cues[index][0]) for index in present]
    total = sum(weights)
    clock = first
    fixed = list(result)
    for position, (index, weight) in enumerate(zip(present, weights)):
        length = span * weight / total
        if position == len(present) - 1:
            length = max(0.05, shot_end - clock)
        fixed[index] = (round(clock, 3), round(clock + length, 3))
        clock += length
    return fixed


def sha256_of(path: Path) -> str:
    """Hash one file without loading it into memory."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def fetch_model(url: str, expected: str, cache_root: Path) -> Path:
    """Download a pinned model archive, verify its digest, and unpack it once.

    The archive is expected to hold the four files a CTranslate2 Whisper model
    needs at its root. A cached copy that already carries them is reused, and a
    digest mismatch removes the download instead of leaving a half-trusted model
    in place.
    """
    if not expected:
        raise SystemExit("下载模型必须同时给出 --model-sha256：没有摘要就无法确认下到的是哪一个模型。")
    target = cache_root / f"faster-whisper-{expected[:12]}"
    if (target / "model.bin").is_file():
        return target
    cache_root.mkdir(parents=True, exist_ok=True)
    archive = cache_root / f".{expected[:12]}.zip"
    print(f"下载模型 {url} → {archive}")
    with urllib.request.urlopen(url, timeout=120) as response, archive.open("wb") as handle:
        shutil.copyfileobj(response, handle)
    actual = sha256_of(archive)
    if actual != expected:
        archive.unlink(missing_ok=True)
        raise SystemExit(f"模型包摘要不符：期望 {expected}，实际 {actual}。已删除下载，请核对来源。")
    staging = cache_root / f".{expected[:12]}.unpack"
    if staging.exists():
        shutil.rmtree(staging)
    with zipfile.ZipFile(archive) as bundle:
        for name in bundle.namelist():
            if name.endswith("/") or "/" in name:
                continue
            if Path(name).name not in MODEL_FILES:
                raise SystemExit(f"模型包根目录里有陌生文件：{name}。请只放模型自身的文件后重新打包。")
        bundle.extractall(staging)
    root = staging
    for candidate in [staging, *(path for path in staging.iterdir() if path.is_dir())]:
        if all((candidate / name).is_file() for name in MODEL_FILES):
            root = candidate
            break
    else:
        shutil.rmtree(staging, ignore_errors=True)
        raise SystemExit(f"模型包缺少 {', '.join(MODEL_FILES)} 中的文件。")
    if target.exists():
        shutil.rmtree(target)
    shutil.move(str(root), str(target))
    shutil.rmtree(staging, ignore_errors=True)
    archive.unlink(missing_ok=True)
    return target


def resolve_model(args) -> Path:
    """Resolve explicit CLI model choices, then the bundled model environment, then the cache."""
    configured = args.model_dir or (os.environ.get('MUSE_WHISPER_MODEL_DIR', '') if not args.model_url else '')
    if configured:
        directory = Path(configured).expanduser().resolve()
        missing = [name for name in MODEL_FILES if not (directory / name).is_file()]
        if missing:
            raise SystemExit(f"模型目录缺少 {', '.join(missing)}：{directory}")
        return directory
    cache_root = Path(args.cache_dir).expanduser().resolve() if args.cache_dir else Path(get_models_dir()) / "faster-whisper"
    if args.model_url:
        return fetch_model(args.model_url, args.model_sha256, cache_root)
    cached = sorted(cache_root.glob("faster-whisper-*")) if cache_root.is_dir() else []
    for directory in cached:
        if (directory / "model.bin").is_file():
            print(f"使用缓存模型 {directory}")
            return directory
    raise SystemExit(
        "找不到语音模型。三种给法任选一种：\n"
        "  1) --model-dir 指向一个含 config.json/model.bin/tokenizer.json/vocabulary.txt 的目录；\n"
        "  2) --model-url + --model-sha256 指向固定版本的模型包（第一次下载后本地缓存复用）；\n"
        f"  3) 先把模型放进缓存目录 {cache_root}（例如 faster-whisper-small/）。\n"
        "本脚本不会自行去模型仓库拉取，以免同一集在不同机器上跑出不同的对齐。"
    )


def load_document(path: Path, key: str) -> list:
    """Read one of the two shot-indexed input documents."""
    if not path.is_file():
        raise SystemExit(f"缺少输入文件：{path}")
    document = json.loads(path.read_text(encoding="utf-8"))
    rows = document.get(key)
    if not isinstance(rows, list):
        raise SystemExit(f"{path} 里没有 {key} 数组。")
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True, help="短剧项目根目录")
    parser.add_argument("--episode", type=int, required=True, help="集号")
    parser.add_argument("--shots", help="逐镜成片清单，默认 <项目>/_probe/epNN-render-shots.json")
    parser.add_argument("--lines", help="逐镜台词计划，默认 <项目>/_probe/epNN-lines.json")
    parser.add_argument("--out", help="输出的对齐文档，默认 <项目>/_probe/epNN-aligned.json")
    parser.add_argument("--model-dir", help="本地模型目录")
    parser.add_argument("--model-url", help="模型包（zip）的下载地址")
    parser.add_argument("--model-sha256", default="", help="模型包的 SHA-256，与 --model-url 一起用")
    parser.add_argument("--cache-dir", help="模型缓存根目录")
    parser.add_argument("--strict", action="store_true", help="有任一镜未能整镜锚定时以非零退出")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    project = Path(args.project).resolve()
    probe = project / "_probe"
    stem = f"ep{args.episode}"
    shots_path = Path(args.shots) if args.shots else probe / f"{stem}-render-shots.json"
    lines_path = Path(args.lines) if args.lines else probe / f"{stem}-lines.json"
    out_path = Path(args.out) if args.out else probe / f"{stem}-aligned.json"

    manifest = load_document(shots_path, "shots")
    plan = load_document(lines_path, "shots")
    by_shot = {int(row["shot"]): list(row["lines"]) for row in plan}
    missing = [int(row["shot"]) for row in manifest if int(row["shot"]) not in by_shot]
    if missing:
        raise SystemExit(f"台词计划里没有这些镜头：{missing}。请先用同一版台词重跑计划。")

    model_dir = resolve_model(args)
    from faster_whisper import WhisperModel
    model = WhisperModel(str(model_dir), device="cpu", compute_type="int8", cpu_threads=1)
    print(f"模型 {model_dir}")

    placed, strategies = [], []
    for entry in manifest:
        shot = int(entry["shot"])
        video = (project / entry["video"]).resolve()
        if not video.is_file():
            raise SystemExit(f"缺少该镜成片：{video}")
        lines = by_shot[shot]
        with tempfile.TemporaryDirectory(prefix="align-") as work:
            chars = transcribe(video, Path(work), model)
        duration = probe_seconds(video)
        anchors = anchor(lines, chars)
        cues, strategy = place(lines, anchors, duration)
        strategies.append(strategy)
        found = sum(1 for item in anchors if item is not None)
        print(f"  镜 {shot}（{video.name}）时长 {duration:.2f}s，识别 {len(chars)} 字，"
              f"台词 {len(lines)} 条，锚定 {found} 条 → {strategy}")
        for (start, end), line in zip(cues, lines):
            print(f"    {'  ' if strategy == ALL_ALIGNED else '估'} {start:7.3f}–{end:7.3f}  {line}")
        placed.append({"shot": shot, "strategy": strategy,
                       "cues": [{"start": start, "end": end, "text": line}
                                for (start, end), line in zip(cues, lines)]})

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({"model": str(model_dir), "shots": placed},
                                   ensure_ascii=False, indent=1), encoding="utf-8")
    counts = dict(Counter(strategies))
    print(f"EP{args.episode:02d} 策略统计: {counts} -> {out_path}")
    incomplete = [row["shot"] for row in placed if row["strategy"] not in (ALL_ALIGNED, "no_lines")]
    if incomplete:
        print(f"以下镜头不是整镜锚定（{incomplete}）：drama_render subtitles 会拒绝这些镜，"
              "请核对台词与成片是否同一版，或重听该镜后重跑。")
        if args.strict:
            raise SystemExit(1)


if __name__ == "__main__":
    main()
