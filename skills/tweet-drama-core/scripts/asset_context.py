"""Project-level asset context cache and lightweight matching."""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from asset_image_import import CATEGORY_PROMPT_FILES, VALID_CATEGORIES


CONTEXT_FILENAME = "asset_context.json"
CONTEXT_VERSION = 4

PHASE_ALIASES = {
    "early": {"前期", "早期", "青年", "青年期", "少年", "幼年", "年轻"},
    "middle": {"中期", "中段", "中年", "中年期", "成年", "成年期"},
    "late": {"后期", "后段", "后期", "老年", "老年期", "晚年", "成功期"},
}

PHASE_LABELS = {
    "early": "前期",
    "middle": "中期",
    "late": "后期",
}

WEAK_ALIASES = {
    "我", "你", "他", "她", "它", "自己", "本人",
    "爸", "爸爸", "爹", "妈", "妈妈", "娘",
    "老公", "老婆", "丈夫", "妻子", "儿子", "女儿",
}

BLOCKED_GENERIC_ALIASES = {
    "男人", "女人", "孩子", "小孩", "老人", "老太太", "老头",
    "老板", "总裁", "董事长", "经理", "医生", "护士", "警察",
    "路人", "群众", "同事", "员工", "服务员", "司机", "保安",
}

ASSET_ONLY_PROMPT_PATTERNS = (
    r"单张角色设定图[，,、；; ]*",
    r"(左|右)侧?[^，。；;]*三视图[，,、；; ]*",
    r"三视图[，,、；; ]*",
    r"纯白(?:无缝)?背景[，,、；; ]*",
    r"白底[，,、；; ]*",
)

TEXT_PROP_KEYWORDS = (
    "欠条", "协议", "合同", "证件", "证书", "文件", "材料", "照片", "招牌",
    "标识", "贴纸", "报纸", "信", "书", "票据", "账单", "说明", "文字",
)


def normalize_hint(hint: Any) -> dict[str, Any]:
    if hint is None:
        return {}
    if isinstance(hint, str):
        return {"label": hint.strip()}
    if isinstance(hint, dict):
        return {str(k): v for k, v in hint.items() if v not in (None, "")}
    return {"label": str(hint).strip()}


# Phase 2.2: 内存缓存 — key=project_dir, value=(mtime, context_dict)
_context_mem_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def load_or_build_asset_context(project_dir: str, *, refresh: bool = False) -> dict[str, Any]:
    assets_dir = Path(project_dir, "assets")
    context_path = assets_dir / CONTEXT_FILENAME

    # Phase 2.2: 内存缓存命中检查 — mtime 变化自动失效
    if not refresh:
        try:
            mtime = context_path.stat().st_mtime
            cached = _context_mem_cache.get(project_dir)
            if cached is not None and cached[0] == mtime:
                return cached[1]
        except OSError:
            pass

    if not refresh:
        try:
            data = json.loads(context_path.read_text(encoding="utf-8"))
            if (
                isinstance(data, dict)
                and "assets" in data
                and int(data.get("version", 0) or 0) >= CONTEXT_VERSION
            ):
                try:
                    _context_mem_cache[project_dir] = (context_path.stat().st_mtime, data)
                except OSError:
                    pass
                return data
        except (OSError, json.JSONDecodeError):
            pass
    context = build_asset_context(project_dir)
    save_asset_context(project_dir, context)
    try:
        _context_mem_cache[project_dir] = (context_path.stat().st_mtime, context)
    except OSError:
        pass
    return context


def build_asset_context(project_dir: str) -> dict[str, Any]:
    assets: dict[str, list[dict[str, Any]]] = {
        category: [] for category in sorted(VALID_CATEGORIES)
    }
    assets_dir = Path(project_dir, "assets")
    for category, filename in CATEGORY_PROMPT_FILES.items():
        prompt_path = assets_dir / filename
        if not prompt_path.is_file():
            continue
        for record in _parse_prompt_records(prompt_path.read_text(encoding="utf-8")):
            assets[category].append(standardize_asset_record(record, category))
    _infer_missing_episode_scopes(project_dir, assets)
    return {"version": CONTEXT_VERSION, "assets": assets}


