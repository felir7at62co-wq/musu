from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from html import unescape
from pathlib import Path
from xml.etree import ElementTree as ET


TEXT_ENCODINGS = ("utf-8-sig", "utf-8", "gb18030", "gbk")
SCRIPT_DIR = Path(__file__).resolve().parent
VENDOR_DIR = SCRIPT_DIR / "vendor"
if VENDOR_DIR.exists():
    sys.path.insert(0, str(VENDOR_DIR))


def read_text_file(path: Path) -> str:
    data = path.read_bytes()
    last_error: Exception | None = None
    for enc in TEXT_ENCODINGS:
        try:
            return data.decode(enc)
        except UnicodeDecodeError as exc:
            last_error = exc
    raise RuntimeError(f"无法识别文本编码: {path}") from last_error


def read_docx(path: Path) -> str:
    parts: list[str] = []
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    with zipfile.ZipFile(path) as zf:
        xml_names = ["word/document.xml"]
        xml_names.extend(
            name for name in zf.namelist()
            if name.startswith("word/header") or name.startswith("word/footer")
        )
        for name in xml_names:
            if name not in zf.namelist():
                continue
            root = ET.fromstring(zf.read(name))
            for paragraph in root.findall(".//w:p", ns):
                texts = [node.text or "" for node in paragraph.findall(".//w:t", ns)]
                line = "".join(texts).strip()
                if line:
                    parts.append(line)
    return "\n".join(parts)


def find_soffice() -> str | None:
    candidates = [
        shutil.which("soffice"),
        shutil.which("libreoffice"),
        r"C:\Program Files\LibreOffice\program\soffice.exe",
        r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
    ]
    for item in candidates:
        if item and Path(item).exists():
            return item
    return None


