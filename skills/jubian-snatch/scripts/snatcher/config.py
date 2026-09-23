"""剧变抢本客户端：常量与 token 预填来源。

本模块不读网络、不依赖 PyQt，可独立单测。

prefill_token() 的契约：**永不抛异常，也绝不返回"看起来像 token 但其实
是残片/污染"的值**。拿不准（文件编码非法、标量被截断、值只剩注释）时
返回空串让用户手输——空串永远是可接受的答案。
"""
from __future__ import annotations

import os
import re
from pathlib import Path

# —— 服务端 ——
BASE_URL = "https://web.jubianai.net/prod-api"
API_HOST = "web.jubianai.net"
API_PORT = 443
# BASE_URL 的路径部分。下面 PATH_* 都相对它，必须带上这个前缀，
# 否则服务端返回 HTTP 200 + 单页应用首页的 HTML（不是 JSON），静默出错。
API_BASE_PATH = "/prod-api"
REQUEST_TIMEOUT_SEC = 10.0

# —— 轮询与并发 ——
# 严格模式：只轮询"等认领"的状态。状态名未完全验证（池子行里组长这一档既出现过
# pending_leader_claim 也出现过 pending_lead_claim），所以两种写法都轮询。
# 状态名只用来缩小轮询响应，**候选判据始终是 canClaim**（见 api.is_claimable）。
CLAIMABLE_STATUSES = ("pending_leader_claim", "pending_lead_claim", "pending_member_claim")
POOL_PAGE_SIZE = 300
# 单次读取最多翻这么多页；池子更大时读取会把自己标记为不完整，由调用方决定怎么办。
MAX_POOL_PAGES = 10
DEFAULT_POLL_INTERVAL_MS = 1000
CLAIM_CONCURRENCY = 8
MAX_LOG_LINES = 500

# —— 认领账本 ——
# 认领是真实写操作：intent 先落盘，请求才发出去；没有 settle 的记录就是"结果未知"，
# 未知与成功一样阻止再次提交。默认放当前工作目录（两个 CLI 都从 scripts/ 运行）。
LEDGER_FILENAME = "snatch-claims.ndjson"

# —— 接口路径 ——
PATH_GET_INFO = "/getInfo"
PATH_VIEW_ROLE = "/script/center/pool/viewRole"
PATH_POOL_LIST = "/script/center/pool/list"
PATH_POOL_STATUS_COUNT = "/script/center/pool/statusCount"
PATH_CLAIM = "/script/center/pool/claim/{id}"
PATH_MEMBER_CLAIM = "/script/center/pool/memberClaim/{id}"


def pool_list_path(page: int, page_size: int = POOL_PAGE_SIZE, status: str | None = None) -> str:
    """剧本池列表的一页请求路径。status 只用于缩小响应，不是候选判据。"""
    path = f"{PATH_POOL_LIST}?pageNum={page}&pageSize={page_size}"
    if status:
        path = f"{path}&status={status}"
    return path


def default_ledger_path(cwd: str | None = None) -> Path:
    """认领账本的默认位置：当前工作目录下的 LEDGER_FILENAME。"""
    return Path(cwd if cwd is not None else os.getcwd()) / LEDGER_FILENAME


# —— token 预填来源（环境变量优先，凭据文件只做兜底）——
ENV_TOKEN_KEY = "JUBIANAI_ADMIN_TOKEN"
LEGACY_ENV_TOKEN_KEY = "JUBIAN_TOKEN"
# 只读当前 Harness home 的主凭据文件，不自动选择其他账号。
_CRED_FILENAMES = (".credentials.yaml",)
_CRED_REF_KEYS = (ENV_TOKEN_KEY,)

# CREDENTIAL_FILES 的声明（值由模块 __getattr__ 惰性给出，见文件末尾）：
# 用 mock.patch.object(config, "CREDENTIAL_FILES", ...) 覆盖它仍然有效。
CREDENTIAL_FILES: tuple[Path, ...]

_BEARER_RE = re.compile(r"^Bearer\b\s*", re.IGNORECASE)
# 零宽字符永远不是 token 的合法内容，全局删除是安全的。
_ZW_RE = re.compile(r"[\u200b\u200c\u200d\ufeff]")
_STRIP_CHARS = " \t\r\n\"'"


