#!/usr/bin/env python3
"""Download + vision-tag all usable parent assets from a target Jubian project."""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(os.environ.get("JUBIAN_ASSET_LIBRARY_ROOT") or Path(os.environ.get("DSH_HOME") or Path.home() / ".dsh") / "data" / "jubian-asset-library").expanduser()
INDEX = ROOT / "index"
MEDIA = ROOT / "media"

TAG_PROMPT = """你是短剧资产标注员。看这张图，输出严格 JSON（不要 markdown 代码块），字段如下：

{
  "style": "realistic" 或 "3d",
  "type": "character" | "scene" | "prop",
  "gender": "male"|"female"|"mixed"|"none"，仅人物,
  "age_group": "child"|"teen"|"young"|"middle"|"senior"|"unknown"，仅人物,
  "clothing": "简短中文，服装风格/颜色/款式",
  "identity_hint": "简短中文，像什么身份/职业（如 总裁/村妇/服务生），不确定填空字符串",
  "scene_kind": "indoor"|"outdoor"|"none"，场景用,
  "place_hint": "简短中文，场所（如 餐厅/办公室/农村院子），非场景填空字符串",
  "prop_category": "简短中文，道具类别（如 证件/家具/食物/车辆），非道具填空字符串",
  "has_text": true/false，画面内是否有可读文字,
  "text_content": "若 has_text 为 true，写出可读文字；否则空字符串",
  "reusable": true/false，是否适合作为可复用的定妆/场景/道具资产（构图完整、无水印、身份清晰）,
  "quality_note": "简短中文，质量问题（模糊/裁切/多余杂物/风格不符），没问题填空字符串",
  "tags": ["3-6个中文检索标签，如 西装/餐厅/夜晚/特写"]
}

只输出 JSON 本身。"""


def load_key() -> str:
    key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not key:
        raise SystemExit("DEEPSEEK_API_KEY is required for paid vision tagging")
    return key


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


def download(url: str, dest: Path) -> bool:
    if dest.exists() and dest.stat().st_size > 1000:
        return True
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "muse-asset-lib/1.0"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = resp.read()
        if len(data) < 1000:
            return False
        dest.write_bytes(data)
        return True
    except Exception as e:
        print(f"    download fail: {e}")
        return False


def call_vision(api_key: str, image_path: Path, style_hint: str, type_hint: str):
    data = image_path.read_bytes()
    ext = image_path.suffix.lower().lstrip(".")
    mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp"}.get(
        ext, "image/jpeg"
    )
    b64 = base64.b64encode(data).decode("ascii")
    user_text = f"参考元数据（可能不准，以图为准）：style={style_hint}, type={type_hint}。\n" + TAG_PROMPT
    body = {
        "model": "deepseek-v4-flash-vision-exp",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_text},
                    {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
                ],
            }
        ],
        "temperature": 0.1,
        "max_tokens": 800,
        "response_format": {"type": "json_object"},
    }
    req = urllib.request.Request(
        "https://api.deepseek.com/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    content = payload["choices"][0]["message"]["content"]
    usage = payload.get("usage") or {}
    try:
        tags = json.loads(content)
    except json.JSONDecodeError:
        s = content.find("{")
        e = content.rfind("}")
        tags = json.loads(content[s : e + 1])
    return tags, usage


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--script-id", type=int, default=2708)
    ap.add_argument("--max", type=int, default=0, help="0 = all")
    args = ap.parse_args()

    api_key = load_key()
    assets = [
        a
        for a in load_jsonl(INDEX / "assets.jsonl")
        if int(a.get("script_id") or 0) == args.script_id and a.get("usable") and a.get("url")
    ]
    if args.max:
        assets = assets[: args.max]
    print(f"project {args.script_id}: {len(assets)} usable assets")

    done_tags = set()
    tags_path = INDEX / "tags.jsonl"
    for r in load_jsonl(tags_path):
        try:
            done_tags.add(int(r["asset_id"]))
        except Exception:
            pass

    MEDIA.mkdir(parents=True, exist_ok=True)
    ok_d = fail_d = ok_t = fail_t = skip = 0
    total_in = total_out = 0

    for i, a in enumerate(assets, 1):
        aid = int(a["asset_id"])
        url = a["url"]
        ext = "jpg"
        if ".png" in url.lower():
            ext = "png"
        elif ".jpeg" in url.lower():
            ext = "jpeg"
        dest = MEDIA / f"a{aid}.{ext}"

        # download
        if dest.exists() and dest.stat().st_size > 1000:
            skip += 1
        else:
            if download(url, dest):
                ok_d += 1
            else:
                fail_d += 1
                print(f"  [{i}/{len(assets)}] download FAIL id={aid}")
                continue

        # tag
        if aid in done_tags:
            continue
        try:
            tags, usage = call_vision(api_key, dest, a.get("style_label", ""), a.get("asset_type_label", ""))
            rec = {
                "asset_id": aid,
                "script_id": a.get("script_id"),
                "project_name": a.get("project_name"),
                "asset_name": a.get("asset_name"),
                "local_path": str(dest),
                "meta_style": a.get("style_label"),
                "meta_type": a.get("asset_type_label"),
                "prompt_excerpt": (a.get("prompt") or "")[:200],
                "tags": tags,
                "usage": usage,
            }
            with tags_path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            ok_t += 1
            total_in += usage.get("prompt_tokens") or 0
            total_out += usage.get("completion_tokens") or 0
            print(
                f"  [{i}/{len(assets)}] tagged id={aid} {tags.get('style')}/{tags.get('type')} "
                f"reusable={tags.get('reusable')} name={a.get('asset_name','')[:20]}"
            )
        except Exception as e:
            fail_t += 1
            print(f"  [{i}/{len(assets)}] tag FAIL id={aid}: {e}")
        time.sleep(0.25)

    print()
    print(f"DONE download ok={ok_d} fail={fail_d} already={skip}")
    print(f"     tag ok={ok_t} fail={fail_t} tokens in={total_in} out={total_out}")
    print(f"media: {MEDIA}")
    print(f"tags:  {tags_path}")


if __name__ == "__main__":
    main()
