#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按用户本机的「+++交付模板」组装**整部剧**的交付目录。

一个项目一份模板：`<项目>\\delivery\\` 本身就是模板的 9 个目录骨架，不是每集一套。
每跑一次就是把一集追加/更新进同一个 `00成片\\`（`01.mp4`、`02.mp4`……）；
`01主角\\`、`02海报\\`、`05剧本&简介\\` 是整部剧只放一次的东西。

只做归集：读项目里的成片、主角图、海报、原剧本与简介，写出到交付目录。
不生成图片、不调剧变、不重渲成片、不改上游产物；模板目录只读。

内部控制文件放在 <项目>\\_probe\\delivery-config\\，不放交付根污染结构：
  _confirmed_episodes.json（门禁账本）、confirmed-films.json（母版映射）、主角.json、简介.txt
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import stat
import subprocess
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tweet-drama-core' / 'scripts'))
from video_bans import check_videos

TEMPLATE = Path(__file__).resolve().parents[1] / "assets" / "template.json"
SKELETON = json.loads(TEMPLATE.read_text(encoding="utf-8"))
OURS = {"00成片", "01主角", "02海报", "05剧本&简介"}
# 不由本流水线填：显式跳过并打印，不往里塞东西
NOT_OURS = {
    "03资产": "用户口径：不用管（资产图只进 01主角）",
    "04精彩片段": "用户口径：不用管",
    "06AI工程文件": "用户口径：不用管",
    "07剪映工程截图": "用户口径：不用管",
    "08第X集是付费点": "用户口径：不用管",
}
SYNOPSIS_LIMIT = 200  # 去空白后的字符数；必须严格少于
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp"}
POSTER_HINT = ("海报", "poster")
FILM_RE = re.compile(r"^\d{2}\.mp4$")  # 00成片 里只认 01.mp4、02.mp4……


def die(msg: str) -> None:
    print(f"[失败] {msg}", file=sys.stderr)
    raise SystemExit(2)


def config_dir(project: Path) -> Path:
    return project / "_probe" / "delivery-config"


def find_ffprobe() -> str | None:
    for env in ("MUSE_FFPROBE_EXECUTABLE", "DSH_FFPROBE", "FFPROBE_PATH"):
        p = os.environ.get(env)
        if p and Path(p).is_file():
            return p
    found = shutil.which("ffprobe")
    if found:
        return found
    for env in ("MUSE_FFMPEG_EXECUTABLE", "FFMPEG_PATH"):
        p = os.environ.get(env)
        if p:
            cand = Path(p).with_name("ffprobe.exe" if os.name == "nt" else "ffprobe")
            if cand.is_file():
                return str(cand)
    return None


def probe(path: Path, ffprobe: str | None) -> dict:
    """读成片的真实分辨率、帧率、时长与码率；读不到就如实记录，不猜。"""
    if not ffprobe:
        return {"ok": False, "error": "找不到 ffprobe（设 MUSE_FFPROBE_EXECUTABLE 或加进 PATH）"}
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height,r_frame_rate:format=duration,bit_rate",
             "-of", "json", str(path)],
            capture_output=True, text=True, encoding="utf-8", timeout=120, check=True,
        ).stdout
        data = json.loads(out)
        st = (data.get("streams") or [{}])[0]
        num, _, den = (st.get("r_frame_rate") or "0/1").partition("/")
        return {
            "ok": True,
            "width": st.get("width"),
            "height": st.get("height"),
            "fps": round(float(num) / float(den or 1), 3),
            "duration_s": round(float(data["format"]["duration"]), 3),
            "bit_rate_bps": int(data["format"].get("bit_rate") or 0),
        }
    except Exception as exc:  # ffprobe 的失败模式很多，原样带出去
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}


def read_config(project: Path, name: str) -> dict:
    path = config_dir(project) / name
    if not path.is_file():
        die(
            f"缺少内部控制文件 {path}。\n"
            f"      这些文件放在 _probe\\delivery-config\\，不放交付根——交付根只放模板的 9 个目录。"
        )
    return json.loads(path.read_text(encoding="utf-8"))


