"""Canonical pipeline state for every live-action Jubian project.

`pipeline_state.json` is the only workflow-state source of truth. Domain manifests
such as `assets_manifest.json` and `audio/manifest.json` describe artifacts only.

Two writers, one file: `sync` recomputes every stage from the artifacts on disk
(`status_source: projection`), while `set` records a human decision
(`status_source: manual`). A projection never overwrites a manual record, so the
file carries both the derived stage picture and the annotations a person added.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List

sys.path.insert(0, str(Path(__file__).resolve().parent))
from video_bans import check_videos


VERSION = 3
STATUSES = {"pending", "queued", "running", "review", "completed", "failed", "stale", "blocked", "skipped"}
STAGES = (
    "source", "episodes", "style", "asset_prompts", "asset_candidates",
    "official_assets", "shots_and_matches", "video_tasks",
    "reviewed_videos", "draft", "export",
)
LEGACY_STAGES = (
    "audio", "transcript", "storyboard", "segments", "assets", "asset_images",
    "shot_scripts", "matches", "packages", "colored_pencil", "video",
)


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def blank(project: Path) -> Dict[str, Any]:
    stamp = now()
    return {
        "version": VERSION,
        "project": project.name,
        "created_at": stamp,
        "updated_at": stamp,
        "stages": {stage: record() for stage in STAGES},
        "episodes": {},
        "active": {"stage": "", "episode": "", "item": ""},
    }


def record(status: str = "pending", **extra: Any) -> Dict[str, Any]:
    if status not in STATUSES:
        raise ValueError(f"invalid status: {status}")
    return {"status": status, "updated_at": now(), "error": "", "outputs": [], "metadata": {}, **extra}


class PipelineState:
    def __init__(self, project: str | Path):
        self.project = Path(project).resolve()
        self.path = self.project / "pipeline_state.json"
        self.data = self._load()

    def _load(self) -> Dict[str, Any]:
        if self.path.exists():
            data = json.loads(self.path.read_text(encoding="utf-8-sig"))
        else:
            data = blank(self.project)
        data["version"] = VERSION
        data.setdefault("project", self.project.name)
        data.setdefault("created_at", now())
        data.setdefault("episodes", {})
        data.setdefault("active", {"stage": "", "episode": "", "item": ""})
        stages = data.setdefault("stages", {})
        # 迁移：v1 的 audio/transcript/storyboard 旧阶段不再生效，
        # 原值保留到 legacy_stages 供追溯，避免被 discover/set 误写。
        legacy = data.setdefault("legacy_stages", {})
        for old in LEGACY_STAGES:
            if old in stages:
                legacy[old] = stages.pop(old)
        for old in LEGACY_STAGES:
            for ep, ep_state in data.get("episodes", {}).items():
                if old in ep_state:
                    legacy.setdefault(f"{old}.{ep}", ep_state.pop(old))
        # active 指向已删除旧阶段时重置
        if data.get("active", {}).get("stage") in LEGACY_STAGES:
            data["active"] = {"stage": "", "episode": "", "item": ""}
        for stage in STAGES:
            stages.setdefault(stage, record())
        return data

    def save(self) -> None:
        self.project.mkdir(parents=True, exist_ok=True)
        self.data["updated_at"] = now()
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=self.project, suffix=".tmp") as handle:
            json.dump(self.data, handle, ensure_ascii=False, indent=2)
            temp = handle.name
        os.replace(temp, self.path)

    def set(self, stage: str, status: str, episode: str = "", item: str = "", error: str = "",
            outputs: Iterable[str] = (), metadata: Dict[str, Any] | None = None,
            source: str = "manual") -> None:
        if stage not in STAGES:
            raise ValueError(f"unknown stage: {stage}")
        payload = record(status, error=error, outputs=list(outputs), metadata=metadata or {})
        payload["status_source"] = source
        if episode:
            ep = str(episode).zfill(2)
            target = self.data.setdefault("episodes", {}).setdefault(ep, {})
            if item:
                target.setdefault(stage, {}).setdefault("items", {})[item] = payload
            else:
                target[stage] = payload
        else:
            self.data["stages"][stage] = payload
        self.data["active"] = {"stage": stage if status in {"queued", "running", "review", "blocked"} else "",
                               "episode": str(episode).zfill(2) if episode else "", "item": item}
        self.save()

    def stale_from(self, stage: str, episode: str = "", reason: str = "upstream input changed") -> None:
        start = STAGES.index(stage)
        targets = STAGES[start:]
        container = self.data["episodes"].setdefault(str(episode).zfill(2), {}) if episode else self.data["stages"]
        for name in targets:
            old = container.get(name)
            if old and old.get("status") not in {"pending", "skipped"}:
                container[name] = record("stale", error=reason, outputs=old.get("outputs", []), metadata=old.get("metadata", {}))
        self.save()

    def migrate_legacy(self) -> None:
        """Import legacy state.json/manifest.json without deleting them."""
        legacy_state = self.project / "state.json"
        if legacy_state.exists():
            raw = json.loads(legacy_state.read_text(encoding="utf-8-sig"))
            mapping = {
                "script": "episodes",
                "prompt": "shots_and_matches",
                "asset": "asset_prompts",
                "web_video": "reviewed_videos",
                "sort": "reviewed_videos",
            }
            for old, value in raw.get("steps", {}).items():
                stage = mapping.get(old, old)
                if stage in STAGES:
                    status = value.get("status", "pending")
                    if status not in STATUSES:
                        status = "pending"
                    self.data["stages"][stage] = record(status, error=value.get("error") or "",
                                                        metadata=value.get("metadata") or {})
        legacy_manifest = self.project / "manifest.json"
        if legacy_manifest.exists():
            raw = json.loads(legacy_manifest.read_text(encoding="utf-8-sig"))
            for episode, stages in raw.get("episodes", {}).items():
                for old, value in stages.items():
                    stage = {
                        "script": "episodes",
                        "prompt": "shots_and_matches",
                        "asset": "asset_prompts",
                        "web_video": "reviewed_videos",
                        "sort": "reviewed_videos",
                    }.get(old, old)
                    if stage in STAGES:
                        status = value.get("status", "pending")
                        if status not in STATUSES:
                            status = "pending"
                        self.data["episodes"].setdefault(str(episode).zfill(2), {})[stage] = record(
                            status, error=value.get("error") or "", outputs=[value["output_path"]] if value.get("output_path") else [],
                            metadata=value.get("metadata") or {})
        self.save()

    # ---------------------------------------------------------------- 产物投影
    # 阶段状态由磁盘产物重算（命令 `sync`），不再靠谁记得回写：手写自述必然腐烂——
    # 2026-09-20 实测《山海自有相逢处》的 12 个阶段里有 6 个与磁盘矛盾，文件停在三天前。
    # 人工用 `set` 写过的记录（status_source == "manual"）永不覆盖，metadata / error 原样保留，
    # 于是这个文件同时是「产物投影」与「人工批注」，两者不会互相踩。

    def _facts(self) -> Dict[str, Any]:
        """扫一遍每集产物，返回各阶段的计数依据（全部相对项目根）。"""
        project = self.project

        def glob(pattern: str) -> List[Path]:
            return sorted(path for path in project.glob(pattern) if path.is_file())

        def episode_of_shots(path: Path) -> str:
            return path.name.split("第", 1)[1].split("集", 1)[0].zfill(2)

        def episode_of_export(path: Path) -> str:
            return path.name.split("第", 1)[1].split("集", 1)[0].zfill(2)

        packs = [path for path in glob("media/ep*/*.mp4") if path.stem.startswith("p") and path.stem[1:].isdigit()]
        cleaned = [path for path in glob("media/ep*/*.mp4")
                   if "-clean" in path.stem or "-deliver" in path.stem]
        return {
            "source_script": glob("source/source_script.txt") + glob("source/original/*"),
            "episodes": glob("episodes/*.txt"),
            "style_bible": glob("assets/style_bible.md") + glob("style_bible.md"),
            "manifest": glob("assets_manifest.json"),
            "candidate_images": glob("assets/batch1/*.png"),
            "scripts": glob("shots/第*集*镜头脚本.md"),
            "matched": glob("matches/*.matched.json"),
            "packages": glob("episode_packages/*/package.json"),
            "packs": packs,
            "cleaned": cleaned,
            "editing": glob("editing/*"),
            "masters": glob("export/*成片*.mp4"),
            "deliveries": glob("export/delivery-ep*.mp4"),
            "episodes_with_text": {path.stem.zfill(2) for path in glob("episodes/*.txt")},
            "episodes_with_script": {episode_of_shots(path) for path in glob("shots/第*集*镜头脚本.md")},
            "episodes_matched": {path.name.split(".", 1)[0] for path in glob("matches/*.matched.json")},
            "episodes_packed": {path.parent.name for path in glob("episode_packages/*/package.json")},
            "episodes_generated": {path.parent.name[2:] for path in packs},
            "episodes_rendered": {episode_of_export(path) for path in glob("export/*成片*.mp4")},
            "episodes_delivered": {path.name.split("-ep", 1)[1][:2] for path in glob("export/delivery-ep*.mp4")},
        }

    def _reviewed_sources(self, episodes: Iterable[str]) -> tuple:
        """Check prepared selections against each expected package's byte-bound review.

        prepare writes editing/<ep>-sources.json rows with shot, explicit package,
        video and sha256. Reviews use reviews/ep<ep>-p<package:02>.json and the
        existing episode/package/video_path/status/subtitle_cleanup/review_frames
        fields plus video_sha256 and package_sha256 (current episode package file
        bytes, shared by selection and review). Even formatting changes invalidate
        that episode's evidence. Missing legacy evidence stays review, not failed.
        """
        missing, evidence, complete = [], [], []

        def document(path: Path) -> Dict[str, Any]:
            try:
                value = json.loads(path.read_text(encoding="utf-8-sig"))
                if not isinstance(value, dict):
                    raise ValueError("expected JSON object")
                return value
            except (OSError, ValueError) as error:
                missing.append(f"{path.relative_to(self.project)}: read valid evidence ({error})")
                return {}

        def digest(path: Path) -> str:
            with path.open("rb") as handle:
                return hashlib.file_digest(handle, "sha256").hexdigest()

        for ep in sorted(episodes):
            before = len(missing)
            try:
                check_videos(self.project, (self.project / 'video' / ep).glob('shot_*.mp4'))
            except (OSError, ValueError) as error:
                missing.append(f'EP{ep}: {error}')
                continue
            package_path = self.project / "episode_packages" / ep / "package.json"
            tasks = document(package_path).get("video_tasks")
            if not isinstance(tasks, list) or not tasks or not all(
                isinstance(task, dict) and isinstance(task.get("shots"), list) and task["shots"] for task in tasks
            ):
                missing.append(f"EP{ep}: supply expected video_tasks with shot membership")
                continue
            selected_path = self.project / "editing" / f"{ep}-sources.json"
            selected = document(selected_path).get("shots")
            if not isinstance(selected, list) or not selected:
                missing.append(f"EP{ep}: run prepare with explicit package mappings")
                continue
            expected = set(range(1, len(tasks) + 1))
            covered, shot_numbers = set(), []
            for row in selected:
                if not isinstance(row, dict) or type(row.get("package")) is not int or row["package"] not in expected:
                    missing.append(f"EP{ep}: selected source needs an expected package id; do not infer from shot")
                    continue
                package, shot = row["package"], row.get("shot")
                covered.add(package)
                if type(shot) is not int or shot < 1:
                    missing.append(f"EP{ep}-P{package}: selected source needs a positive shot id")
                    continue
                shot_numbers.append(shot)
                review_path = self.project / "reviews" / f"ep{ep}-p{package:02}.json"
                review = document(review_path)
                try:
                    package_hash = digest(package_path)
                    if row.get("package_sha256") != package_hash or review.get("package_sha256") != package_hash:
                        raise ValueError("package_sha256 differs or is missing; review current package contents then prepare")
                    video = row.get("video")
                    if not isinstance(video, str) or not video.strip():
                        raise ValueError("missing selected video path")
                    source = (self.project / video).resolve()
                    reviewed_video = review.get("video_path")
                    if not isinstance(reviewed_video, str) or (self.project / reviewed_video).resolve() != source:
                        raise ValueError("review.video_path does not identify the selected source")
                    if str(review.get("episode")).zfill(2) != ep or review.get("package") != package:
                        raise ValueError("review episode/package identity differs")
                    prepared = self.project / "video" / ep / f"shot_{shot:03}.mp4"
                    actual = digest(prepared)
                    if actual != row.get("sha256") or actual != review.get("video_sha256") or actual != digest(source):
                        raise ValueError("selected/prepared/review source hashes differ; review current bytes then prepare")
                    if review.get("status") != "approved" or review.get("subtitle_cleanup") not in {"clean", "not_required"}:
                        raise ValueError("selected source needs approved review and clean/not_required subtitles")
                    checks = review.get("content_review")
                    required_checks = ("identity", "wardrobe", "scene", "prop", "action_and_dialogue", "visible_artifacts")
                    if not isinstance(checks, dict) or any(checks.get(key) != "pass" for key in required_checks) \
                            or checks.get("embedded_subtitles") != "absent":
                        raise ValueError("content review needs all six checks passing and embedded_subtitles=absent")
                    frames = review.get("review_frames")
                    if not isinstance(frames, list) or not frames or not all(
                        isinstance(frame, str) and frame and (self.project / frame).is_file() for frame in frames
                    ):
                        raise ValueError("review_frames must reference existing evidence files")
                except (OSError, ValueError) as error:
                    missing.append(f"EP{ep}-P{package}: {error}")
                    continue
                evidence.append(str(review_path.relative_to(self.project)))
            if covered != expected:
                missing.append(f"EP{ep}: select every expected package; missing {sorted(expected - covered)}")
            if sorted(shot_numbers) != list(range(1, len(selected) + 1)):
                missing.append(f"EP{ep}: selected shots must be unique and contiguous")
            clips = document(self.project / "editing" / f"{ep}-timeline.json").get("clips")
            if not isinstance(clips, list) or not all(isinstance(clip, dict) for clip in clips) \
                    or [clip.get("shot") for clip in clips] != shot_numbers:
                missing.append(f"EP{ep}: timeline clip membership differs from prepared selections; run prepare")
            if len(missing) == before:
                complete.append(ep)
                evidence.append(str(selected_path.relative_to(self.project)))
        return complete, evidence, missing

    def _official_counts(self) -> Dict[str, int]:
        """清单里的 official 资产数：投影用它判定「资产阶段」是否完成。"""
        path = self.project / "assets_manifest.json"
        if not path.is_file():
            return {"official": 0, "items": 0}
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError):
            return {"official": 0, "items": 0}
        records = list(data.get("items", [])) + list(data.get("lead_readonly_records", []))
        return {"official": sum(1 for item in records if item.get("official") is True),
                "items": len(records)}

    def _project_stage(self, stage: str, facts: Dict[str, Any]) -> tuple:
        """一个阶段的 (状态, 证据路径, metadata 备注)。completed 的判据都在这里。"""
        project = self.project

        def relative(paths: Iterable[Path]) -> List[str]:
            return [str(path.relative_to(project)) for path in list(paths)[:50]]

        if stage == "source":
            evidence = facts["source_script"]
            return ("completed" if evidence else "pending", relative(evidence), {})
        if stage == "episodes":
            evidence = facts["episodes"]
            return ("completed" if evidence else "pending", relative(evidence),
                    {"episodes": len(evidence)})
        if stage == "style":
            evidence = facts["style_bible"]
            return ("completed" if evidence else "pending", relative(evidence), {})
        if stage == "asset_prompts":
            evidence = facts["manifest"]
            return ("completed" if evidence else "pending", relative(evidence), {})
        if stage == "asset_candidates":
            evidence = facts["candidate_images"]
            return ("completed" if evidence else "pending", relative(evidence),
                    {"candidate_images": len(evidence)})
        if stage == "official_assets":
            counts = self._official_counts()
            status = "completed" if counts["official"] else ("review" if counts["items"] else "pending")
            reconcile = project / "_probe" / "asset-reconcile.json"
            note = {"official": counts["official"], "items": counts["items"]}
            if reconcile.is_file():
                try:
                    note["reconcile_ready"] = bool(json.loads(reconcile.read_text(encoding="utf-8")).get("ready"))
                except (OSError, ValueError):
                    note["reconcile_ready"] = None
            return (status, relative(facts["manifest"]), note)
        # 后段阶段（脚本匹配 / 生成 / 审片 / 草稿 / 成片）是「整部剧」的口径：只有全部分集都
        # 走到这一步才算 completed，否则是 review（在推进中）。否则 3/50 集交付会让整个
        # 项目显示成「已导出」，比不写还误导。
        total = len(facts["episodes_with_text"])
        if stage == "shots_and_matches":
            scripts, matched = len(facts["episodes_with_script"]), len(facts["episodes_matched"])
            if total and matched >= total:
                status = "completed"
            elif scripts or matched:
                status = "review"
            else:
                status = "pending"
            return (status, relative(facts["scripts"] + facts["matched"]),
                    {"episodes_total": total, "scripts": scripts, "matched": matched})
        if stage == "video_tasks":
            generated, packed = len(facts["episodes_generated"]), len(facts["episodes_packed"])
            if total and generated >= total:
                status = "completed"
            elif generated or packed:
                status = "review"
            else:
                status = "pending"
            return (status, relative(facts["packs"]),
                    {"episodes_total": total, "packs": len(facts["packs"]),
                     "episodes_generated": generated, "episodes_packed": packed})
        if stage == "reviewed_videos":
            reviewed, evidence, missing = self._reviewed_sources(facts["episodes_with_text"])
            status = "completed" if total and not missing else ("review" if total or facts["cleaned"] else "pending")
            return (status, evidence, {"episodes_total": total, "episodes_reviewed": reviewed,
                                      "missing_evidence": missing})
        if stage in {'draft', 'export'}:
            try:
                videos = list((self.project / 'video').glob('*/shot_*.mp4'))
                if stage == 'export':
                    videos += facts['masters'] + facts['deliveries'] + list((self.project / 'exports').glob('*.mp4'))
                check_videos(self.project, videos)
            except (OSError, ValueError) as error:
                return ('blocked', [], {'video_bans': str(error)})
        if stage == "draft":
            draft_episodes = {path.name.split("-", 1)[0][2:] for path in facts["editing"]
                              if path.name.startswith("ep")}
            if total and len(draft_episodes) >= total:
                status = "completed"
            elif facts["editing"]:
                status = "review"
            else:
                status = "pending"
            return (status, relative(facts["editing"]),
                    {"episodes_total": total, "episodes_with_draft": len(draft_episodes),
                     "files": len(facts["editing"])})
        if stage == "export":
            rendered, delivered = len(facts["episodes_rendered"]), len(facts["episodes_delivered"])
            if total and delivered >= total:
                status = "completed"
            elif rendered:
                status = "review"
            else:
                status = "pending"
            return (status, relative(facts["masters"] + facts["deliveries"]),
                    {"episodes_total": total, "masters": len(facts["masters"]), "delivered": delivered})
        return ("pending", [], {})

    def project_stages(self, dry_run: bool = False) -> Dict[str, Any]:
        """按产物重算每个阶段的状态；人工设过的记录只报不动。"""
        facts = self._facts()
        summary: Dict[str, Any] = {}
        for stage in STAGES:
            current = self.data["stages"].get(stage, {})
            status, evidence, note = self._project_stage(stage, facts)
            manual = current.get("status_source") == "manual"
            summary[stage] = {"status": current.get("status") if manual else status,
                              "projected": status, "manual": manual, "note": note}
            if manual or dry_run:
                continue
            payload = record(status, error=current.get("error", ""), outputs=evidence,
                             metadata={**current.get("metadata", {}), **note})
            payload["status_source"] = "projection"
            self.data["stages"][stage] = payload
        if not dry_run:
            if not self.data.get("active", {}).get("stage"):
                pending = next((stage for stage in STAGES
                                if self.data["stages"][stage]["status"] != "completed"), "")
                self.data["active"] = {"stage": pending, "episode": "", "item": ""}
            self.save()
        return summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("project")
    parser.add_argument("command", choices=("init", "show", "set", "stale", "migrate", "audit", "sync"))
    parser.add_argument("--stage", choices=STAGES)
    parser.add_argument("--status", choices=sorted(STATUSES))
    parser.add_argument("--episode", default="")
    parser.add_argument("--item", default="")
    parser.add_argument("--error", default="")
    parser.add_argument("--output", action="append", default=[])
    args = parser.parse_args()
    state = PipelineState(args.project)
    if args.command == "init":
        state.save()
    elif args.command == "show":
        print(json.dumps(state.data, ensure_ascii=False, indent=2))
    elif args.command == "migrate":
        state.migrate_legacy()
    elif args.command == "audit":
        print(json.dumps(state.project_stages(dry_run=True), ensure_ascii=False, indent=2))
    elif args.command == "sync":
        print(json.dumps(state.project_stages(), ensure_ascii=False, indent=2))
    elif args.command == "set":
        if not args.stage or not args.status:
            parser.error("set requires --stage and --status")
        state.set(args.stage, args.status, args.episode, args.item, args.error, args.output)
    elif args.command == "stale":
        if not args.stage:
            parser.error("stale requires --stage")
        state.stale_from(args.stage, args.episode, args.error or "upstream input changed")


if __name__ == "__main__":
    main()
