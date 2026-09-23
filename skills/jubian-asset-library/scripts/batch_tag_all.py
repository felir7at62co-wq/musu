#!/usr/bin/env python3
"""Batch download + vision-tag all usable Jubian assets not yet tagged. Resume-safe."""
from __future__ import annotations

import argparse
import base64
import json
import os
import time
import urllib.request
from pathlib import Path

ROOT = Path(os.environ.get("JUBIAN_ASSET_LIBRARY_ROOT") or Path(os.environ.get("DSH_HOME") or Path.home() / ".dsh") / "data" / "jubian-asset-library").expanduser()
INDEX = ROOT / "index"
MEDIA = ROOT / "media"
LOG = INDEX / "batch-tag-log.txt"

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


def log(msg: str) -> None:
    line = f"{time.strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def load_key() -> str:
    key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not key:
        raise SystemExit("DEEPSEEK_API_KEY is required for paid vision tagging")
    return key


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
    if dest.exists() and dest.stat().st_size > 1000:
        return True
    for attempt in range(2):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "muse-asset-lib/1.0"})
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = resp.read()
            if len(data) < 1000:
                return False
            dest.write_bytes(data)
            return True
        except Exception as e:
            if attempt == 1:
                log(f"    dl fail: {e}")
                return False
            time.sleep(1.5)
    return False


def call_vision(key: str, path: Path, style: str, atype: str):
    data = path.read_bytes()
    ext = path.suffix.lower().lstrip(".")
    mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp"}.get(
        ext, "image/jpeg"
    )
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
    tags = parse_json_robust(content)
    return tags, usage


def parse_json_robust(content: str) -> dict:
    """Parse model JSON, tolerating truncation and stray characters."""
    text = (content or "").strip()
    # strip markdown fences
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    s, e = text.find("{"), text.rfind("}")
    if s >= 0 and e > s:
        frag = text[s : e + 1]
        try:
            return json.loads(frag)
        except json.JSONDecodeError:
            # close unterminated strings / drop trailing comma
            fixed = frag
            # if string never closed, close it before last }
            if fixed.count('"') % 2 == 1:
                fixed = fixed[: fixed.rfind("}")] + '"}'
            fixed = fixed.replace(",}", "}").replace(",]", "]")
            try:
                return json.loads(fixed)
            except json.JSONDecodeError:
                pass
    raise ValueError(f"unparseable model JSON ({len(text)} chars)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch-size", type=int, default=200, help="stop after N new tags (0=all)")
    ap.add_argument("--skip-download", action="store_true", help="only tag already-downloaded files")
    args = ap.parse_args()

    key = load_key()
    assets = [a for a in load_jsonl(INDEX / "assets.jsonl") if a.get("usable") and a.get("url")]
    tagged = set()
    for r in load_jsonl(INDEX / "tags.jsonl"):
        try:
            tagged.add(int(r["asset_id"]))
        except Exception:
            pass

    todo = [a for a in assets if int(a["asset_id"]) not in tagged]
    log(f"usable={len(assets)} tagged={len(tagged)} todo={len(todo)}")
    if args.batch_size:
        todo = todo[: args.batch_size]
        log(f"batch limited to {len(todo)}")

    MEDIA.mkdir(parents=True, exist_ok=True)
    ok = fail = skip = 0
    tin = tout = 0
    t0 = time.time()

    for i, a in enumerate(todo, 1):
        aid = int(a["asset_id"])
        url = a["url"]
        ext = "jpg"
        if ".png" in url.lower():
            ext = "png"
        elif ".jpeg" in url.lower():
            ext = "jpeg"
        dest = MEDIA / f"a{aid}.{ext}"

        if not args.skip_download:
            if dest.exists() and dest.stat().st_size > 1000:
                skip += 1
            else:
                if not download(url, dest):
                    fail += 1
                    continue

        if not dest.exists():
            fail += 1
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
            tagged.add(aid)
            ok += 1
            tin += usage.get("prompt_tokens") or 0
            tout += usage.get("completion_tokens") or 0
            if ok % 20 == 0:
                elapsed = time.time() - t0
                rate = ok / elapsed if elapsed else 0
                remain = (len(todo) - i) / rate if rate else 0
                log(
                    f"[{i}/{len(todo)}] ok={ok} fail={fail} skip={skip} "
                    f"tok_in={tin} tok_out={tout} eta_min={remain/60:.0f}"
                )
        except Exception as e:
            fail += 1
            if fail <= 10 or fail % 20 == 0:
                log(f"[{i}/{len(todo)}] tag FAIL id={aid}: {e}")
        time.sleep(0.2)

    elapsed = time.time() - t0
    log(f"BATCH DONE ok={ok} fail={fail} skip={skip} elapsed_min={elapsed/60:.1f}")
    log(f"tokens in={tin} out={tout}")
    log(f"total tagged now: {len(tagged)}")


if __name__ == "__main__":
    main()