def check_gate(project: Path, episode: int) -> dict:
    """门禁：只有用户确认通过的集才组装交付。没登记就不碰磁盘。"""
    confirmed = read_config(project, "_confirmed_episodes.json")
    for rec in confirmed.get("confirmed", []):
        if int(rec.get("episode", -1)) == episode:
            return rec
    listed = [r.get("episode") for r in confirmed.get("confirmed", [])]
    die(
        f"第 {episode} 集不在确认记录里（已登记：{listed or '空'}）。\n"
        f"      门禁：只有用户确认通过的集才组装交付。\n"
        f"      用户说“第{episode}集过了”之后，才在 "
        f"_probe\\delivery-config\\_confirmed_episodes.json 追加 "
        f'{{"episode": {episode}, "confirmed_by": "用户", "date": "YYYY-MM-DD"}}。'
    )


def film_candidates(project: Path, episode: int) -> str:
    """列出 export 下这一集的全部候选，供拒绝时报告——只报不挑。"""
    export = project / "export"
    hits: set[Path] = set()
    if export.is_dir():
        for tag in {f"第{episode}集", f"第{episode:02d}集"}:  # 剧名里两种写法都有
            hits.update(p for p in export.glob(f"*{tag}*.mp4") if p.is_file())
    cands = sorted(p.name for p in hits)
    if not cands:
        return f"\n      export 下也没有第 {episode} 集的候选。"
    return (
        f"\n      export 下第 {episode} 集的候选（{len(cands)} 个，脚本不挑，请人工指定）："
        + "".join(f"\n        - {c}" for c in cands)
    )


def pick_master(project: Path, episode: int) -> Path:
    """成片只认 confirmed-films.json 里显式写出的那一份母版。

    同一集在 export\\ 下常有多份母版，用户确认的是具体文件而不是集号，所以这里绝不自行挑选：
    映射缺了、或映射指向的文件不存在，都直接失败。
    """
    mapping = config_dir(project) / "confirmed-films.json"
    if not mapping.is_file():
        die(
            f"缺少成片确认映射 {mapping}。\n"
            f"      用户确认的是该集的具体母版文件，不是一个集号——脚本不替你挑母版。\n"
            '      写法：{"films": {"01": "export\\\\<剧名>_第01集_成片.mp4"}}'
            + film_candidates(project, episode)
        )
    films = json.loads(mapping.read_text(encoding="utf-8")).get("films", {})
    entry = next((films[k] for k in (f"{episode:02d}", str(episode)) if k in films), None)
    if entry is None:
        die(
            f"{mapping} 的 films 里没有第 {episode} 集（现有：{sorted(films) or '空'}）。\n"
            f"      确认过具体母版才登记；脚本不替你挑。" + film_candidates(project, episode)
        )
    source = entry.get("source") if isinstance(entry, dict) else entry
    if not isinstance(source, str) or not source:
        die(f'films["{episode:02d}"] 要是路径字符串，或含 source 的对象：{entry!r}')
    master = Path(source)
    if not master.is_absolute():
        master = project / master
    if not master.is_file():
        die(
            f"映射指向的母版不存在：{master}\n"
            f'      films["{episode:02d}"] = {source!r}' + film_candidates(project, episode)
        )
    check_videos(project, [master])
    return master


def pick_leads(project: Path) -> list[dict]:
    """主角按 _probe\\delivery-config\\主角.json 的人工声明取（整部剧只放一次）。

    项目里没有任何机器可读的性别字段（assets_manifest.json 的 state_or_costume 是服装描述，
    角色名也不带性别），所以性别必须由人声明一次；脚本不从文件名或文案猜，声明不全就报错。
    """
    decl = config_dir(project) / "主角.json"
    if not decl.is_file():
        die(
            f"缺少主角声明 {decl}。\n"
            f"      01主角 必须一男一女，性别得有人说了算——脚本不从文件名或文案猜。\n"
            '      写法：{"male": ["lead_陆沉舟_asset83749_material81322.png"], '
            '"female": ["lead_沈知意_asset81677_material79284.png"]}'
        )
    data = json.loads(decl.read_text(encoding="utf-8"))
    pool = {p.name: p for p in (project / "assets").rglob("lead_*.png") if p.is_file()}
    leads: list[dict] = []
    for gender, key in (("男", "male"), ("女", "female")):
        names = data.get(key) or []
        if not names:
            die(f"主角声明缺 {key}（{gender}）——01主角 必须一男一女：{decl}")
        for name in names:
            if name not in pool:
                die(
                    f"主角声明里的 {key}「{name}」在 assets 下找不到。\n"
                    f"      现有 lead_*.png：{sorted(pool) or '无'}"
                )
            leads.append({"path": pool[name], "gender": gender})
    if len(leads) > 2:
        print(f"[提示] 主角图 {len(leads)} 张（男女双主全放）。")
    return leads


