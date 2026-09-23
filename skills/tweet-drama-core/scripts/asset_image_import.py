"""Import user-provided images as project assets."""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Callable, Optional

from PIL import Image, ImageOps, UnidentifiedImageError


VALID_CATEGORIES = {"character", "scene", "prop"}
VALID_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
MAX_IMAGE_BYTES = 50 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000
INVALID_NAME_CHARS = set('<>:"/\\|?*')
WINDOWS_RESERVED_NAMES = {
    "CON", "PRN", "AUX", "NUL", "CLOCK$",
    *(f"COM{index}" for index in range(1, 10)),
    *(f"LPT{index}" for index in range(1, 10)),
}
CATEGORY_PROMPT_FILES = {
    "character": "character_prompts.txt",
    "scene": "scene_prompts.txt",
    "prop": "prop_prompts.txt",
}
CATEGORY_NAMES = {
    "character": "角色",
    "scene": "场景",
    "prop": "道具",
}
FALLBACK_PROMPTS = {
    "character": (
        "user-provided person character reference image, 视觉描述待补充，"
        "请在提示词审核页面补充人物外貌、年龄、发型和服装特征"
    ),
    "scene": (
        "scene from a user-provided reference image, 视觉描述待补充，"
        "请在提示词审核页面补充地点、环境、时间和空间特征"
    ),
    "prop": (
        "prop from a user-provided reference image, 视觉描述待补充，"
        "请在提示词审核页面补充材质、尺寸、颜色和外观特征"
    ),
}
VISION_SYSTEM_PROMPTS = {
    "character": (
        "You are a film character designer. Describe the visible person in "
        "concise English for realistic live-action image generation."
    ),
    "scene": (
        "You are a film production designer. Describe the visible environment "
        "in concise English for realistic live-action image generation."
    ),
    "prop": (
        "You are a film prop designer. Describe the visible object in concise "
        "English for realistic product-style image generation."
    ),
}
VISION_USER_PROMPTS = {
    "character": (
        "Describe the character named {name}. Include person gender, approximate "
        "age, face, hair, clothing, expression and overall temperament. "
        "Return only one English prompt and include the word person."
    ),
    "scene": (
        "Describe the scene named {name}. Include location type, spatial layout, "
        "materials, colors, time of day and important environmental details. "
        "Return only one English prompt and do not invent people."
    ),
    "prop": (
        "Describe the prop named {name}. Include object type, material, color, "
        "shape, scale, surface details and condition. Return only one English prompt."
    ),
}


def import_asset_image(
    project_dir: str, category: str, asset_name: str, source_path: str
) -> str:
    """Validate and atomically install one user image for an asset."""
    if category not in VALID_CATEGORIES:
        raise ValueError(f"不支持的资产类别: {category}")
    name = validate_asset_name(asset_name)

    source = Path(source_path)
    if not source.is_file():
        raise ValueError("选择的图片文件不存在")
    if source.stat().st_size > MAX_IMAGE_BYTES:
        raise ValueError("图片文件过大，单张图片不能超过 50 MB")
    if source.suffix.lower() not in VALID_EXTENSIONS:
        raise ValueError("仅支持 PNG、JPG、JPEG 和 WEBP 图片")
    _verify_image(source)

    output_dir = Path(project_dir, "assets", category)
    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / f"{name}.png"
    temporary = output_dir / f".{name}.uploading.png"
    try:
        _save_as_png(source, temporary)
        _verify_image(temporary)
        os.replace(temporary, target)
    finally:
        if temporary.exists():
            temporary.unlink()

    for old_extension in VALID_EXTENSIONS:
        old_path = output_dir / f"{name}{old_extension}"
        if old_path != target and old_path.is_file():
            old_path.unlink()
    return str(target)


def validate_asset_name(asset_name: str) -> str:
    """Return a Windows-safe asset name or raise a user-facing error."""
    name = asset_name.strip()
    if (
        not name
        or name in {".", ".."}
        or name.endswith((".", " "))
        or name.split(".", 1)[0].upper() in WINDOWS_RESERVED_NAMES
        or any(ord(char) < 32 for char in name)
        or any(char in INVALID_NAME_CHARS for char in name)
        or Path(name).name != name
    ):
        raise ValueError("资产名称包含 Windows 文件名不允许的字符")
    return name


def normalize_episode_spec(value: str) -> str:
    """Normalize user-facing episode input to comma-separated two-digit ids.

    Accepted examples: ``1``, ``01``, ``01,03,05``, ``1-10``,
    ``01-10,14,20-40``. Chinese separators are accepted, but natural-language
    text like ``第3集`` is intentionally rejected here so asset metadata stays
    deterministic.
    """
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("出场集数不能为空")
    normalized = (
        raw.replace("，", ",")
        .replace("、", ",")
        .replace("；", ",")
        .replace(";", ",")
        .replace("～", "-")
        .replace("—", "-")
        .replace("－", "-")
    )
    episodes: list[int] = []
    seen: set[int] = set()
    for token in [part.strip() for part in normalized.split(",") if part.strip()]:
        if "-" in token:
            bounds = [part.strip() for part in token.split("-", 1)]
            if len(bounds) != 2 or not all(re.fullmatch(r"\d{1,3}", part) for part in bounds):
                raise ValueError(f"集数范围格式无效: {token}")
            start, end = int(bounds[0]), int(bounds[1])
            if start <= 0 or end <= 0 or start > end:
                raise ValueError(f"集数范围格式无效: {token}")
            values = range(start, end + 1)
        else:
            if not re.fullmatch(r"\d{1,3}", token):
                raise ValueError(f"集数格式无效: {token}")
            number = int(token)
            if number <= 0:
                raise ValueError(f"集数格式无效: {token}")
            values = [number]
        for number in values:
            if number not in seen:
                seen.add(number)
                episodes.append(number)
    if not episodes:
        raise ValueError("出场集数不能为空")
    return ",".join(f"{number:02d}" for number in episodes)


