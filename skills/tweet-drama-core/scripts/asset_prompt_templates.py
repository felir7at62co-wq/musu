"""Resolve editable asset extraction prompts without mutating bundled files.

All asset categories share the same extraction contract:
name | aliases | episodes | visual prompt.
"""
from __future__ import annotations

import os
from pathlib import Path


SUPPORTED_CATEGORIES = {"character", "scene", "prop"}
PROJECT_TEMPLATE_FILE = "asset_prompt.txt"
BUNDLED_TEMPLATE_FILE = "default_asset_prompt.txt"


def project_asset_prompt_template(project_dir: str, category: str) -> str:
    _validate_category(category)
    return os.path.join(project_dir, "prompts", "extraction_templates", PROJECT_TEMPLATE_FILE)


def bundled_asset_prompt_template(app_dir: str, category: str) -> str:
    _validate_category(category)
    return os.path.join(app_dir, "prompts", BUNDLED_TEMPLATE_FILE)


def resolve_asset_prompt_template(
    project_dir: str,
    category: str,
    app_dir: str,
    configured_path: str = "",
) -> str:
    _validate_category(category)
    project_path = project_asset_prompt_template(project_dir, category)
    if os.path.isfile(project_path):
        return project_path
    if configured_path and os.path.isfile(configured_path):
        return configured_path
    return bundled_asset_prompt_template(app_dir, category)


def save_project_asset_prompt_template(
    project_dir: str, category: str, content: str
) -> str:
    _validate_category(category)
    if not content.strip():
        raise ValueError("提取模板不能为空")
    if "{screenplay_text}" not in content:
        raise ValueError("提取模板必须包含 {screenplay_text} 剧本占位符")
    required_terms = ("别名", "集数", "生图提示词")
    missing = [term for term in required_terms if term not in content]
    if missing:
        raise ValueError(
            "提取模板必须使用四列资产格式：名称、别名、集数、生图提示词"
        )

    path = Path(project_asset_prompt_template(project_dir, category))
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(content, encoding="utf-8")
    os.replace(temporary, path)
    return str(path)


def remove_project_asset_prompt_template(project_dir: str, category: str) -> None:
    _validate_category(category)
    path = Path(project_asset_prompt_template(project_dir, category))
    if path.exists():
        path.unlink()


def _validate_category(category: str) -> None:
    if category not in SUPPORTED_CATEGORIES:
        raise ValueError(f"不支持的资产类别: {category}")