def clean_token(raw: str | None, *, once: bool = False) -> str:
    """清理粘贴污染：Bearer 前缀、引号、分号、零宽字符、首尾空白。

    默认（once=False）迭代到收敛，因为引号/分号/Bearer 会互相遮挡：
    单次处理 '"Bearer abc";' 只会留下 'abc"' 这种残渣——它看起来像
    token，其实是坏的，比返回空串更糟。

    once=True 用于环境变量、凭据文件这类可信来源：token 自身可能合法
    地以 ';' 结尾（真机上确实观测到 ...T837MhloBUQ;），所以不主动删
    尾分号；只有分号紧跟在引号/空白后面时才例外——引号永远不可能是
    token 内容，说明那一层分号是粘贴时粘在外面的。

    循环必然终止：循环体里只有删除字符的操作（re.sub 去前缀、strip
    去首尾、rstrip 去尾分号），文本长度单调不增，一旦某轮没有变化就是
    不动点，因此最多迭代 len(raw) 次。
    """
    text = _ZW_RE.sub("", raw or "")
    while True:
        before = text
        text = _BEARER_RE.sub("", text).strip().strip(_STRIP_CHARS).strip()
        if once:
            core = text.rstrip(";")
            if core != text and core.rstrip(_STRIP_CHARS) != core:
                # 尾分号遮住了引号/空白这类污染，把它连同污染一起剪掉
                text = core.rstrip(_STRIP_CHARS).strip()
        else:
            text = text.rstrip(";").strip()
        if text == before:
            return text


def _default_credential_files() -> tuple[Path, ...]:
    """只解析 DSH_HOME；未设置或为空才使用 ~/.dsh，无法解析时不读任何文件。"""
    try:
        configured = os.environ.get("DSH_HOME")
        home = Path(configured).expanduser() if configured else Path.home() / ".dsh"
    except RuntimeError:
        return ()
    return tuple(home / name for name in _CRED_FILENAMES)


def _credential_files() -> tuple[Path, ...]:
    """当前生效的凭据文件列表。

    显式赋给模块属性 CREDENTIAL_FILES 的值（宿主/测试/用户配置）优先，
    否则惰性解析默认路径——导入期求值会让缺 HOME 的进程直接导入失败。
    """
    configured = globals().get("CREDENTIAL_FILES")
    if configured is None:
        return _default_credential_files()
    return tuple(configured)


def __getattr__(name: str):
    """PEP 562：CREDENTIAL_FILES 惰性求值，同时保持可被 patch 覆盖。"""
    if name == "CREDENTIAL_FILES":
        return _default_credential_files()
    raise AttributeError("module %r has no attribute %r" % (__name__, name))


def _read_credential_file(path: Path) -> str:
    """取凭据文件里第一个命中的 ref key，取不到返回空串（永不抛异常）。

    逐行扫描 `key: value`，**不跟踪 YAML 段**：`refs:` 只是一行普通内容，
    有没有它都能解析（头部可选）。为了不把坏值当成 token 返回：

    - 文件缺失/是目录/无权限 → OSError → 空串；
    - 编码不是 UTF-8（PowerShell 5.1 的 `>` / `Set-Content` 默认写
      UTF-16LE）→ UnicodeDecodeError（属于 ValueError，不被 OSError 覆盖）
      → 空串；UTF-8 BOM 用 utf-8-sig 吃掉，否则首行 key 会带 \\ufeff。
    - 未闭合的引号标量（反斜杠续行的多行标量）→ 逐行只拿得到第一段，
      宁可跳过也不返回断掉的残片。
    """
    try:
        text = path.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError):
        return ""
    for line in text.splitlines():
        stripped = line.strip()
        if ":" not in stripped:
            continue
        key, _, value = stripped.partition(":")
        if key.strip() not in _CRED_REF_KEYS:
            continue
        value = value.strip()
        if value.startswith("#"):
            continue  # 整行只是注释，等于没填
        comment = value.find(" #")
        if comment >= 0:
            value = value[:comment].strip()  # 行内 YAML 注释
        if value[:1] in ('"', "'") and value.count(value[0]) < 2:
            # 未闭合的多行标量（真机 ~/.dsh/.credentials.yaml 的
            # JUBIANAI_ADMIN_TOKEN 就是 "..."\\ 续行的双引号标量）：
            # 手工拼接续行会把缩进混进 token，所以直接跳过。
            continue
        token = clean_token(value, once=True)
        if token:
            return token
    return ""


def prefill_token() -> str:
    """依次取产品环境变量、显式旧环境变量、当前 home 主凭据；缺值返回空串。

    非空环境变量清理后为空时返回空串，不切换到另一凭据来源。
    环境变量和凭据文件都是可信来源（机器/用户显式写入，没有"粘贴"
    环节），走 clean_token(once=True) 保住 token 自身可能合法的尾分号。
    界面上粘贴进来的文本属于用户输入，用 clean_token() 的收敛默认值。
    """
    for key in (ENV_TOKEN_KEY, LEGACY_ENV_TOKEN_KEY):
        env = os.environ.get(key, "")
        if env:
            return clean_token(env, once=True)
    for path in _credential_files():
        token = _read_credential_file(path)
        if token:
            return token
    return ""