def import_named_asset_images(
    project_dir: str,
    category: str,
    source_paths: list[str],
    describe_image: Optional[Callable[[str, str, str], str]] = None,
    on_progress: Optional[Callable[[int, int, str], None]] = None,
    cancelled: Optional[Callable[[], bool]] = None,
    import_hints: Optional[dict[str, object]] = None,
    replace_existing: bool = False,
) -> dict:
    """Import images named by filename and synchronize prompt text files."""
    if category not in VALID_CATEGORIES:
        raise ValueError(f"不支持的资产类别: {category}")

    assets_dir = Path(project_dir, "assets")
    assets_dir.mkdir(parents=True, exist_ok=True)
    prompt_path = assets_dir / CATEGORY_PROMPT_FILES[category]
    existing_text = (
        prompt_path.read_text(encoding="utf-8") if prompt_path.is_file() else ""
    )
    existing_names = _prompt_names(existing_text)
    appended_lines: list[str] = []
    report = {
        "success": False,
        "category": category,
        "created": 0,
        "updated": 0,
        "imported": [],
        "review_items": [],
        "conflicts": [],
        "warnings": [],
        "errors": [],
    }
    import_hints = import_hints or {}
    update_asset_context_record = None
    infer_allows_text = None
    if import_hints:
        from asset_context import (
            infer_allows_text,
            update_asset_context_record,
        )

    total = len(source_paths)
    for index, source_path in enumerate(source_paths, 1):
        if cancelled and cancelled():
            report["warnings"].append("用户取消，剩余图片未导入")
            break

        original_name = Path(source_path).stem.strip()
        name = original_name
        hint = _hint_for_path(import_hints, source_path)
        hint_data = _normalize_import_hint(hint)
        if name == original_name and hint_data.get("label"):
            name = _name_from_hint(hint_data, original_name)

        if name in existing_names and not replace_existing:
            report["conflicts"].append({
                "source": source_path,
                "name": name,
                "category": category,
                "hint": hint_data,
            })
            report["warnings"].append(f"{name} 已存在，已跳过；确认替换后才会覆盖图片")
            if on_progress:
                on_progress(index, total, name)
            continue

        created = name not in existing_names
        aliases = str(hint_data.get("aliases") or "").strip()
        raw_episodes = str(hint_data.get("episodes") or "").strip()
        try:
            episodes = normalize_episode_spec(raw_episodes) if (created or raw_episodes) else ""
        except ValueError as exc:
            report["errors"].append(
                {"source": source_path, "name": name, "error": str(exc)}
            )
            if on_progress:
                on_progress(index, total, name)
            continue
        prompt_hint = str(hint_data.get("prompt") or "").strip()
        allows_text = bool(hint_data.get("allows_text", False))

        try:
            image_path = import_asset_image(
                project_dir, category, name, source_path
            )
        except (OSError, ValueError) as exc:
            report["errors"].append(
                {"source": source_path, "name": name, "error": str(exc)}
            )
            if on_progress:
                on_progress(index, total, name)
            continue

        prompt = ""
        if created:
            prompt = FALLBACK_PROMPTS[category]
            if prompt_hint:
                prompt = prompt_hint
            if describe_image and not prompt_hint:
                try:
                    described = describe_image(category, name, image_path).strip()
                    if len(described) < 10:
                        raise ValueError("视觉模型返回的描述过短")
                    prompt = described
                except Exception as exc:
                    report["warnings"].append(
                        f"{name} 视觉识别失败，已保留图片并创建待补充提示词: {exc}"
                    )
            prompt = " ".join(prompt.replace("|", "，").splitlines()).strip()
            appended_lines.append(f"{name}|{aliases}|{episodes}|{prompt}")
            existing_names.add(name)
            report["created"] += 1
            if update_asset_context_record:
                inferred_allows_text = (
                    infer_allows_text(category, name, aliases, prompt)
                    if infer_allows_text else False
                )
                update_asset_context_record(
                    project_dir,
                    category,
                    name=name,
                    aliases=aliases,
                    episodes=episodes,
                    prompt=prompt,
                    allows_text=allows_text or inferred_allows_text,
                )
        else:
            report["updated"] += 1

        report["imported"].append({
            "name": name,
            "category": category,
            "image_path": image_path,
            "created": created,
            "source_name": original_name,
            "prompt": prompt,
        })
        if allows_text:
            report["imported"][-1]["allows_text"] = True
        if on_progress:
            on_progress(index, total, name)

    if appended_lines:
        content = existing_text.rstrip()
        if not content:
            content = (
                "# 用户导入的资产描述（可在提示词审核页面修改）\n"
                "# 格式: 名称|别名|出场集数|描述\n"
            )
        content = content.rstrip() + "\n" + "\n".join(appended_lines) + "\n"
        _write_text_atomic(prompt_path, content)

    if report["imported"]:
        _write_merged_asset_descriptions(assets_dir)
        report["success"] = True
        if import_hints:
            from asset_context import build_asset_context, save_asset_context
            refreshed = build_asset_context(project_dir)
            for item in report["imported"]:
                _merge_import_metadata(refreshed, item)
            save_asset_context(project_dir, refreshed)
    return report


