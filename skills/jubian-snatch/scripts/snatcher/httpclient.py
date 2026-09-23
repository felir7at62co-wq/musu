"""持久化 HTTPS 连接池。

服务端是 nginx + keep-alive，复用连接后单请求约 34ms；
每请求重建连接的 requests/urllib 约 340ms 以上，因此不使用它们。

连接按线程绑定（thread-local）：每个工作线程持有自己的长连接，
既避免跨线程共享 socket，又让并发认领时每路都是热的。
"""
from __future__ import annotations

import http.client
import json
import ssl
import threading
from typing import Any, Callable


class TransportError(RuntimeError):
    """网络层失败（连不上、超时、非 JSON 响应）。

    写请求（POST）抛它时，请求可能已经到达服务端并生效：调用方必须按"结果未知"
    处理，用账本记录而不是重发（见 ledger.py）。
    """


# 只有可安全重放的请求才允许自动重连一次。POST 认领会改变服务端状态，
# 重发就是重复认领，所以它一次都不重试。
_IDEMPOTENT_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


class ConnectionPool:
    def __init__(
        self,
        host: str,
        port: int,
        timeout: float,
        connection_factory: Callable[..., Any] | None = None,
        base_path: str = "",
    ) -> None:
        self._host = host
        self._port = port
        self._timeout = timeout
        self._factory = connection_factory or self._default_factory
        # 路径前缀，例如 "/prod-api"。默认空，便于测试独立于应用级常量。
        self._base_path = base_path.rstrip("/")
        self._local = threading.local()
        self._all: list[Any] = []
        self._lock = threading.Lock()

    def _default_factory(
        self, host: str, port: int, timeout: float, context: Any = None
    ) -> http.client.HTTPSConnection:
        """与注入的 connection_factory(host, port, timeout, context) 同签名。"""
        return http.client.HTTPSConnection(
            host,
            port,
            timeout=timeout,
            context=context or ssl.create_default_context(),
        )

    def _new_connection(self):
        conn = self._factory(self._host, self._port, self._timeout, None)
        with self._lock:
            self._all.append(conn)
        return conn

    def get(self):
        """取当前线程的连接，没有就建一个并缓存。"""
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = self._new_connection()
            self._local.conn = conn
        return conn

    def _discard_current(self) -> None:
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
            self._local.conn = None

    def request(self, method: str, path: str, token: str) -> dict[str, Any]:
        """发一个请求并返回解析后的 envelope。

        path 是相对 BASE_URL 的路径（如 "/getInfo"），前缀由 base_path 补上。
        GET 等可重放请求在连接被服务端回收时（RemoteDisconnected / BadStatusLine）
        自动重连一次；POST 不自动重试。
        """
        method = method.upper()
        headers = {
            "Accept": "application/json",
            "Connection": "keep-alive",
        }
        if token:
            headers["Authorization"] = f"Bearer {token}"
        full_path = f"{self._base_path}{path}"

        last_error: Exception | None = None
        for _ in range(2 if method in _IDEMPOTENT_METHODS else 1):
            conn = self.get()
            try:
                conn.request(method, full_path, body=None, headers=headers)
                response = conn.getresponse()
                raw = response.read()
            except (http.client.HTTPException, OSError, ssl.SSLError) as exc:
                last_error = exc
                self._discard_current()
                continue
            try:
                return json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise TransportError(
                    f"响应不是合法 JSON（{len(raw)} 字节）: {raw[:120]!r}"
                ) from exc
        raise TransportError(f"{method} {path} 未得到确定答复: {last_error}") from last_error

    def close_all(self) -> None:
        with self._lock:
            conns = list(self._all)
            self._all.clear()
        for conn in conns:
            try:
                conn.close()
            except Exception:
                pass
        self._local = threading.local()
