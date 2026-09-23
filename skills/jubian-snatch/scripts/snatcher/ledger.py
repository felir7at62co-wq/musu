"""认领账本：一次认领写两条 NDJSON 记录，append-only。

intent 在请求发出**之前**落盘，settle 在读回答复之后落盘。只有 intent 没有 settle
的记录就是"结果未知"——那次请求可能已经在服务端生效了。未知和成功一样阻止再次提交
（fail-closed）；只有服务端明确答复"这次认领没有发生"（REJECTED）才允许重试。

语义参照 DSH Node 侧的写操作账本（packages/jubian/jubian/src/ledger.ts），
这里是 Python 侧的最小实现：一个文件、两条记录、一次 fold。
"""
from __future__ import annotations

import datetime as dt
import json
import os
import threading
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Iterator


class ClaimState(str, Enum):
    """一条认领记录的持久状态。"""

    ACCEPTED = "accepted"  # 服务端确认认领成功
    REJECTED = "rejected"  # 服务端明确答复这次认领没有发生
    UNKNOWN = "unknown"  # 没拿到确定答复；intent 之后没有 settle 也是它


# 阻止再次提交的状态：已到手的本不再抢，结果未知的本在查清之前也不许重发。
BLOCKING_STATES = (ClaimState.ACCEPTED, ClaimState.UNKNOWN)


class LedgerFormatError(RuntimeError):
    """账本里有读不懂的记录，无法判断这本的既有状态，因此拒绝提交。"""


@dataclass(frozen=True)
class ClaimRecord:
    key: str
    state: ClaimState
    at: str
    detail: str


def claim_key(script_id: int) -> str:
    """一个剧本 id 对应一把认领键。"""
    return f"claim/{script_id}"


def _now() -> str:
    return dt.datetime.now().isoformat(timespec="seconds")


class ClaimLedger:
    """append-only 的认领账本；同进程内多线程安全。"""

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()

    def _lines(self) -> Iterator[dict[str, Any]]:
        try:
            text = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return
        except OSError as exc:
            raise LedgerFormatError(f"账本读不出来（{self.path}）: {exc}") from exc
        for number, line in enumerate(text.splitlines(), start=1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                raise LedgerFormatError(f"{self.path}:{number} 不是合法 JSON: {exc}") from exc
            if not isinstance(record, dict):
                raise LedgerFormatError(f"{self.path}:{number} 不是记录对象")
            yield record

    def _fold(self, key: str) -> ClaimRecord | None:
        """把一把键的所有记录按写入顺序折叠成当前状态；最后写入者为准。"""
        record: ClaimRecord | None = None
        for line in self._lines():
            if line.get("key") != key:
                continue
            phase = line.get("phase")
            if phase == "begin":
                # intent 已落盘、答复还没回来：这就是"未知"。
                record = ClaimRecord(key, ClaimState.UNKNOWN, str(line.get("at", "")), str(line.get("detail", "")))
            elif phase == "settle":
                raw = line.get("state")
                try:
                    state = ClaimState(str(raw))
                except ValueError as exc:
                    raise LedgerFormatError(f"{self.path}: 未知的认领状态 {raw!r}") from exc
                record = ClaimRecord(key, state, str(line.get("at", "")), str(line.get("detail", "")))
        return record

    def record(self, key: str) -> ClaimRecord | None:
        """这把键现在的记录；从未提交过返回 None。"""
        with self._lock:
            return self._fold(key)

    def begin(self, key: str, detail: str = "") -> ClaimState | None:
        """写 intent 并返回是否允许发请求。

        返回 None：这把键还没有阻止重发的记录，intent 已落盘，可以发请求。
        返回某个状态：已有一条 ACCEPTED/UNKNOWN 记录，**不要发请求**。
        """
        with self._lock:
            existing = self._fold(key)
            if existing is not None and existing.state in BLOCKING_STATES:
                return existing.state
            self._append({"phase": "begin", "key": key, "at": _now(), "detail": detail})
            return None

    def settle(self, key: str, state: ClaimState, detail: str = "") -> None:
        """写 settle：这次认领的最终归属状态。"""
        with self._lock:
            self._append(
                {"phase": "settle", "key": key, "at": _now(), "state": state.value, "detail": detail}
            )

    def _append(self, record: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(record, ensure_ascii=False) + "\n"
        with open(self.path, "a", encoding="utf-8") as handle:
            handle.write(line)
            handle.flush()
            os.fsync(handle.fileno())