def describe_asset_image(llm_client, category: str, name: str, image_path: str) -> str:
    """Create editable prompt text for one newly imported asset image."""
    if category not in VALID_CATEGORIES:
        raise ValueError(f"不支持的资产类别: {category}")
    description = llm_client.generate_with_images(
        prompt=VISION_USER_PROMPTS[category].format(name=name),
        image_paths=[image_path],
        system_prompt=VISION_SYSTEM_PROMPTS[category],
        max_tokens=900,
        temperature=0.2,
    )
    description = str(description or "").strip()
    if len(description) < 10:
        raise ValueError("视觉模型没有返回有效的资产描述")
    return description


def _verify_image(path: Path) -> None:
    try:
        with Image.open(path) as image:
            if image.width * image.height > MAX_IMAGE_PIXELS:
                raise ValueError("图片像素过大，不能超过 4000 万像素")
            image.verify()
    except ValueError:
        raise
    except (OSError, UnidentifiedImageError, Image.DecompressionBombError) as exc:
        raise ValueError("选择的文件不是有效的图片或图片已经损坏") from exc


def _save_as_png(source: Path, target: Path) -> None:
    try:
        with Image.open(source) as image:
            if image.width * image.height > MAX_IMAGE_PIXELS:
                raise ValueError("图片像素过大，不能超过 4000 万像素")
            image = ImageOps.exif_transpose(image)
            image.load()
            if image.mode not in {"RGB", "RGBA"}:
                image = image.convert("RGBA" if "transparency" in image.info else "RGB")
            image.save(target, format="PNG")
    except ValueError:
        raise
    except (OSError, UnidentifiedImageError, Image.DecompressionBombError) as exc:
        raise ValueError("选择的文件不是有效的图片或图片已经损坏") from exc


def _prompt_names(text: str) -> set[str]:
    names = set()
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "|" not in line:
            continue
        name = line.split("|", 1)[0].strip()
        if name:
            names.add(name)
    return names


def _hint_for_path(import_hints: dict[str, object], source_path: str) -> object:
    if not import_hints:
        return None
    source = Path(source_path)
    return (
        import_hints.get(source_path)
        or import_hints.get(str(source))
        or import_hints.get(source.name)
        or import_hints.get(source.stem)
    )


def _normalize_import_hint(hint: object) -> dict[str, object]:
    if isinstance(hint, dict):
        return {
            "label": str(hint.get("label") or hint.get("name") or "").strip(),
            "aliases": str(hint.get("aliases") or "").strip(),
            "episodes": str(hint.get("episodes") or "").strip(),
            "prompt": str(hint.get("prompt") or "").strip(),
            "allows_text": bool(hint.get("allows_text", False)),
        }
    if isinstance(hint, str):
        return {
            "label": hint.strip(),
            "aliases": "",
            "episodes": "",
            "prompt": "",
            "allows_text": False,
        }
    return {}


def _name_from_hint(hint: dict[str, object], fallback_name: str) -> str:
    label = str(hint.get("label") or fallback_name or "").strip()
    return label or fallback_name


def _merge_import_metadata(context: dict, item: dict) -> None:
    if not item.get("allows_text"):
        return
    category = item.get("category", "")
    name = item.get("name", "")
    records = context.setdefault("assets", {}).setdefault(category, [])
    for record in records:
        if record.get("name") == name:
            record["allows_text"] = True
            return


def _write_merged_asset_descriptions(assets_dir: Path) -> None:
    sections = []
    for category in ("character", "scene", "prop"):
        path = assets_dir / CATEGORY_PROMPT_FILES[category]
        if not path.is_file():
            continue
        content = path.read_text(encoding="utf-8").strip()
        if content:
            sections.append(
                f"# === {CATEGORY_NAMES[category]} ===\n{content}\n"
            )
    _write_text_atomic(
        assets_dir / "asset_descriptions.txt",
        "\n".join(sections),
    )


def sync_merged_asset_descriptions(project_dir: str) -> None:
    """Rebuild the compatibility merged prompt file from category files."""
    assets_dir = Path(project_dir, "assets")
    assets_dir.mkdir(parents=True, exist_ok=True)
    _write_merged_asset_descriptions(assets_dir)


def _write_text_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(content, encoding="utf-8")
    os.replace(temporary, path)