def pick_posters(project: Path) -> list[Path]:
    """整部剧的海报（不是每集海报），6 个比例：1:1、16:9、9:16、2:3、3:4、7:10。有就放。"""
    hits: set[Path] = set()
    for root in (project / "export", project / "assets"):
        if not root.is_dir():
            continue
        for p in root.rglob("*"):
            if p.is_file() and p.suffix.lower() in IMAGE_EXT and any(h in p.name.lower() for h in POSTER_HINT):
                hits.add(p)
    return sorted(hits)


def pick_synopsis(project: Path) -> tuple[bytes, int]:
    """简介主本按字节原样分发（不做换行转换，交付副本与主本逐字节相同）。"""
    master = config_dir(project) / "简介.txt"
    if not master.is_file():
        die(f"缺少简介主本 {master}。先在项目里起草一份（中文、去空白后少于 {SYNOPSIS_LIMIT} 字）。")
    raw = master.read_bytes()
    count = len(re.sub(r"\s", "", raw.decode("utf-8")))
    if count >= SYNOPSIS_LIMIT:
        die(f"简介 {count} 字，必须少于 {SYNOPSIS_LIMIT} 字（按去空白字符数算）：{master}")
    return raw, count


def pick_original_script(project: Path) -> list[Path]:
    src = project / "source" / "original"
    files = sorted(p for p in src.rglob("*") if p.is_file()) if src.is_dir() else []
    if not files:
        die(f"找不到原剧本：{src} 下没有文件。")
    return files


def sync_dir(target_dir: Path, targets: dict[str, Path], label: str) -> None:
    """把目录同步成 targets 声明的那些文件：多的删掉并打印，少的补上。"""
    target_dir.mkdir(exist_ok=True)
    for stale in sorted(p for p in target_dir.iterdir() if p.is_file() and p.name not in targets):
        stale.unlink()
        print(f"[{label}] 清掉不再需要的 {stale.name}")
    for name, src in sorted(targets.items()):
        shutil.copy2(src, target_dir / name)
        print(f"[{label}] {name}  <-  {src.name}  ({src.stat().st_size:,} 字节)")


