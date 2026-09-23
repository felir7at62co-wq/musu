"""到点抢本：从指定时刻起高频轮询剧变剧本池，发现新的可领剧本立即并发认领。

准备期（`--start` 之前）低频轮询保持 TCP/TLS 热连接；`--start` 起高频轮询；
`--burst` 起再提速；`--end` 到点写总结退出。只读轮询 + 认领 POST，不打印 token。

认领是真实且不可撤销的写操作，所以这里有三道 fail-closed 闸门：
  * 基线（开始时已可领的 id）读失败或读不全就拒绝启动，绝不退化成"全部都可抢"；
  * 每本都过认领账本：服务端已确认或结果未知的本绝不重发（见 snatcher/ledger.py）；
  * 认领结论以回读到的归属为准——"从池子里消失"不是认领成功的证据。

用法：
    python snatch_batch.py [--start 18:25] [--burst 18:29:30] [--end 19:00]
                           [--concurrency 12] [--include-preexisting]
                           [--ledger snatch-claims.ndjson]
                           [--log snatch-20260920.log]
"""
from __future__ import annotations

import argparse
import datetime as dt
import queue
import sys
import threading
import time
from typing import Any

from snatcher import api, config
from snatcher.api import ApiError
from snatcher.claimer import ClaimResult, Claimer
from snatcher.httpclient import ConnectionPool, TransportError
from snatcher.ledger import ClaimLedger, ClaimState

# 完整池子扫描的间隔（兜底：万一新本落在 config.CLAIMABLE_STATUSES 之外的状态上）。
FULL_SWEEP_EVERY = 20
# 认领后多久回读一次池子核对归属。
VERIFY_AFTER_SEC = 15


class BaselineUnavailable(RuntimeError):
    """基线读不全：无法知道开始时哪些本已经可领。"""


class Logger:
    """带时间戳的行缓冲日志：既打屏幕也落盘，每行立即 flush 便于 tail。"""

    def __init__(self, path: str) -> None:
        self._handle = open(path, "w", encoding="utf-8", buffering=1)
        self._lock = threading.Lock()

    def write(self, message: str) -> None:
        stamp = dt.datetime.now().strftime("%H:%M:%S.%f")[:-3]
        line = f"[{stamp}] {message}"
        with self._lock:
            print(line, flush=True)
            self._handle.write(line + "\n")

    def close(self) -> None:
        self._handle.close()


def parse_hhmm(text: str, today: dt.date) -> float:
    """把 'HH:MM' / 'HH:MM:SS' 解析成今天该时刻的时间戳。"""
    parts = [int(p) for p in text.split(":")]
    while len(parts) < 3:
        parts.append(0)
    return dt.datetime.combine(today, dt.time(parts[0], parts[1], parts[2])).timestamp()


def read_baseline(client: api.JubianApi) -> set[int]:
    """开始时已经可领的 id 集合。

    读失败或读不全都抛异常：空基线会让"本来就摆在那里的本"被当成新本抢下来，
    认领范围就是这样被放大的。
    """
    read = client.read_pool()
    if not read.complete:
        raise BaselineUnavailable(
            f"只读到 {len(read.rows)} 行，服务端报 total={read.total}（读了 {read.pages} 页）"
        )
    baseline: set[int] = set()
    for row in read.rows:
        identity = api.row_id(row)
        if identity is not None and api.is_claimable(row):
            baseline.add(identity)
    return baseline


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="18:25", help="开始高频轮询的时刻 HH:MM[:SS]")
    parser.add_argument("--burst", default="18:29:30", help="进入最高频的时刻")
    parser.add_argument("--end", default="19:00", help="收工时刻")
    parser.add_argument("--concurrency", type=int, default=12, help="并发认领线程数上限")
    parser.add_argument("--include-preexisting", action="store_true",
                        help="连开始时就已可领的旧本一起抢（默认跳过）")
    parser.add_argument("--log", default=None)
    parser.add_argument("--ledger", default=None,
                        help=f"认领账本路径（默认 ./{config.LEDGER_FILENAME}）")
    parser.add_argument("--dry-run", action="store_true",
                        help="只走检测与派发，不发任何认领请求（用于演练）")
    parser.add_argument("--skip", default="",
                        help="额外跳过的剧本 id，逗号分隔（比如你已经退回、不想再抢的那本）")
    return parser


