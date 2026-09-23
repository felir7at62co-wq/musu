"""抢本引擎：候选筛选（纯函数）+ 并发认领 + 结果归因 + 账本门禁。

严格模式：只提交 canClaim 为可领的剧本；候选为空就什么都不做。认领是真实写操作，
所以每次提交都要过账本——已到手或结果未知的本一律不再重发（见 ledger.py）。
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Iterable

from . import api
from .ledger import ClaimLedger, ClaimState, claim_key

# 组长入口被拒时服务端会提示"只有制作组员可以认领"，据此回退组员路径。
_MEMBER_HINT = "组员"


@dataclass(frozen=True)
class ClaimResult:
    """一次认领的结论。

    state 是持久状态（accepted/rejected/unknown）；replayed=True 表示账本里已有
    ACCEPTED/UNKNOWN 记录，这次**没有**发请求。outcome 是服务端的原始归因，
    仅在真的发出过请求时有值。
    """

    script_id: int
    name: str
    state: ClaimState
    message: str
    replayed: bool = False
    outcome: api.Outcome | None = None


def select_targets(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """筛出可领剧本，按 id 升序返回确定顺序。纯函数，不改动入参。"""
    picked = [
        dict(row) for row in rows if api.is_claimable(row) and api.row_id(row) is not None
    ]
    return sorted(picked, key=lambda r: r["id"])


class Claimer:
    """认领的唯一入口：canClaim 门禁与账本门禁都在这里，没有旁路。"""

    def __init__(self, client: Any, ledger: ClaimLedger, concurrency: int = 8) -> None:
        self._client = client
        self._ledger = ledger
        self._concurrency = max(1, concurrency)

    @staticmethod
    def _message(envelope: dict[str, Any]) -> str:
        return str(
            envelope.get("msg") or envelope.get("error") or envelope.get("code") or ""
        )

    def _send(self, script_id: int, name: str, *, member: bool | None = None) -> ClaimResult:
        """过账本再提交一次。账本说"已有阻止性记录"时一个请求都不发。"""
        key = claim_key(script_id)
        blocked = self._ledger.begin(key, detail=name)
        if blocked is not None:
            return ClaimResult(
                script_id, name, blocked, f"账本已有 {blocked.value} 记录，未再提交", replayed=True
            )
        try:
            envelope = self._client.claim(script_id, member=member)
        except Exception as exc:  # 传输层异常 = 结果未知，不是"没发生"
            self._ledger.settle(key, ClaimState.UNKNOWN, detail=str(exc))
            return ClaimResult(script_id, name, ClaimState.UNKNOWN, f"传输异常，认领结果未知：{exc}")
        outcome = api.attribute(envelope)
        message = self._message(envelope)
        if outcome is api.Outcome.SUCCESS:
            self._ledger.settle(key, ClaimState.ACCEPTED, detail=message)
            return ClaimResult(script_id, name, ClaimState.ACCEPTED, message, outcome=outcome)
        self._ledger.settle(key, ClaimState.REJECTED, detail=message)
        return ClaimResult(script_id, name, ClaimState.REJECTED, message, outcome=outcome)

    def claim_one(self, row: dict[str, Any], *, member: bool | None = None) -> ClaimResult:
        """认领一本。canClaim 不是可领就直接拒绝，一个请求都不发。"""
        script_id = api.row_id(row)
        if script_id is None:
            raise ValueError("行里没有可用的整数 id")
        name = str(row.get("scriptName") or "")
        if not api.is_claimable(row):
            return ClaimResult(script_id, name, ClaimState.REJECTED, "canClaim 不为可领，拒绝提交")
        result = self._send(script_id, name, member=member)
        if (
            result.outcome is api.Outcome.NO_PERMISSION
            and member is not True
            and _MEMBER_HINT in result.message
        ):
            # 组长入口被拒是明确答复（这次认领没有发生），按组员路径再提交一次。
            return self._send(script_id, name, member=True)
        return result

    def claim_all(self, targets: list[dict[str, Any]]) -> list[ClaimResult]:
        """并发认领全部候选。单本失败不中断其余；返回顺序与入参一致。"""
        if not targets:
            return []
        with ThreadPoolExecutor(max_workers=self._concurrency) as pool:
            return list(pool.map(self.claim_one, targets))
