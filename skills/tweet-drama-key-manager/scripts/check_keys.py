#!/usr/bin/env python3
"""Check keys in DSH_PIPELINE_ENV or <DSH_HOME>/secrets/pipeline.env.

Prints only variable names, never key values.
Exit code 0 if all required keys present, 1 if any missing.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


REQUIRED = ["JUBIANAI_ADMIN_TOKEN"]

OPTIONAL = [
    "JUBIANAI_BASE_URL",
    "剪映草稿地址",
]


def resolve_env_path() -> Path:
    explicit = os.environ.get("DSH_PIPELINE_ENV")
    if explicit:
        return Path(explicit).expanduser().resolve()
    home = Path(os.environ.get("DSH_HOME") or Path.home() / ".dsh").expanduser()
    return home.resolve() / "secrets" / "pipeline.env"


def load_env(env_path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not env_path.is_file():
        return values
    for line in env_path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip()
    return values


def main() -> int:
    env_path = resolve_env_path()
    values = load_env(env_path)

    print(f"pipeline.env: {env_path}")
    print(f"存在: {env_path.is_file()}")
    print()
    print("== 必需 ==")
    missing = [k for k in REQUIRED if not values.get(k)]
    for k in REQUIRED:
        print(f"  [{'OK' if values.get(k) else '缺失'}] {k}")
    print()
    print("== 可选 ==")
    for k in OPTIONAL:
        print(f"  [{'OK' if values.get(k) else '-'}] {k}")
    print()

    if missing:
        print(f"缺失必需变量: {', '.join(missing)}")
        print("请询问用户提供后写入 pipeline.env 再继续。")
        return 1
    print("必需变量齐全。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