def main(argv: list[str], *, pool: Any = None, clock=time.time, sleep=time.sleep) -> int:
    args = _parser().parse_args(argv)

    today = dt.date.today()
    start_at, burst_at, end_at = (parse_hhmm(t, today) for t in (args.start, args.burst, args.end))
    log_path = args.log or f"snatch-{today.strftime('%Y%m%d')}.log"
    log = Logger(log_path)
    ledger = ClaimLedger(args.ledger or config.default_ledger_path())
    owned_pool = pool is None
    try:
        token = config.prefill_token()
        if not token:
            log.write("认证配置不足：请配置当前进程的 JUBIANAI_ADMIN_TOKEN（兼容显式 JUBIAN_TOKEN）；只读取当前 home 主凭据，不读取其他账号或桌面安全存储。")
            return 2

        if pool is None:
            pool = ConnectionPool(
                config.API_HOST, config.API_PORT, config.REQUEST_TIMEOUT_SEC,
                base_path=config.API_BASE_PATH,
            )
        try:
            client = api.JubianApi(pool, token)
            who = client.whoami()
            role = client.view_role()
            client = api.JubianApi(pool, token, role=role)
        except (TransportError, ApiError) as exc:
            log.write(f"!! 启动时读身份失败，拒绝启动：{exc}")
            return 2
        log.write(f"身份 name={who.name!r} dept={who.dept_name!r} viewRole={role!r} 认证={who.authenticated}")
        if not who.authenticated:
            log.write("!! token 被服务端拒绝（code=401）：需要重新登录取新 token，退出。")
            return 2

        try:
            baseline = read_baseline(client)
        except (TransportError, ApiError, BaselineUnavailable) as exc:
            log.write(f"!! 基线不可用，拒绝启动（不知道开始时哪些本已可领，认领范围会被放大）：{exc}")
            return 2
        explicit_skip = {
            int(part) for part in args.skip.replace("，", ",").split(",") if part.strip().isdigit()
        }
        preexisting = len(baseline)
        if args.include_preexisting:
            baseline = set()
        exclude = baseline | explicit_skip
        label = ("全部可领都抢（--include-preexisting）" if args.include_preexisting
                 else "只抢新出现的，不碰开始时已可领的")
        log.write(f"{label}；开始时可领 {preexisting} 本，点名跳过 {sorted(explicit_skip)}，"
                  f"合计不碰 id={sorted(exclude)}")
        log.write(f"启动参数 start={args.start} burst={args.burst} end={args.end} "
                  f"并发={args.concurrency} 账本={ledger.path}")

        claimer = Claimer(client, ledger, concurrency=args.concurrency)
        discovered: set[int] = set()
        first_seen: dict[int, float] = {}
        accepted: set[int] = set()
        unknown: set[int] = set()
        held: set[int] = set()
        verify_due: dict[int, float] = {}
        verified: set[int] = set()
        inflight: set[int] = set()
        results: "queue.Queue[tuple[str, dict[str, Any], Any, float]]" = queue.Queue()
        active = 0
        active_lock = threading.Lock()

        def claim_worker(row: dict[str, Any]) -> None:
            """一次认领（走 Claimer，因此过 canClaim 门禁与账本门禁）。"""
            started = clock()
            if args.dry_run:
                results.put(("dry-run", row, None, started))
                return
            try:
                results.put(("result", row, claimer.claim_one(row), started))
            except Exception as exc:  # 未提交：账本或本地错误，不是"已认领"
                results.put(("error", row, exc, started))

        def drain() -> None:
            """收走已完成的认领结果并如实记录。"""
            nonlocal active
            while not results.empty():
                kind, row, payload, started = results.get()
                script_id = api.row_id(row)
                inflight.discard(script_id)
                with active_lock:
                    active -= 1
                label_text = f"id={script_id}《{row.get('scriptName') or ''}》"
                if kind == "dry-run":
                    log.write(f"演练命中 {label_text}：检测与派发通路正常，未发认领请求")
                    continue
                if kind == "error":
                    log.write(f"!! 认领未提交 {label_text}：{payload}")
                    continue
                result: ClaimResult = payload
                if result.replayed:
                    log.write(f"跳过 {label_text}：{result.message}")
                elif result.state is ClaimState.ACCEPTED:
                    accepted.add(script_id)
                    verify_due.setdefault(script_id, clock())
                    total_ms = (clock() - first_seen.get(script_id, started)) * 1000
                    log.write(f"认领成功 {label_text} 请求 {(clock() - started) * 1000:.0f}ms "
                              f"发现→成功 {total_ms:.0f}ms {result.message!r}")
                elif result.state is ClaimState.UNKNOWN:
                    unknown.add(script_id)
                    verify_due.setdefault(script_id, clock())
                    log.write(f"!! 认领结果未知 {label_text}：{result.message!r}"
                              f"（不重发；稍后回读池子核对归属）")
                else:
                    outcome = result.outcome.value if result.outcome else "?"
                    log.write(f"认领失败 {label_text} outcome={outcome} {result.message!r}")

        log.write(f"{args.start} 起进入高频轮询；日志 {log_path}")
        polls = 0
        sweeps = 0
        partial_reads = 0
        last_heartbeat = clock()
        while True:
            now = clock()
            if now >= end_at:
                break
            if now < start_at:
                interval = 1.0
            elif now < burst_at:
                interval = 0.25
            elif now < burst_at + 300:
                interval = 0.12
            else:
                interval = 0.5

            cycle_started = clock()
            status = config.CLAIMABLE_STATUSES[polls % len(config.CLAIMABLE_STATUSES)]
            try:
                read = client.read_pool(status=status)
                polls += 1
                sweeps += 1
                if sweeps % FULL_SWEEP_EVERY == 0:
                    # 状态名不可信，定期整池扫描兜底。
                    read = client.read_pool()
                    polls += 1
            except (TransportError, ApiError) as exc:
                log.write(f"!! 轮询失败：{exc}")
                sleep(0.5)
                continue
            if not read.complete:
                partial_reads += 1
                log.write(f"!! 本轮只读到 {len(read.rows)}/{read.total} 行"
                          f"（{read.pages} 页，上限 {config.MAX_POOL_PAGES} 页）："
                          f"没读到的部分可能含新本")

            rows = read.rows
            names = {
                identity: str(row.get("scriptName") or "")
                for row in rows
                for identity in (api.row_id(row),)
                if identity is not None
            }
            for row in rows:
                script_id = api.row_id(row)
                if script_id is None or not api.is_claimable(row):
                    continue
                if script_id in exclude or script_id in discovered:
                    continue
                discovered.add(script_id)
                first_seen[script_id] = cycle_started
                with active_lock:
                    if active >= args.concurrency:
                        log.write(f"发现 id={script_id}《{names.get(script_id, '')}》"
                                  f"但并发已满，下一轮提交")
                        discovered.discard(script_id)
                        continue
                    active += 1
                inflight.add(script_id)
                log.write(f"发现新可领本 id={script_id}《{names.get(script_id, '')}》→ 立即认领")
                threading.Thread(target=claim_worker, args=(row,), daemon=True).start()

            drain()

            # 认领复核：回读池子确认这本是不是真落在我们名下。查不到这本不是证据——
            # 退回、被释放、被别人领走都会让它从当前页消失，所以只有行里写着我们的
            # 名字才算 HELD；读不全就什么都不下结论。
            due = [
                script_id for script_id, when in verify_due.items()
                if script_id not in verified and clock() - when >= VERIFY_AFTER_SEC
            ]
            if due:
                try:
                    check = client.read_pool()
                    polls += 1
                except (TransportError, ApiError) as exc:
                    log.write(f"!! 认领复核读取失败，下次再试：{exc}")
                else:
                    if not check.complete:
                        log.write(f"!! 认领复核只读到 {len(check.rows)}/{check.total} 行，"
                                  f"不下结论，下次再试")
                    else:
                        by_id = {
                            identity: row
                            for row in check.rows
                            for identity in (api.row_id(row),)
                            if identity is not None
                        }
                        for script_id in due:
                            verified.add(script_id)
                            verdict = api.classify_ownership(by_id.get(script_id), who.name)
                            if verdict is api.Ownership.HELD:
                                held.add(script_id)
                            current = by_id.get(script_id)
                            if current is None:
                                detail = "已不在池中（从池中消失**不是**认领成功的证据）"
                            else:
                                detail = (
                                    f"status={current.get('status')} canClaim={current.get('canClaim')} "
                                    f"组长={current.get('claimLeaderName')!r} "
                                    f"组员={current.get('claimMemberName')!r} "
                                    f"退回首数={current.get('sendbackCount')}"
                                )
                            log.write(f"复核 id={script_id} 归属={verdict.value} {detail}")

            if clock() - last_heartbeat >= 60:
                last_heartbeat = clock()
                pending = sum(1 for row in rows if api.is_claimable(row))
                log.write(f"心跳 轮询={polls} 本轮可领={pending} 已确认={len(accepted)} "
                          f"回读持有={len(held)} 未知={len(unknown)} 在飞={len(inflight)} "
                          f"间隔={interval:.2f}s")

            sleep_for = interval - (clock() - cycle_started)
            if sleep_for > 0:
                sleep(sleep_for)

        deadline = clock() + 30
        while inflight and clock() < deadline:
            drain()
            sleep(0.2)
        drain()
        log.write(
            f"收工：轮询 {polls} 次，新发现 {len(discovered)} 本，"
            f"服务端确认认领 {len(accepted)} 本 ids={sorted(accepted)}，"
            f"回读确认归属 {len(held)} 本 ids={sorted(held)}，"
            f"结果未知 {len(unknown)} 本 ids={sorted(unknown)}，"
            f"读取不完整 {partial_reads} 轮"
        )
        return 0
    finally:
        if owned_pool:
            pool.close_all()
        log.close()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
