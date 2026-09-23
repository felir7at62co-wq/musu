"""Archive local style references and validate reviewed evidence without network access."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

from asset_image_import import import_asset_image, validate_asset_name, _verify_image, MAX_IMAGE_BYTES


def _load(project: Path) -> dict:
    path = project / "asset_style_references.json"
    data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"schema_version": 1, "roles": {}}
    if not isinstance(data, dict) or data.get("schema_version") != 1 or not isinstance(data.get("roles"), dict):
        raise ValueError("Invalid asset_style_references.json")
    return data


def import_references(project: Path, role_id: str, name: str, role_class: str, images: list[Path]) -> None:
    """Preserve other roles; importing a replacement always resets review approval."""
    project = project.resolve()
    validate_asset_name(role_id)
    if not name.strip() or role_class not in {"lead", "important_support", "support", "extra"} or not images:
        raise ValueError("Provide a role and at least one user-supplied image")
    data = _load(project)
    records = []
    for source in images:
        if not source.is_file():
            raise ValueError(f"Missing user reference: {source}")
        if source.stat().st_size > MAX_IMAGE_BYTES:
            raise ValueError("Reference image exceeds 50 MB")
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        target = project / "assets" / "character" / f"reference_{digest}.png"
        if not target.resolve().is_relative_to(project):
            raise ValueError("Reference destination escapes project")
        archived = Path(import_asset_image(str(project), "character", f"reference_{digest}", str(source)))
        digest = hashlib.sha256(archived.read_bytes()).hexdigest()
        records.append({"note_id": f"local-{digest}", "source_url": "", "title": source.name,
                        "local_image_paths": [archived.relative_to(project).as_posix()],
                        "review_status": "pending_review", "review_reason": "",
                        "extracted_visual_elements": {}})
    data["roles"][role_id] = {"role_name": name, "role_class": role_class,
                              "queries": [], "style_reference_status": "pending_review",
                              "review_reason": "", "candidates": records}
    path = project / "asset_style_references.json"
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def _text(value) -> bool:
    return isinstance(value, str) and bool(value.strip())


def validate_role(project: Path, role: dict) -> None:
    """Reject empty approval, missing review, escaped paths and changed local evidence."""
    if not isinstance(role, dict) or role.get("style_reference_status") != "approved" or not _text(role.get("review_reason")):
        raise ValueError("Reference review and traceable user confirmation are required")
    candidates = role.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        raise ValueError("Approved reference evidence is empty")
    accepted = 0
    for candidate in candidates:
        if not isinstance(candidate, dict):
            raise ValueError("Invalid reference candidate")
        if candidate.get("review_status") == "rejected" and _text(candidate.get("review_reason")):
            continue
        elements = candidate.get("extracted_visual_elements")
        if (candidate.get("review_status") != "approved" or not _text(candidate.get("review_reason"))
                or not isinstance(elements, dict) or not elements or not all(_text(v) for v in elements.values())):
            raise ValueError("Each selected reference needs visual review and extracted elements")
        paths = candidate.get("local_image_paths")
        if not isinstance(paths, list) or not paths:
            raise ValueError("Reviewed reference needs local images")
        for value in paths:
            if not _text(value) or Path(value).is_absolute():
                raise ValueError("Reference image must be project-relative")
            path = (project / value).resolve()
            if not path.is_relative_to(project.resolve()) or not path.is_file():
                raise ValueError("Reference image is missing or escapes project")
            _verify_image(path)
            note_id = candidate.get("note_id", "")
            if not isinstance(note_id, str) or not note_id:
                raise ValueError("Reference identity is missing")
            if note_id.startswith("local-") and note_id != "local-" + hashlib.sha256(path.read_bytes()).hexdigest():
                raise ValueError("Reference image changed; repeat review and confirmation")
        accepted += 1
    if not accepted:
        raise ValueError("No approved reference images")


def check_references(project: Path, role_id: str) -> None:
    """Check a role before its paid generation; this does not authorize payment."""
    role = _load(project).get("roles", {}).get(role_id)
    validate_role(project, role)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", type=Path)
    parser.add_argument("role_id")
    commands = parser.add_subparsers(dest="command", required=True)
    add = commands.add_parser("import")
    add.add_argument("--name", required=True)
    add.add_argument("--role-class", choices=["lead", "important_support", "support", "extra"], required=True)
    add.add_argument("--image", type=Path, action="append", required=True)
    commands.add_parser("check")
    args = parser.parse_args()
    try:
        if args.command == "import":
            import_references(args.project, args.role_id, args.name, args.role_class, args.image)
        else:
            check_references(args.project, args.role_id)
    except (ValueError, OSError) as exc:
        parser.exit(1, f"{exc}\n")
    print("pending_review" if args.command == "import" else "reference_evidence_checked")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
