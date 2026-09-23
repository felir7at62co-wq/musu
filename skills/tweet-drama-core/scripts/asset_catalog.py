"""CRUD operations for prompt-backed project assets."""
from __future__ import annotations

import json
import os
from pathlib import Path

from asset_image_import import (
    CATEGORY_PROMPT_FILES,
    VALID_CATEGORIES,
    VALID_EXTENSIONS,
    sync_merged_asset_descriptions,
    validate_asset_name,
)


def add_asset(
    project_dir: str,
    category: str,
    *,
    name: str,
    aliases: str = "",
    episodes: str = "",
    prompt: str,
) -> dict:
    _validate_category(category)
    name = validate_asset_name(name)
    prompt = _clean_prompt(prompt)
    path = _prompt_path(project_dir, category)
    lines = _read_lines(path)
    if _find_record_index(lines, name) is not None:
        raise ValueError(f"资产名称已存在: {name}")
    lines.append(_format_record(name, aliases, episodes, prompt))
    _write_prompt_lines(path, lines)
    sync_merged_asset_descriptions(project_dir)
    return _record(name, aliases, episodes, prompt)


def update_asset(
    project_dir: str,
    category: str,
    *,
    original_name: str,
    name: str,
    aliases: str = "",
    episodes: str = "",
    prompt: str,
) -> dict:
    _validate_category(category)
    original_name = original_name.strip()
    name = validate_asset_name(name)
    prompt = _clean_prompt(prompt)
    path = _prompt_path(project_dir, category)
    lines = _read_lines(path)
    index = _find_record_index(lines, original_name)
    if index is None:
        raise ValueError(f"未找到资产: {original_name}")
    duplicate = _find_record_index(lines, name)
    if name != original_name and duplicate is not None:
        raise ValueError(f"资产名称已存在: {name}")

    renamed_images = []
    if name != original_name:
        renamed_images = _rename_asset_images(
            project_dir, category, original_name, name
        )
    try:
        lines[index] = _format_record(name, aliases, episodes, prompt)
        _write_prompt_lines(path, lines)
        _rename_state_keys(
            project_dir, category, original_name, name, aliases, prompt
        )
        sync_merged_asset_descriptions(project_dir)
    except Exception:
        for source, target in reversed(renamed_images):
            if target.exists() and not source.exists():
                os.replace(target, source)
        raise
    return _record(name, aliases, episodes, prompt)


def delete_asset(project_dir: str, category: str, name: str) -> None:
    _validate_category(category)
    path = _prompt_path(project_dir, category)
    lines = _read_lines(path)
    index = _find_record_index(lines, name)
    if index is None:
        raise ValueError(f"未找到资产: {name}")
    del lines[index]
    _write_prompt_lines(path, lines)

    image_dir = Path(project_dir, "assets", category)
    for extension in VALID_EXTENSIONS:
        image_path = image_dir / f"{name}{extension}"
        if image_path.is_file():
            image_path.unlink()
    _delete_state_keys(project_dir, category, name)
    sync_merged_asset_descriptions(project_dir)


def _validate_category(category: str) -> None:
    if category not in VALID_CATEGORIES:
        raise ValueError(f"不支持的资产类别: {category}")


def _clean_prompt(prompt: str) -> str:
    value = " ".join(str(prompt or "").replace("|", "，").splitlines()).strip()
    if len(value) < 10:
        raise ValueError("资产提示词至少需要 10 个字符")
    return value


def _clean_field(value: str) -> str:
    return " ".join(str(value or "").replace("|", "，").splitlines()).strip()


def _format_record(
    name: str, aliases: str, episodes: str, prompt: str
) -> str:
    return (
        f"{name}|{_clean_field(aliases)}|{_clean_field(episodes)}|"
        f"{_clean_prompt(prompt)}"
    )


def _record(name: str, aliases: str, episodes: str, prompt: str) -> dict:
    return {
        "name": name,
        "aliases": _clean_field(aliases),
        "episodes": _clean_field(episodes),
        "prompt": _clean_prompt(prompt),
    }


def _prompt_path(project_dir: str, category: str) -> Path:
    return Path(project_dir, "assets", CATEGORY_PROMPT_FILES[category])


def _read_lines(path: Path) -> list[str]:
    if not path.is_file():
        return [
            "# 手动管理的资产描述（可继续编辑）",
            "# 格式: 名称|别名|出场集数|描述",
        ]
    return path.read_text(encoding="utf-8").splitlines()


def _find_record_index(lines: list[str], name: str):
    for index, raw_line in enumerate(lines):
        line = raw_line.strip()
        if not line or line.startswith("#") or "|" not in line:
            continue
        if line.split("|", 1)[0].strip() == name:
            return index
    return None


def _write_prompt_lines(path: Path, lines: list[str]) -> None:
    content = "\n".join(lines).rstrip() + "\n"
    _write_text_atomic(path, content)


def _rename_asset_images(
    project_dir: str, category: str, original_name: str, name: str
) -> list[tuple[Path, Path]]:
    image_dir = Path(project_dir, "assets", category)
    planned = []
    for extension in VALID_EXTENSIONS:
        source = image_dir / f"{original_name}{extension}"
        if not source.is_file():
            continue
        target = image_dir / f"{name}{extension}"
        if target.exists():
            raise ValueError(f"目标图片已存在: {target.name}")
        planned.append((source, target))
    for source, target in planned:
        os.replace(source, target)
    return planned


def _rename_state_keys(
    project_dir: str,
    category: str,
    original_name: str,
    name: str,
    aliases: str,
    prompt: str,
) -> None:
    assets_dir = Path(project_dir, "assets")
    selection_path = assets_dir / "selections.json"
    selections = _read_json(selection_path)
    category_data = selections.setdefault(category, {})
    record = category_data.pop(original_name, {})
    if record:
        image_path = str(record.get("image_path", ""))
        if image_path:
            image = Path(image_path)
            record["image_path"] = str(image.with_name(name + image.suffix))
        category_data[name] = record
        _write_json_atomic(selection_path, selections)

    candidates_path = assets_dir / "candidates.json"
    candidates = _read_json(candidates_path)
    candidate_items = candidates.get(category, [])
    changed = False
    for item in candidate_items if isinstance(candidate_items, list) else []:
        if item.get("name") == original_name:
            item["name"] = name
            item["aliases"] = _clean_field(aliases)
            item["prompt"] = _clean_prompt(prompt)
            changed = True
    if changed:
        _write_json_atomic(candidates_path, candidates)


def _delete_state_keys(project_dir: str, category: str, name: str) -> None:
    assets_dir = Path(project_dir, "assets")
    for filename in ("selections.json", "candidates.json"):
        path = assets_dir / filename
        data = _read_json(path)
        if filename == "selections.json":
            category_data = data.get(category, {})
            changed = isinstance(category_data, dict) and name in category_data
            if changed:
                del category_data[name]
        else:
            items = data.get(category, [])
            changed = isinstance(items, list) and any(
                item.get("name") == name for item in items
            )
            if changed:
                data[category] = [
                    item for item in items if item.get("name") != name
                ]
        if changed:
            _write_json_atomic(path, data)


def _read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _write_json_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    os.replace(temporary, path)


def _write_text_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(content, encoding="utf-8")
    os.replace(temporary, path)