def _infer_missing_episode_scopes(project_dir: str, assets: dict[str, list[dict[str, Any]]]) -> None:
    """Migrate legacy rows with blank episode columns without broad global matching."""
    episodes_dir = Path(project_dir, "episodes")
    if not episodes_dir.is_dir():
        return
    scripts: dict[str, str] = {}
    for path in episodes_dir.glob("*.txt"):
        match = re.search(r"(\d+)", path.stem)
        if not match:
            continue
        try:
            scripts[f"{int(match.group(1)):02d}"] = path.read_text(encoding="utf-8")
        except OSError:
            continue
    if not scripts:
        return
    for category, records in assets.items():
        for record in records:
            if record.get("episodes"):
                continue
            tokens = [record.get("name", "")]
            tokens.extend(record.get("strong_aliases", []) or [])
            tokens = [str(token).strip() for token in tokens if str(token).strip()]
            matched = [ep for ep, script in scripts.items() if any(token in script for token in tokens)]
            if matched:
                record["episodes"] = sorted(set(matched), key=lambda value: int(value))
                record["episode_scope_inferred"] = True


def save_asset_context(project_dir: str, context: dict[str, Any]) -> None:
    assets_dir = Path(project_dir, "assets")
    assets_dir.mkdir(parents=True, exist_ok=True)
    _write_json_atomic(assets_dir / CONTEXT_FILENAME, context)


def update_asset_context_record(
    project_dir: str,
    category: str,
    *,
    name: str,
    aliases: str = "",
    episodes: str = "",
    prompt: str = "",
    allows_text: bool | None = None,
) -> None:
    context = load_or_build_asset_context(project_dir)
    category_records = context.setdefault("assets", {}).setdefault(category, [])
    record = standardize_asset_record({
        "name": name,
        "aliases": _split_aliases(aliases),
        "episodes": _split_episodes(episodes),
        "prompt": prompt,
        "allows_text": (
            infer_allows_text(category, name, aliases, prompt)
            if allows_text is None else bool(allows_text)
        ),
    }, category)
    replaced = False
    for index, existing in enumerate(category_records):
        if existing.get("name") == name:
            category_records[index] = record
            replaced = True
            break
    if not replaced:
        category_records.append(record)
    save_asset_context(project_dir, context)


def infer_phase(name: str, aliases: Any = "", prompt: str = "") -> str:
    text = " ".join([str(name or ""), _join_aliases(aliases), str(prompt or "")])
    for canonical, words in PHASE_ALIASES.items():
        if any(word in text for word in words):
            return canonical
    return ""


def normalize_phase(phase: str) -> str:
    text = str(phase or "").strip()
    if not text:
        return ""
    for canonical, words in PHASE_ALIASES.items():
        if text == canonical or text in words or any(word in text for word in words):
            return canonical
    return _norm(text)


def standardize_asset_record(record: dict[str, Any], category: str = "") -> dict[str, Any]:
    """Normalize legacy txt rows into the internal asset record schema."""
    name = str(record.get("name", "")).strip()
    aliases = _split_aliases(record.get("aliases", []))
    episodes = _split_episodes(record.get("episodes", []))
    prompt = str(record.get("prompt") or record.get("asset_prompt") or "").strip()
    category = str(record.get("category") or category or "").strip()
    phase = normalize_phase(str(record.get("phase") or ""))
    strong_aliases, weak_aliases, blocked_aliases = split_alias_strength(aliases)
    allows_text = (
        bool(record.get("allows_text"))
        if "allows_text" in record
        else infer_allows_text(category, name, aliases, prompt)
    )

    standardized = dict(record)
    standardized.update({
        "name": name,
        "phase": phase,
        "phase_label": PHASE_LABELS.get(phase, phase),
        "aliases": aliases,
        "strong_aliases": strong_aliases,
        "weak_aliases": weak_aliases,
        "blocked_aliases": blocked_aliases,
        "episodes": episodes,
        "asset_prompt": prompt,
        "prompt": prompt,
        "visual_prompt": str(record.get("visual_prompt") or record.get("storyboard_desc") or clean_visual_prompt(prompt)).strip(),
        "category": category,
        "allows_text": allows_text,
        "needs_phase_split": needs_phase_split(name, prompt),
    })
    return standardized