def main() -> int:
    ap = argparse.ArgumentParser(description="按 +++交付模板 组装整部剧的交付目录")
    ap.add_argument("--project", required=True, help="项目目录")
    ap.add_argument("--episode", required=True, help="要追加/更新的集号，1 与 01 都行")
    ap.add_argument("--out", default=None, help="交付目录，默认 <项目>\\delivery")
    args = ap.parse_args()

    project = Path(args.project).expanduser().resolve()
    if not project.is_dir():
        die(f"项目目录不存在：{project}")
    try:
        episode = int(args.episode)
    except ValueError:
        die(f"--episode 要是集号：{args.episode!r}")
    if episode < 1:
        die(f"--episode 要从 1 开始：{episode}")

    override = os.environ.get("TWEET_DRAMA_TEMPLATE")
    if override is not None and (not override.strip() or not Path(override).expanduser().is_dir()):
        die(f"模板目录不存在：{override}（TWEET_DRAMA_TEMPLATE）")

    # 门禁先行：没确认就不碰磁盘
    rec = check_gate(project, episode)

    out = (Path(args.out).expanduser() if args.out else project / "delivery").resolve()
    if project.is_relative_to(out) or (out.is_relative_to(project) and not out.is_relative_to(project / "delivery")):
        die("交付输出与项目/上游重叠；项目内仅允许 delivery 子树，或使用独立外部目录")
    if out.exists():
        for path in out.rglob("*"):
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode) or (os.name == "nt" and info.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT):
                die(f"交付目录含链接，拒绝写入：{path}")
    film_name = f"{episode:02d}.mp4"

    # 00成片 里只认 NN.mp4，别的文件先报出来，别把上游母版悄悄删了
    shot = out / "00成片"
    strays = (
        sorted(p.name for p in shot.iterdir() if p.is_file() and not FILM_RE.match(p.name))
        if shot.is_dir() else []
    )
    if strays:
        die(f"00成片 里有不符合 NN.mp4 命名的文件：{strays}\n      请先人工确认（脚本不删它们）。")

    master = pick_master(project, episode)
    leads = pick_leads(project)
    posters = pick_posters(project)
    synopsis, synopsis_count = pick_synopsis(project)
    originals = pick_original_script(project)
    sources = [master, *(x["path"] for x in leads), *posters, *originals, config_dir(project), TEMPLATE]
    if override is not None:
        sources.append(Path(override).expanduser())
    for source in sources:
        source = source.resolve()
        if source.is_relative_to(out) or out.is_relative_to(source):
            die(f"交付输出与上游来源重叠：{source}")

    print(f"项目   {project}")
    print(f"第 {episode} 集  确认人 {rec.get('confirmed_by', '?')}  日期 {rec.get('date', '?')}")
    print(f"交付   {out}")
    print(f"模板   {TEMPLATE}")
    print()

    # 1) 模板骨架：交付根本身就是那 9 个目录
    out.mkdir(parents=True, exist_ok=True)
    for name in SKELETON:
        (out / name).mkdir(exist_ok=True)
    print(f"[骨架] 模板 {len(SKELETON)} 个目录 -> {out}")

    # 2) 00成片 —— 追加/更新这一集，文件名就是 <集号>.mp4
    shutil.copy2(master, shot / film_name)
    print(f"[00成片] {film_name}  <-  {master.name}  ({master.stat().st_size:,} 字节，逐字节复制)")

    # 3) 01主角 —— 整部剧一男一女，只放一次
    print("[01主角] " + "、".join(f"{x['gender']} {x['path'].name}" for x in leads))
    sync_dir(out / "01主角", {x["path"].name: x["path"] for x in leads}, "01主角")

    # 4) 02海报 —— 整部剧的海报，有就放
    if posters:
        sync_dir(out / "02海报", {p.name: p for p in posters}, "02海报")
    else:
        (out / "02海报").mkdir(exist_ok=True)
        print("[02海报] 缺：项目里没有整部剧的海报（名字含「海报」/poster 的图片一张都没有）。留空，不伪造。")

    # 5) 05剧本&简介 —— 原剧本 + 简介，整部剧各一份
    sync_dir(out / "05剧本&简介", {p.name: p for p in originals}, "05剧本&简介")
    (out / "05剧本&简介" / "简介.txt").write_bytes(synopsis)
    print(f"[05剧本&简介] 简介.txt  {synopsis_count} 字（上限 {SYNOPSIS_LIMIT}，去空白）")

    # 6) 其余 5 个：显式跳过
    print()
    for name, why in NOT_OURS.items():
        print(f"[跳过] {name} —— {why}")

    # 7) 自检：重读写出的目录，再报一遍
    print()
    ffprobe = find_ffprobe()
    report = {
        "episode": episode,
        "out": str(out),
        "template": str(TEMPLATE),
        "config_dir": str(config_dir(project)),
        "assembled_at": datetime.now().isoformat(timespec="seconds"),
        "confirmed": rec,
        "film": {"name": film_name, "source": str(master)},
        "sections": {},
        "skipped": NOT_OURS,
    }
    for name in SKELETON:
        d = out / name
        files = sorted(p for p in d.rglob("*") if p.is_file())
        entry: dict = {
            "responsible": name in OURS,
            "files": [{"name": str(p.relative_to(d)), "bytes": p.stat().st_size} for p in files],
        }
        if name == "00成片":
            entry["probe"] = {f["name"]: probe(d / f["name"], ffprobe) for f in entry["files"]}
        if name == "01主角":
            entry["genders"] = sorted(x["gender"] for x in leads)
        if name == "05剧本&简介":
            entry["synopsis_chars"] = synopsis_count
            entry["synopsis_limit"] = SYNOPSIS_LIMIT
        if name == "02海报" and not files:
            entry["status"] = "missing"
        report["sections"][name] = entry
        flag = "有" if files else ("待填" if name in OURS else "不由本流水线填")
        print(f"[自检] {name}: {len(files)} 个文件（{flag}）")

    print()
    for f in report["sections"]["00成片"]["files"]:
        print(f"[ffprobe] {f['name']}: {report['sections']['00成片']['probe'][f['name']]}")

    print()
    print("<<<ASSEMBLY_REPORT>>>")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print("<<<END_ASSEMBLY_REPORT>>>")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
