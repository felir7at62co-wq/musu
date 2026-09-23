"""Offline checks for live-action skill safety and project-setting authority."""

from __future__ import annotations

from pathlib import Path


FORBIDDEN_ACTIVE_TERMS = (
    "runninghub",
    "minimax",
    "彩铅",
    "推文模式",
    "画外音/台词拆分",
    "production_mode=seedance",
    "ark_api_key",
    "取得本次即时批准",
    "pending 表示可交付",
    "超过 5 分钟仍未就绪即降级",
    "本格式没有旁白",
    "绝不允许 5 秒镜头",
)

# 「一集的 BGM 必须多于一首」曾列在上面的禁用词里，但它是用户硬要求，不是废弃链路。
# 把它当禁用词会让任何恢复该要求的编辑都撞门禁，等于用校验器维持删除。
# 约束留在 tweet-drama-background-render/SKILL.md 正文，不在本表。

OBSOLETE_ACTIVE_SKILLS = (
    "tweet-drama-colored-pencil-assets",
    "tweet-drama-dialogue-narration-split",
    "tweet-drama-image-to-video",
    "tweet-drama-seedance-error-diagnosis",
    "jubianai-api",
)


def _active_skill_files(skills_root: Path) -> list[Path]:
    return sorted(
        path / "SKILL.md"
        for path in skills_root.iterdir()
        if path.is_dir() and path.name != "_archived" and (path / "SKILL.md").is_file()
    )


def validate_skill_package(project_root: Path) -> list[str]:
    """Return contract violations; do not raise for user-facing diagnostics."""

    skills_root = project_root / "skills"
    if not skills_root.is_dir():
        skills_root = project_root / ".agents" / "skills"
    errors: list[str] = []
    if not skills_root.is_dir():
        return [f"缺少 skills 根目录: {skills_root}"]

    files = _active_skill_files(skills_root)
    if not files:
        errors.append("没有找到活动 SKILL.md")

    for skill_file in files:
        text = skill_file.read_text(encoding="utf-8").casefold()
        for term in FORBIDDEN_ACTIVE_TERMS:
            if term.casefold() in text:
                errors.append(f"{skill_file.relative_to(project_root)} 含废弃链路: {term}")

    for skill_name in OBSOLETE_ACTIVE_SKILLS:
        if (skills_root / skill_name / "SKILL.md").is_file():
            errors.append(f"废弃 skill 仍处于活动目录: {skill_name}")

    pipeline = skills_root / "tweet-drama-pipeline" / "SKILL.md"
    pipeline_text = pipeline.read_text(encoding="utf-8") if pipeline.is_file() else ""
    for required in (
        "真人剧",
        "正式资产",
        "自动审核",
        "确认出演",
        "jubian_asset",
        "jubian_storyboard",
        "asset_confirmation",
        "max_review_attempts=3",
        "1–4秒",
        "9 个有效字",
        "36",
        "subtitle_cleanup",
        "实际发声",
        "实时目录",
        "授权范围",
        "预计费用",
        "非最终交付",
        "QA",
        "同场画外音",
        "official=true",
    ):
        if required not in pipeline_text:
            errors.append(f"总控缺少真人剧契约字段: {required}")

    shot_skill = skills_root / "tweet-drama-early-shot-script" / "SKILL.md"
    shot_text = shot_skill.read_text(encoding="utf-8") if shot_skill.is_file() else ""
    for required in ("当前分镜", "实时模型目录", "max_submit_seconds", "警告", "原文", "说话人"):
        if required not in shot_text:
            errors.append(f"镜头门禁缺少字段: {required}")

    draft_skill = skills_root / "tweet-drama-draft-build" / "SKILL.md"
    draft_text = draft_skill.read_text(encoding="utf-8").casefold() if draft_skill.is_file() else ""
    for required in ("not_required", "dialogue", "vo", "os", "真实发声"):
        if required.casefold() not in draft_text:
            errors.append(f"剪辑门禁缺少字段: {required}")

    return errors