def split_alias_strength(aliases: Any) -> tuple[list[str], list[str], list[str]]:
    strong: list[str] = []
    weak: list[str] = []
    blocked: list[str] = []
    for alias in _split_aliases(aliases):
        if alias in WEAK_ALIASES:
            weak.append(alias)
        elif alias in BLOCKED_GENERIC_ALIASES:
            blocked.append(alias)
        else:
            strong.append(alias)
    return strong, weak, blocked


def infer_allows_text(category: str, name: str, aliases: Any = "", prompt: str = "") -> bool:
    if category != "prop":
        return False
    text = " ".join([str(name or ""), _join_aliases(aliases), str(prompt or "")])
    if re.search(r"(无文字|没有文字|禁止文字|禁止任何文字|不得出现文字)", text):
        return False
    if re.search(r"(允许文字|可见文字|需要文字|包含文字|带文字)", text):
        return True
    return any(keyword in text for keyword in TEXT_PROP_KEYWORDS)


def needs_phase_split(name: str, prompt: str) -> bool:
    if re.search(r"[_\-—－]?(前期|中期|后期|青年期|中年期|老年期|幼年期|成年期)$", str(name or "")):
        return False
    found = {
        canonical
        for canonical, words in PHASE_ALIASES.items()
        if any(word in str(prompt or "") for word in words)
    }
    return len(found) >= 2


def clean_visual_prompt(prompt: str) -> str:
    desc = str(prompt or "")
    for pattern in ASSET_ONLY_PROMPT_PATTERNS:
        desc = re.sub(pattern, "", desc)
    desc = re.sub(r"画面中?禁止任何文字[^。；;]*[。；;]?", "", desc)
    desc = re.sub(
        r"禁止(?:任何)?(?:文字|数字|年龄标签|箭头|说明线|字幕|Logo|水印|边框|UI元素)[^。；;]*[。；;]?",
        "",
        desc,
    )
    desc = re.sub(r"[，,、；; ]{2,}", "，", desc)
    return desc.strip(" ，,、；;")


def _parse_prompt_records(text: str) -> list[dict[str, Any]]:
    records = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "|" not in line:
            continue
        parts = line.split("|")
        if len(parts) >= 4:
            name, aliases, episodes = parts[0].strip(), parts[1].strip(), parts[2].strip()
            prompt = "|".join(parts[3:]).strip()
        elif len(parts) == 3:
            name, aliases, episodes, prompt = parts[0].strip(), parts[1].strip(), "", parts[2].strip()
        else:
            name, aliases, episodes, prompt = parts[0].strip(), "", "", parts[1].strip()
        if name:
            records.append({
                "name": name,
                "aliases": _split_aliases(aliases),
                "episodes": _split_episodes(episodes),
                "prompt": prompt,
            })
    return records


def _split_aliases(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    return [
        item.strip()
        for item in re.split(r"[,，、;；]+", str(value or ""))
        if item.strip()
    ]


def _split_episodes(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    return [
        item.strip()
        for item in re.split(r"[,，、;；\s]+", str(value or ""))
        if item.strip()
    ]


def _join_aliases(value: Any) -> str:
    return " ".join(_split_aliases(value))


def _base_name(name: str) -> str:
    return re.sub(r"[_\-—－]?(前期|中期|后期|青年期|中年期|老年期|幼年期|成年期)$", "", name)


def _norm(value: str) -> str:
    return re.sub(r"[\s_\\-—－·]+", "", str(value or "").lower())


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)
