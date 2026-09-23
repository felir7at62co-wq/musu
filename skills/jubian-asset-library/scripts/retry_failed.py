#!/usr/bin/env python3
"""Retry failed downloads/tags for specific asset ids."""
from __future__ import annotations

import base64
import json
import sys
import time
import urllib.request
from pathlib import Path

from download_and_tag_project import ROOT, TAG_PROMPT, load_key

INDEX = ROOT / "index"
MEDIA = ROOT / "media"


def load_jsonl(p: Path):
    if not p.exists():
        return []
    out = []
    with p.open(encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return out


def download(url: str, dest: Path) -> bool:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "muse-asset-lib/1.0"})
        with urllib.request.urlopen(req, timeout=90) as resp:
            data = resp.read()
        if len(data) < 1000:
            return False
        dest.write_bytes(data)
        return True
    except Exception as e:
        print(f"  dl err: {e}")
        return False


def call_vision(key: str, path: Path, style: str, atype: str):
    data = path.read_bytes()
    ext = path.suffix.lower().lstrip(".")
    mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png"}.get(ext, "image/jpeg")
    b64 = base64.b64encode(data).decode("ascii")
    body = {
        "model": "deepseek-v4-flash-vision-exp",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": f"参考元数据 style={style}, type={atype}。\n" + TAG_PROMPT},
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
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    content = payload["choices"][0]["message"]["content"]
    usage = payload.get("usage") or {}
    try:
        tags = json.loads(content)
    except json.JSONDecodeError:
        s, e = content.find("{"), content.rfind("}")
        tags = json.loads(content[s : e + 1])
    return tags, usage


def main():
    ids = [int(x) for x in sys.argv[1:]] or [83372, 81686, 80475, 80471]
    key = load_key()
    assets = {int(a["asset_id"]): a for a in load_jsonl(INDEX / "assets.jsonl")}
    tagged = set()
    for r in load_jsonl(INDEX / "tags.jsonl"):
        try:
            tagged.add(int(r["asset_id"]))
        except Exception:
            pass

    ok_t = fail_t = 0
    for aid in ids:
        a = assets.get(aid)
        if not a:
            print(f"id {aid} not in assets.jsonl")
            continue
        url = a.get("url") or ""
        ext = "png" if ".png" in url.lower() else "jpg"
        dest = MEDIA / f"a{aid}.{ext}"

        if not (dest.exists() and dest.stat().st_size > 1000):
            print(f"downloading {aid} {a.get('asset_name')}")
            if not download(url, dest):
                print(f"  FAIL download {aid}")
                continue

        if aid in tagged:
            print(f"already tagged {aid}")
            continue

        try:
            tags, usage = call_vision(key, dest, a.get("style_label", ""), a.get("asset_type_label", ""))
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
            with (INDEX / "tags.jsonl").open("a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            ok_t += 1
            print(f"  tagged {aid} {tags.get('style')}/{tags.get('type')} reusable={tags.get('reusable')}")
        except Exception as e:
            fail_t += 1
            print(f"  FAIL tag {aid}: {e}")
        time.sleep(0.4)

    print(f"\nretry done ok={ok_t} fail={fail_t}")


if __name__ == "__main__":
    main()
