"""人工核对（联网）：剧变剧本池现在有多少本、几本可领、自己的项目有几个。

只读路径不发任何写请求；`--claim <id>` 才会真发一次认领，而且必须先过两道门禁：
该 id 在当前池子里 canClaim 为可领，且本地账本里没有"已到手/结果未知"的记录。
诊断没有旁路——绕开 canClaim 的试抢会把认领范围放大到不属于你的本。

用法：
    python check_pool_live.py                 # 只读
    python check_pool_live.py --claim 1234    # 对某个 canClaim 为可领的 id 试抢一次
    python check_pool_live.py --dump pool.json

不打印 token 内容。
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from typing import Any

from snatcher import api, config
from snatcher.api import ApiError
from snatcher.claimer import Claimer
from snatcher.httpclient import ConnectionPool, TransportError
from snatcher.ledger import ClaimLedger

# 自己名下项目（画布项目）列表，只取 total，不拉内容。
PATH_MY_PROJECTS = "/aigc/script/list?pageNum=1&pageSize=1"


def _option(argv: list[str], name: str) -> str | None:
    return argv[argv.index(name) + 1] if name in argv else None


def main(argv: list[str], *, pool: Any = None) -> int:
    claim_text = _option(argv, "--claim")
    claim_id = int(claim_text) if claim_text is not None else None
    dump_path = _option(argv, "--dump")
    ledger = ClaimLedger(_option(argv, "--ledger") or config.default_ledger_path())

    token = config.prefill_token()
    print("=== 剧变剧本池联网自检（不打印 token）===")
    print(f"base       : {config.BASE_URL}")
    print(f"token 预填 : {'有' if token else '无'}")
    if not token:
        print("认证配置不足：请为当前进程配置 JUBIANAI_ADMIN_TOKEN；兼容显式 JUBIAN_TOKEN。")
        print("只读取当前 DSH_HOME（未设置才 ~/.dsh）的 .credentials.yaml，不读取其他账号或桌面安全存储。")
        return 2

    owned_pool = pool is None
    if pool is None:
        pool = ConnectionPool(
            config.API_HOST,
            config.API_PORT,
            config.REQUEST_TIMEOUT_SEC,
            base_path=config.API_BASE_PATH,
        )
    client = api.JubianApi(pool, token)
    try:
        who = client.whoami()
        role = client.view_role()
        client = api.JubianApi(pool, token, role=role)
        print(
            f"身份       : authenticated={who.authenticated} name={who.name!r} "
            f"dept={who.dept_name!r} permissions={len(who.permissions)}"
        )
        print(f"viewRole   : {role!r}")
        if not who.authenticated:
            print("token 被服务端拒绝（认证失败是 HTTP 200 + envelope code=401）——需重新登录取新 token。")
            return 0

        print(f"statusCount: {client.status_count()!r}")

        mine = pool.request("GET", PATH_MY_PROJECTS, token)
        print(f"我名下项目 : total={mine.get('total')!r}  code={mine.get('code')!r}")

        read = client.read_pool()
        print(f"剧本池     : total={read.total!r} 读到 {len(read.rows)} 行（{read.pages} 页）")
        if not read.complete:
            print(f"!! 没读完：服务端报 total={read.total!r}，只读到 {len(read.rows)} 行"
                  f"（上限 {config.MAX_POOL_PAGES} 页）。下面的分布与可领清单只是已读到的那部分。")
        by_id: dict[int, dict[str, Any]] = {}
        for row in read.rows:
            identity = api.row_id(row)
            if identity is not None:
                by_id[identity] = row
        print(f"按状态     : {dict(Counter(str(r.get('status')) for r in read.rows))}")
        claimable = [r for r in read.rows if api.is_claimable(r)]
        print(f"可领(canClaim): {len(claimable)} 本")
        for row in claimable[:10]:
            print(f"   id={row.get('id')} status={row.get('status')} name={row.get('scriptName')!r}")
        waiting = [r for r in read.rows if str(r.get("status")) in config.CLAIMABLE_STATUSES]
        print(f"等认领状态 : {len(waiting)} 本 ids={[r.get('id') for r in waiting][:20]}")

        if dump_path is not None:
            with open(dump_path, "w", encoding="utf-8") as handle:
                json.dump(list(read.rows), handle, ensure_ascii=False, indent=1)
            print(f"已写池子 {len(read.rows)} 行到 {dump_path}")

        if claim_id is not None:
            if not read.complete:
                print(f"试抢 {claim_id}  : 池子没读完，无法确认这本的可领状态，拒绝提交。")
                return 1
            row = by_id.get(claim_id)
            if row is None:
                print(f"试抢 {claim_id}  : 当前池子里没有这一本，拒绝提交。")
                return 1
            if not api.is_claimable(row):
                print(f"试抢 {claim_id}  : canClaim={row.get('canClaim')!r}，不是可领，"
                      f"拒绝提交（诊断没有旁路）。")
                return 1
            result = Claimer(client, ledger).claim_one(row)
            print(f"试抢 {claim_id}  : state={result.state.value} replayed={result.replayed} "
                  f"message={result.message!r}")
            if result.state.value != "accepted":
                return 1
        return 0
    except (TransportError, ApiError) as exc:
        print(f"!! 请求失败：{exc}")
        return 1
    finally:
        if owned_pool:
            pool.close_all()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
