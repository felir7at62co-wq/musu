"""剧变接口封装。

envelope 有两种形状，必须都吃：
  * 单对象接口：{code, msg, data: {...}}
  * 列表接口：  {code, total, rows: [...]}   ← 没有 data 包裹
认证失败是 HTTP 200 + envelope code 401。

path 一律相对 config.BASE_URL，前缀 /prod-api 由 ConnectionPool.base_path 负责。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from . import config

_AUTH_FAILURE_CODES = (401,)
_PERMISSION_HINTS = ("只有制作组员", "只有制片组长", "无权限", "权限不足", "认证失败")


class Outcome(str, Enum):
    SUCCESS = "success"
    NO_PERMISSION = "no_permission"
    FAILED = "failed"


class ApiError(RuntimeError):
    """服务端用 envelope 明确拒绝（code 不是 0/200）。与传输失败区分开。"""


@dataclass(frozen=True)
class Identity:
    authenticated: bool = False
    name: str = ""
    user_id: int = 0
    dept_name: str = ""
    permissions: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class PoolRead:
    """一次剧本池读取的结果。

    complete=False 表示服务端报的 total 比读到的行多（到页数上限或页不完整）：
    调用方不得把它当作"池子就这些本"。
    """

    rows: tuple[dict[str, Any], ...]
    total: int | None
    complete: bool
    pages: int


class Ownership(str, Enum):
    """认领后回读一行得到的归属结论。只有 HELD 是"这本在我们名下"的证据。"""

    HELD = "held"
    LOST = "lost"
    UNCONFIRMED = "unconfirmed"


def is_ok(envelope: dict[str, Any]) -> bool:
    return envelope.get("code") in (0, 200)


def rows(envelope: dict[str, Any]) -> list[dict[str, Any]]:
    got = envelope.get("rows")
    return [row for row in got if isinstance(row, dict)] if isinstance(got, list) else []


def attribute(envelope: dict[str, Any]) -> Outcome:
    """把服务端答复归成三类，供调用方区分展示。"""
    if is_ok(envelope):
        return Outcome.SUCCESS
    if envelope.get("code") in _AUTH_FAILURE_CODES:
        return Outcome.NO_PERMISSION
    message = str(envelope.get("msg") or envelope.get("error") or "")
    if any(hint in message for hint in _PERMISSION_HINTS):
        return Outcome.NO_PERMISSION
    return Outcome.FAILED


# 服务端唯一的"这本你能领"标记。只认这三种写法：其余（"true"、"yes"、1.0）一律不算，
# 拿不准就不提交。
_CLAIMABLE_LITERALS = (1, True, "1")


def is_claimable(row: dict[str, Any]) -> bool:
    """候选判据（全流程唯一一处）。状态名不参与判定。"""
    return row.get("canClaim") in _CLAIMABLE_LITERALS


def row_id(row: dict[str, Any]) -> int | None:
    identity = row.get("id")
    return identity if isinstance(identity, int) else None


def _names_us(row: dict[str, Any], actor_name: str) -> bool:
    for key in ("claimLeaderName", "claimMemberName"):
        value = row.get(key)
        if isinstance(value, str) and value == actor_name:
            return True
    return False


def classify_ownership(row: dict[str, Any] | None, actor_name: str) -> Ownership:
    """按回读的行判断这本是否真的落在我们名下。

    池子里查不到这本（row is None）**不是**认领成功的证据：被退回、被释放、
    被别人领走都会让它从当前页消失。只有行里明确写着我们的名字才算 HELD；
    其余一律 UNCONFIRMED，绝不能据此宣布认领成功。

    LOST 是明确的否定证据：行回到可领（canClaim=1）或状态是 returned。
    """
    if row is None or not actor_name:
        return Ownership.UNCONFIRMED
    if _names_us(row, actor_name):
        return Ownership.HELD
    if is_claimable(row) or str(row.get("status")) == "returned":
        return Ownership.LOST
    return Ownership.UNCONFIRMED


def read_pool(
    pool,
    token: str,
    *,
    page_size: int = config.POOL_PAGE_SIZE,
    status: str | None = None,
    max_pages: int = config.MAX_POOL_PAGES,
) -> PoolRead:
    """按页读完剧本池（或翻到页数上限并在 complete 里说明只读了部分）。

    单页读取会把"池子比一页大"变成静默漏本，所以这里一直翻到读完为止；
    到上限仍未读完时如实返回 complete=False，由调用方决定是否继续（例如基线
    读取必须拒绝启动，见 snatch_batch.read_baseline）。
    """
    collected: dict[int, dict[str, Any]] = {}
    total: int | None = None
    pages = 0
    reached_end = False
    while pages < max_pages and not reached_end:
        envelope = pool.request("GET", config.pool_list_path(pages + 1, page_size, status), token)
        if not is_ok(envelope):
            raise ApiError(
                f"code={envelope.get('code')!r} msg={envelope.get('msg') or envelope.get('error')!r}"
            )
        pages += 1
        page = rows(envelope)
        if isinstance(envelope.get("total"), int):
            total = envelope["total"]
        for row in page:
            identity = row_id(row)
            if identity is not None:
                collected.setdefault(identity, row)
        # "读完"只认两种证据：收齐了服务端报的 total，或者没有 total 时翻到了短页/空页。
        # 服务端报了 total 却给了空页时不算读完——那正是"少读了本"的样子。
        reached_end = (
            (total is not None and len(collected) >= total)
            or (total is None and (not page or len(page) < page_size))
        )
    return PoolRead(tuple(collected.values()), total, reached_end, pages)


_MEMBER_ROLE_HINTS = ("producer", "member", "operator")


class JubianApi:
    """一个 token 对应一个实例。role 决定认领走哪条路径。"""

    def __init__(self, pool, token: str, role: str = "") -> None:
        self._pool = pool
        self._token = token
        self._role = role

    # —— 身份 ——
    def whoami(self) -> Identity:
        env = self._pool.request("GET", config.PATH_GET_INFO, self._token)
        if not is_ok(env):
            return Identity()
        user = env.get("user") or {}
        dept = user.get("dept") or {}
        perms = env.get("permissions") or []
        return Identity(
            authenticated=True,
            name=str(user.get("userName") or ""),
            user_id=int(user.get("userId") or 0),
            dept_name=str(dept.get("deptName") or ""),
            permissions=tuple(str(p) for p in perms),
        )

    def view_role(self) -> str:
        env = self._pool.request("GET", config.PATH_VIEW_ROLE, self._token)
        if not is_ok(env):
            return ""
        data = env.get("data")
        return str(data) if isinstance(data, str) else ""

    # —— 池子 ——
    def read_pool(
        self,
        *,
        page_size: int = config.POOL_PAGE_SIZE,
        status: str | None = None,
        max_pages: int = config.MAX_POOL_PAGES,
    ) -> PoolRead:
        return read_pool(
            self._pool, self._token, page_size=page_size, status=status, max_pages=max_pages
        )

    def status_count(self) -> dict[str, Any]:
        env = self._pool.request("GET", config.PATH_POOL_STATUS_COUNT, self._token)
        data = env.get("data")
        return data if isinstance(data, dict) else {}

    # —— 认领 ——
    def claim(self, script_id: int, *, member: bool | None = None) -> dict[str, Any]:
        """提交一次认领。member 省略时按 viewRole 选路。

        member=True/False 用于显式指定路径（组长路径被拒后回退组员路径，见 claimer）。
        """
        if member is None:
            member = any(hint in (self._role or "").lower() for hint in _MEMBER_ROLE_HINTS)
        template = config.PATH_MEMBER_CLAIM if member else config.PATH_CLAIM
        return self._pool.request("POST", template.format(id=script_id), self._token)
