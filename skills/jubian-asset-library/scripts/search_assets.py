#!/usr/bin/env python3
"""Search Jubian asset library by style/type/text/tags. Read-only."""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(os.environ.get("JUBIAN_ASSET_LIBRARY_ROOT") or Path(os.environ.get("DSH_HOME") or Path.home() / ".dsh") / "data" / "jubian-asset-library").expanduser()
INDEX = ROOT / "index"


def load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows = []
    with path.open(encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return rows


def load_assets() -> list[dict]:
    return load_jsonl(INDEX / "assets.jsonl")


def load_tags() -> dict[int, dict]:
    out = {}
    for r in load_jsonl(INDEX / "tags.jsonl"):
        try:
            out[int(r["asset_id"])] = r
        except Exception:
            pass
    return out


def tokenize(q: str) -> list[str]:
    q = (q or "").strip().lower()
    if not q:
        return []
    parts = re.split(r"[\s,，、;；/|+]+", q)
    toks = [p for p in parts if p]
    # CJK bigrams for partial recall (e.g. 花瓶 from 蓝色花瓶)
    cjk_runs = re.findall(r"[一-鿿]{2,}", q)
    for run in cjk_runs:
        if len(run) >= 3:
            toks.append(run)
            for i in range(len(run) - 1):
                toks.append(run[i : i + 2])
    # dedupe preserving order
    seen = set()
    out = []
    for t in toks:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out


def score_row(
    row: dict,
    tag: dict | None,
    toks: list[str],
    query: str,
    prefer_project: str,
    avoid_text: bool,
) -> float:
    score = 0.0
    name = (row.get("asset_name") or "").lower()
    prompt = (row.get("prompt") or "").lower()
    project = (row.get("project_name") or "").lower()
    q = (query or "").strip().lower()

    bag_parts = [name, prompt, project]
    tag_list = ""
    if tag:
        t = tag.get("tags") or {}
        for k in (
            "identity_hint",
            "clothing",
            "place_hint",
            "prop_category",
            "text_content",
            "quality_note",
            "gender",
            "age_group",
            "scene_kind",
        ):
            bag_parts.append(str(t.get(k) or "").lower())
        tag_list = " ".join(t.get("tags") or []).lower()
        bag_parts.append(tag_list)
    bag = " ".join(bag_parts)

    # phrase / full-query match is the strongest signal
    if q and len(q) >= 2:
        if q in name:
            score += 25
        if tag_list and q in tag_list:
            score += 12
        if q in bag:
            score += 4

    for tok in toks:
        if len(tok) < 2:
            continue
        if tok == name or tok in name:
            # exact-ish name hit
            score += 10 if tok in name else 6
        if tag_list and tok in tag_list:
            score += 7
        if tag:
            t = tag.get("tags") or {}
            for field in ("identity_hint", "clothing", "place_hint", "prop_category"):
                if tok in str(t.get(field) or "").lower():
                    score += 4
                    break
        if tok in bag:
            score += 2
        if tok in prompt:
            score += 1

    # prefer a specific source project (e.g. the target drama)
    if prefer_project:
        pref = prefer_project.strip().lower()
        if pref and (pref in project or pref == str(row.get("script_id"))):
            score += 15

    if tag:
        t = tag.get("tags") or {}
        if t.get("reusable") is True:
            score += 1.5
        if avoid_text and t.get("has_text") is True:
            score -= 2
        qn = (t.get("quality_note") or "").strip()
        if qn:
            score -= 0.5

    if row.get("usable"):
        score += 0.5
    return score


def main() -> None:
    ap = argparse.ArgumentParser(description="Search Jubian asset library")
    ap.add_argument("--style", default="all", choices=["realistic", "3d", "all"])
    ap.add_argument(
        "--type",
        default="all",
        choices=["character", "scene", "prop", "all"],
        dest="atype",
    )
    ap.add_argument("--q", default="", help="free text query")
    ap.add_argument("--gender", default="", choices=["", "male", "female", "mixed", "none"])
    ap.add_argument(
        "--age",
        default="",
        choices=["", "child", "teen", "young", "middle", "senior", "unknown"],
    )
    ap.add_argument("--reusable", default="prefer", choices=["true", "false", "all", "prefer"])
    ap.add_argument("--limit", type=int, default=10)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--avoid-text", action="store_true", help="penalize has_text=true")
    ap.add_argument("--require-local", action="store_true", help="only rows with local media")
    ap.add_argument(
        "--prefer-project",
        default="",
        help="boost assets whose project name or script_id matches (e.g. 山海自有相逢处 or 2708)",
    )
    args = ap.parse_args()

    assets = load_assets()
    tags = load_tags()
    toks = tokenize(args.q)

    rows = []
    for a in assets:
        if not a.get("usable") and not a.get("url"):
            continue
        if args.style != "all" and a.get("style_label") != args.style:
            continue
        if args.atype != "all" and a.get("asset_type_label") != args.atype:
            continue
        tag = tags.get(int(a.get("asset_id") or 0))
        if args.gender or args.age or args.reusable in ("true", "false"):
            if not tag:
                # untagged rows only pass if no tag-based filter
                if args.gender or args.age or args.reusable in ("true", "false"):
                    continue
        if tag:
            t = tag.get("tags") or {}
            if args.gender and t.get("gender") != args.gender:
                continue
            if args.age and t.get("age_group") != args.age:
                continue
            if args.reusable == "true" and t.get("reusable") is not True:
                continue
            if args.reusable == "false" and t.get("reusable") is not False:
                continue
        if args.require_local:
            lp = (tag or {}).get("local_path") or ""
            if not lp or not Path(lp).exists():
                continue
        sc = score_row(
            a, tag, toks, args.q, args.prefer_project, args.avoid_text
        )
        if toks and sc <= 0:
            continue
        rows.append((sc, a, tag))

    rows.sort(key=lambda x: x[0], reverse=True)
    rows = rows[: args.limit]

    if args.json:
        out = []
        for sc, a, tag in rows:
            t = (tag or {}).get("tags") or {}
            out.append(
                {
                    "score": round(sc, 2),
                    "asset_id": a.get("asset_id"),
                    "project": a.get("project_name"),
                    "style": a.get("style_label"),
                    "type": a.get("asset_type_label"),
                    "name": a.get("asset_name"),
                    "gender": t.get("gender"),
                    "age": t.get("age_group"),
                    "identity": t.get("identity_hint"),
                    "clothing": t.get("clothing"),
                    "place": t.get("place_hint"),
                    "prop_category": t.get("prop_category"),
                    "reusable": t.get("reusable"),
                    "tags": t.get("tags"),
                    "local_path": (tag or {}).get("local_path"),
                    "url": a.get("url"),
                    "script_id": a.get("script_id"),
                    "prompt_excerpt": (a.get("prompt") or "")[:160],
                }
            )
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return

    if not rows:
        print("no matches")
        return

    print(
        f"{'score':>5}  {'id':>7}  {'style':<9} {'type':<9} {'name':<28}  {'identity/place':<22}  tags"
    )
    print("-" * 110)
    for sc, a, tag in rows:
        t = (tag or {}).get("tags") or {}
        ident = t.get("identity_hint") or t.get("place_hint") or t.get("prop_category") or ""
        tagstr = ",".join((t.get("tags") or [])[:4])
        name = (a.get("asset_name") or "")[:28]
        print(
            f"{sc:5.1f}  {a.get('asset_id'):>7}  {a.get('style_label'):<9} "
            f"{a.get('asset_type_label'):<9} {name:<28}  {ident[:22]:<22}  {tagstr}"
        )
        lp = (tag or {}).get("local_path")
        if lp:
            print(f"       local: {lp}")


if __name__ == "__main__":
    main()