def convert_doc_with_libreoffice(path: Path) -> str | None:
    soffice = find_soffice()
    if not soffice:
        return None
    with tempfile.TemporaryDirectory(prefix="tweet_drama_doc_") as temp_dir:
        temp_path = Path(temp_dir)
        subprocess.run(
            [
                soffice,
                "--headless",
                "--convert-to",
                "txt:Text",
                "--outdir",
                str(temp_path),
                str(path),
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        txt_files = list(temp_path.glob("*.txt"))
        if not txt_files:
            return None
        return read_text_file(txt_files[0])


def convert_doc_with_word_com(path: Path) -> str | None:
    try:
        import win32com.client  # type: ignore
    except Exception:
        return None

    with tempfile.TemporaryDirectory(prefix="tweet_drama_word_") as temp_dir:
        out_path = Path(temp_dir) / f"{path.stem}.txt"
        word = None
        doc = None
        try:
            word = win32com.client.DispatchEx("Word.Application")
            word.Visible = False
            doc = word.Documents.Open(str(path.resolve()), ReadOnly=True)
            doc.SaveAs(str(out_path), FileFormat=2)
            doc.Close(False)
            word.Quit()
            return read_text_file(out_path)
        except Exception:
            try:
                if doc is not None:
                    doc.Close(False)
            except Exception:
                pass
            try:
                if word is not None:
                    word.Quit()
            except Exception:
                pass
            return None


def _looks_like_script_text(text: str) -> bool:
    cjk = len(re.findall(r"[\u4e00-\u9fff]", text))
    return cjk >= 20 or any(token in text for token in ("第1集", "第01集", "镜头", "旁白", "我"))


def _extract_readable_runs(text: str) -> list[str]:
    text = text.replace("\x00", "")
    allowed = re.compile(r"[\u4e00-\u9fffA-Za-z0-9，。！？、；：：“”‘’（）《》【】\[\]\(\)\-—…,.!?;:'\"/\\+ \t\r\n]")
    cleaned = "".join(ch if allowed.match(ch) else "\n" for ch in text)
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    lines = []
    seen = set()
    for line in cleaned.splitlines():
        line = line.strip()
        if len(line) < 2:
            continue
        if not _looks_like_script_text(line) and len(line) < 8:
            continue
        if line in seen:
            continue
        seen.add(line)
        lines.append(line)
    return lines


def convert_doc_with_olefile(path: Path) -> str | None:
    """Best-effort pure Python extraction for legacy .doc.

    This is a fallback for team machines without Word/LibreOffice. It scans OLE
    streams for readable UTF-16LE/GBK text. It is not a full Word renderer, but
    usually recovers plain Chinese script body well enough for downstream LLM
    verification and correction.
    """
    try:
        import olefile  # type: ignore
    except Exception:
        return None

    try:
        ole = olefile.OleFileIO(str(path))
    except Exception:
        return None

    chunks: list[str] = []
    try:
        streams = ole.listdir(streams=True, storages=False)
        priority_names = {"WordDocument", "1Table", "0Table", "Data"}
        streams = sorted(streams, key=lambda item: 0 if item[-1] in priority_names else 1)
        for stream in streams:
            try:
                data = ole.openstream(stream).read()
            except Exception:
                continue
            for enc in ("utf-16le", "gb18030", "latin1"):
                try:
                    decoded = data.decode(enc, errors="ignore")
                except Exception:
                    continue
                lines = _extract_readable_runs(decoded)
                if lines:
                    chunks.extend(lines)
    finally:
        ole.close()

    if not chunks:
        return None

    # Keep order while removing duplicate noise.
    unique: list[str] = []
    seen = set()
    for line in chunks:
        if line in seen:
            continue
        seen.add(line)
        unique.append(line)

    text = "\n".join(unique)
    return text if _looks_like_script_text(text) else None


def read_doc(path: Path) -> str:
    text = convert_doc_with_olefile(path)
    if text:
        return text
    text = convert_doc_with_word_com(path)
    if text:
        return text
    text = convert_doc_with_libreoffice(path)
    if text:
        return text
    raise RuntimeError(
        ".doc 是旧 Word 二进制格式；当前电脑没有可用的 Word COM 或 LibreOffice。"
        "请安装 Word/LibreOffice，或让用户另存为 .docx/.txt 后重试。"
    )


def normalize_text(text: str) -> str:
    text = unescape(text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("\ufeff", "")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{4,}", "\n\n\n", text)
    lines = [line.strip() for line in text.splitlines()]
    episode_re = re.compile(r"^第\s*[0-9一二三四五六七八九十百]+\s*集")
    first_episode = next((i for i, line in enumerate(lines) if episode_re.search(line)), None)
    if first_episode is not None and first_episode > 0:
        # Keep a likely title immediately before the first episode, drop binary
        # extraction noise that often appears at the beginning of legacy .doc.
        title_index = first_episode - 1
        title = lines[title_index]
        if len(title) > 1 and len(title) <= 40 and re.search(r"[\u4e00-\u9fff]", title):
            lines = lines[title_index:]
        else:
            lines = lines[first_episode:]
        text = "\n".join(lines)
    return text.strip() + "\n"


def convert(input_path: Path) -> str:
    suffix = input_path.suffix.lower()
    if suffix in {".txt", ".md"}:
        return read_text_file(input_path)
    if suffix == ".docx":
        return read_docx(input_path)
    if suffix == ".doc":
        return read_doc(input_path)
    raise RuntimeError(f"不支持的剧本格式: {suffix}")


def main() -> int:
    parser = argparse.ArgumentParser(description="归档并转换推文短剧剧本文档为 source_script.txt")
    parser.add_argument("--input", required=True, help="原始剧本文件路径")
    parser.add_argument("--project", required=True, help="项目目录")
    parser.add_argument("--output", help="输出 source_script.txt 路径；默认 <project>/source/source_script.txt")
    args = parser.parse_args()

    input_path = Path(args.input).expanduser().resolve()
    project_path = Path(args.project).expanduser().resolve()
    if not input_path.exists():
        raise FileNotFoundError(f"剧本不存在: {input_path}")

    source_dir = project_path / "source"
    original_dir = source_dir / "original"
    original_dir.mkdir(parents=True, exist_ok=True)
    archived_path = original_dir / input_path.name
    if input_path.resolve() != archived_path.resolve():
        shutil.copy2(input_path, archived_path)

    output_path = Path(args.output).expanduser().resolve() if args.output else source_dir / "source_script.txt"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    text = normalize_text(convert(archived_path))
    if len(text.strip()) < 20:
        raise RuntimeError(f"转换结果过短，疑似读取失败: {archived_path}")
    output_path.write_text(text, encoding="utf-8")

    print(f"[OK] archived={archived_path}")
    print(f"[OK] output={output_path}")
    print(f"[OK] chars={len(text)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
