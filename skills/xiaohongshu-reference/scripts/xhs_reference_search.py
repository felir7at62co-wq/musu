#!/usr/bin/env python3
"""Read-only client for the local xpzouying/xiaohongshu-mcp service."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ALLOWED_TOOLS = frozenset(
    {"check_login_status", "search_feeds", "get_feed_detail"}
)
MCP_PROTOCOL_VERSION = "2025-03-26"
REFERENCE_REQUIRED_ROLES = frozenset({"lead", "important_support"})


class McpTransportError(RuntimeError):
    """The local MCP service could not complete a protocol request."""


class McpCallError(RuntimeError):
    """The MCP service returned a tool-level error."""


class DownloadError(RuntimeError):
    """A reference image could not be downloaded safely."""


def parse_engagement(value: Any) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return max(0, int(value))
    text = str(value or "").strip().lower().replace(",", "")
    if not text:
        return 0
    match = re.search(r"(\d+(?:\.\d+)?)\s*([万千kw]?)", text)
    if not match:
        return 0
    number = float(match.group(1))
    multiplier = {"万": 10000, "w": 10000, "千": 1000, "k": 1000}.get(
        match.group(2), 1
    )
    return max(0, int(number * multiplier))


@dataclass
class Candidate:
    note_id: str
    title: str
    description: str = ""
    author_name: str = ""
    published_at: str = ""
    likes: int = 0
    favorites: int = 0
    comments: int = 0
    tags: list[str] = field(default_factory=list)
    image_urls: list[str] = field(default_factory=list)
    source_url: str = ""
    local_image_paths: list[str] = field(default_factory=list)
    score: float = 0.0

    @classmethod
    def from_mapping(cls, source: dict[str, Any]) -> "Candidate":
        return cls(
            note_id=str(source.get("note_id") or source.get("id") or "").strip(),
            title=str(source.get("title") or "").strip(),
            description=str(source.get("description") or source.get("desc") or "").strip(),
            author_name=str(source.get("author_name") or source.get("author") or "").strip(),
            published_at=str(source.get("published_at") or source.get("publish_time") or "").strip(),
            likes=parse_engagement(source.get("likes") or source.get("liked_count")),
            favorites=parse_engagement(
                source.get("favorites") or source.get("collected_count")
            ),
            comments=parse_engagement(
                source.get("comments") or source.get("comment_count")
            ),
            tags=[str(item).strip() for item in source.get("tags", []) if str(item).strip()],
            image_urls=[
                str(item).strip()
                for item in source.get("image_urls", [])
                if str(item).strip()
            ],
            source_url=str(source.get("source_url") or "").strip(),
        )


@dataclass
class SearchItem:
    candidate: Candidate
    xsec_token: str


def requires_style_reference(role_class: str) -> bool:
    return str(role_class or "").strip().lower() in REFERENCE_REQUIRED_ROLES


def _recency_score(published_at: str) -> float:
    text = str(published_at or "").strip()
    if not text:
        return 0.0
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        age_days = max(0.0, (datetime.now(timezone.utc) - parsed).total_seconds() / 86400)
        return max(0.0, 1.0 - age_days / 183.0)
    except ValueError:
        return 0.0


def candidate_score(candidate: Candidate, role_tags: list[str]) -> float:
    searchable = " ".join(
        [candidate.title, candidate.description, *candidate.tags]
    ).lower()
    normalized_tags = [tag.strip().lower() for tag in role_tags if tag.strip()]
    matched = sum(1 for tag in normalized_tags if tag in searchable)
    relevance = matched / max(1, len(normalized_tags))
    engagement = math.log10(max(1, candidate.likes + 2 * candidate.favorites)) / 6
    image_quality = 1.0 if candidate.image_urls else 0.0
    recency = _recency_score(candidate.published_at)
    return round(
        0.65 * relevance
        + 0.20 * min(1.0, engagement)
        + 0.10 * image_quality
        + 0.05 * recency,
        6,
    )


def rank_candidates(
    candidates: list[Candidate], role_tags: list[str]
) -> list[Candidate]:
    for candidate in candidates:
        candidate.score = candidate_score(candidate, role_tags)
    return sorted(
        candidates,
        key=lambda item: (item.score, item.likes, item.favorites, item.note_id),
        reverse=True,
    )


def build_reference_record(
    candidate: Candidate,
    *,
    mcp_version: str = "v2.2.6",
    review_status: str = "pending_review",
    review_reason: str = "",
    extracted_visual_elements: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the public, secret-free subset allowed in project artifacts."""
    return {
        "note_id": candidate.note_id,
        "source_url": candidate.source_url,
        "title": candidate.title,
        "author_name": candidate.author_name,
        "published_at": candidate.published_at,
        "likes": candidate.likes,
        "favorites": candidate.favorites,
        "comments": candidate.comments,
        "tags": list(candidate.tags),
        "image_urls": list(candidate.image_urls),
        "local_image_paths": list(candidate.local_image_paths),
        "score": candidate.score,
        "review_status": review_status,
        "review_reason": review_reason,
        "extracted_visual_elements": extracted_visual_elements or {},
        "mcp_version": mcp_version,
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
    }


def build_search_arguments(keyword: str) -> dict[str, Any]:
    return {
        "keyword": keyword,
        "filters": {
            "sort_by": "最多点赞",
            "note_type": "图文",
            "publish_time": "半年内",
        },
    }


def search_feeds_with_fallback(
    client: "XhsMcpClient", keyword: str, force_sort_only: bool = False
) -> tuple[Any, bool]:
    fallback_arguments = {
        "keyword": keyword,
        "filters": {"sort_by": "最多点赞"},
    }
    if force_sort_only:
        return client.call_tool("search_feeds", fallback_arguments), True
    try:
        return client.call_tool("search_feeds", build_search_arguments(keyword)), False
    except McpCallError as exc:
        if "context deadline exceeded" not in str(exc).lower():
            raise
        return client.call_tool("search_feeds", fallback_arguments), True


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _first_text(*values: Any) -> str:
    for value in values:
        if value is not None and str(value).strip():
            return str(value).strip()
    return ""


def _image_url(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    item = _mapping(value)
    return _first_text(
        item.get("urlDefault"),
        item.get("urlPre"),
        item.get("url"),
        item.get("infoList", [{}])[0].get("url")
        if isinstance(item.get("infoList"), list) and item.get("infoList")
        else "",
    )


def extract_search_items(result: Any) -> list[SearchItem]:
    root = _mapping(result)
    feeds = root.get("feeds") or root.get("items") or root.get("data") or []
    if isinstance(feeds, dict):
        feeds = feeds.get("feeds") or feeds.get("items") or []
    output: list[SearchItem] = []
    for raw in feeds if isinstance(feeds, list) else []:
        feed = _mapping(raw)
        card = _mapping(feed.get("noteCard") or feed.get("note_card") or feed)
        user = _mapping(card.get("user"))
        interactions = _mapping(card.get("interactInfo") or card.get("interact_info"))
        cover = card.get("cover")
        url = _image_url(cover)
        note_id = _first_text(feed.get("id"), card.get("noteId"), card.get("note_id"))
        if not note_id:
            continue
        candidate = Candidate.from_mapping(
            {
                "note_id": note_id,
                "title": _first_text(card.get("displayTitle"), card.get("title")),
                "description": _first_text(card.get("desc"), card.get("description")),
                "author_name": _first_text(user.get("nickname"), user.get("name")),
                "published_at": _first_text(card.get("time"), card.get("publishTime")),
                "likes": interactions.get("likedCount") or interactions.get("likes"),
                "favorites": interactions.get("collectedCount")
                or interactions.get("favorites"),
                "comments": interactions.get("commentCount")
                or interactions.get("comments"),
                "tags": card.get("tags") or [],
                "image_urls": [url] if url else [],
                "source_url": f"https://www.xiaohongshu.com/explore/{note_id}",
            }
        )
        output.append(
            SearchItem(
                candidate=candidate,
                xsec_token=_first_text(feed.get("xsecToken"), feed.get("xsec_token")),
            )
        )
    return output


def enrich_candidate_from_detail(candidate: Candidate, result: Any) -> Candidate:
    root = _mapping(result)
    detail = _mapping(root.get("feed") or root.get("note") or root.get("data") or root)
    card = _mapping(detail.get("noteCard") or detail.get("note_card") or detail)
    user = _mapping(card.get("user"))
    interactions = _mapping(card.get("interactInfo") or card.get("interact_info"))
    image_values = card.get("imageList") or card.get("image_list") or card.get("images") or []
    image_urls = [url for url in (_image_url(item) for item in image_values) if url]
    candidate.title = _first_text(card.get("title"), card.get("displayTitle"), candidate.title)
    candidate.description = _first_text(card.get("desc"), card.get("description"), candidate.description)
    candidate.author_name = _first_text(user.get("nickname"), user.get("name"), candidate.author_name)
    candidate.published_at = _first_text(card.get("time"), card.get("publishTime"), candidate.published_at)
    candidate.likes = parse_engagement(interactions.get("likedCount") or candidate.likes)
    candidate.favorites = parse_engagement(interactions.get("collectedCount") or candidate.favorites)
    candidate.comments = parse_engagement(interactions.get("commentCount") or candidate.comments)
    candidate.image_urls = image_urls or candidate.image_urls
    return candidate


def enrich_candidate_safely(client: "XhsMcpClient", item: SearchItem) -> bool:
    if not item.xsec_token:
        return False
    had_timeout = hasattr(client, "timeout")
    previous_timeout = getattr(client, "timeout", 8.0)
    client.timeout = min(previous_timeout, 8.0)
    try:
        detail = client.call_tool(
            "get_feed_detail",
            {
                "feed_id": item.candidate.note_id,
                "xsec_token": item.xsec_token,
                "load_all_comments": False,
            },
        )
    except (McpCallError, McpTransportError):
        return False
    finally:
        if had_timeout:
            client.timeout = previous_timeout
        else:
            delattr(client, "timeout")
    enrich_candidate_from_detail(item.candidate, detail)
    return True


def detail_candidates_for_enrichment(
    candidates: list[Candidate], limit: int
) -> list[Candidate]:
    """Only enrich candidates that can still enter the requested output batch."""
    return candidates[: max(0, limit)]


def download_reference(url: str, target: Path, timeout: float = 30.0) -> Path:
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(target.suffix + ".download")
    if partial.exists():
        partial.unlink()
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            with partial.open("wb") as handle:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    handle.write(chunk)
        if partial.stat().st_size == 0:
            raise DownloadError("reference image was empty")
        os.replace(partial, target)
        return target
    except (urllib.error.URLError, TimeoutError, OSError, DownloadError) as exc:
        if partial.exists():
            partial.unlink()
        if isinstance(exc, DownloadError):
            raise
        raise DownloadError(f"reference download failed: {exc}") from exc


def _is_logged_in(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, dict):
        for key in ("logged_in", "isLoggedIn", "loggedIn"):
            if key in value:
                return bool(value[key])
        text = json.dumps(value, ensure_ascii=False)
    else:
        text = str(value or "")
    lowered = text.lower()
    if any(marker in lowered for marker in ("未登录", "not logged", "login required")):
        return False
    return any(marker in lowered for marker in ("已登录", "logged in", "success"))


def _safe_stem(value: str) -> str:
    cleaned = re.sub(r"[^0-9A-Za-z._-]+", "_", value).strip("._")
    return cleaned[:80] or hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def _extension_for_url(url: str) -> str:
    suffix = Path(urllib.parse.urlparse(url).path).suffix.lower()
    return suffix if suffix in {".jpg", ".jpeg", ".png", ".webp"} else ".jpg"


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def _load_manifest(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"schema_version": 1, "roles": {}}
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("asset_style_references.json must contain an object")
    value.setdefault("schema_version", 1)
    value.setdefault("roles", {})
    return value


def run_search(args: argparse.Namespace) -> int:
    client = XhsMcpClient(args.endpoint, timeout=args.timeout)
    client.initialize()
    status = client.call_tool("check_login_status", {})
    if not _is_logged_in(status):
        print(json.dumps({"status": "login_required"}, ensure_ascii=False))
        return 2

    transient: dict[str, SearchItem] = {}
    fallback_queries: list[str] = []
    for query in args.query:
        result, fallback_used = search_feeds_with_fallback(
            client, query, force_sort_only=args.sort_only
        )
        if fallback_used:
            fallback_queries.append(query)
        for item in extract_search_items(result):
            transient.setdefault(item.candidate.note_id, item)
    if not transient:
        print(json.dumps({"status": "empty_results"}, ensure_ascii=False))
        return 4

    preliminary = rank_candidates(
        [item.candidate for item in transient.values()], args.role_tag
    )
    for candidate in detail_candidates_for_enrichment(preliminary, args.limit):
        item = transient[candidate.note_id]
        enrich_candidate_safely(client, item)

    selected = [
        candidate
        for candidate in rank_candidates(preliminary, args.role_tag)
        if candidate.likes >= args.min_likes and candidate.image_urls
    ][: args.limit]
    if not selected:
        print(json.dumps({"status": "empty_results"}, ensure_ascii=False))
        return 4

    project_dir = Path(args.project_dir).resolve()
    role_dir = project_dir / "assets" / "style_references" / _safe_stem(args.role_id)
    for candidate in selected:
        candidate.local_image_paths = []
        for index, url in enumerate(candidate.image_urls[:3], start=1):
            filename = f"{_safe_stem(candidate.note_id)}_{index:02d}{_extension_for_url(url)}"
            target = role_dir / filename
            try:
                download_reference(url, target, timeout=args.timeout)
            except DownloadError:
                continue
            candidate.local_image_paths.append(
                target.relative_to(project_dir).as_posix()
            )

    selected = [candidate for candidate in selected if candidate.local_image_paths]
    if not selected:
        print(json.dumps({"status": "download_failed"}, ensure_ascii=False))
        return 5

    input_hash = hashlib.sha256(
        json.dumps(
            {"role_tags": args.role_tag, "queries": args.query},
            ensure_ascii=False,
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()
    manifest_path = project_dir / "asset_style_references.json"
    manifest = _load_manifest(manifest_path)
    manifest["mcp_version"] = "v2.2.6"
    manifest["updated_at"] = datetime.now(timezone.utc).isoformat()
    manifest["roles"][args.role_id] = {
        "role_name": args.role_name,
        "role_class": args.role_class,
        "role_tags": list(args.role_tag),
        "queries": list(args.query),
        "filters": build_search_arguments(args.query[0])["filters"],
        "filter_execution": {
            "mode": "sort_only_fallback" if fallback_queries else "full",
            "fallback_queries": fallback_queries,
        },
        "input_hash": input_hash,
        "style_reference_status": "pending_review",
        "candidates": [build_reference_record(item) for item in selected],
    }
    _atomic_write_json(manifest_path, manifest)
    print(
        json.dumps(
            {
                "status": "succeeded",
                "role_id": args.role_id,
                "candidate_count": len(selected),
                "manifest": str(manifest_path),
            },
            ensure_ascii=False,
        )
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--endpoint",
        default=os.environ.get("XIAOHONGSHU_MCP_URL", "http://127.0.0.1:18060/mcp"),
    )
    parser.add_argument("--timeout", type=float, default=30.0)
    subparsers = parser.add_subparsers(dest="command", required=True)

    status = subparsers.add_parser("status")
    status.add_argument("--quiet", action="store_true")

    search = subparsers.add_parser("search")
    search.add_argument("--role-id", required=True)
    search.add_argument("--role-name", required=True)
    search.add_argument(
        "--role-class", choices=sorted(REFERENCE_REQUIRED_ROLES), default="lead"
    )
    search.add_argument("--role-tag", action="append", required=True)
    search.add_argument("--query", action="append", required=True)
    search.add_argument("--project-dir", required=True)
    search.add_argument("--limit", type=int, default=6)
    search.add_argument("--min-likes", type=int, default=0)
    search.add_argument(
        "--sort-only",
        action="store_true",
        help="skip unstable multi-filter UI and apply only the high-like sort",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "status":
            client = XhsMcpClient(args.endpoint, timeout=args.timeout)
            initialized = client.initialize()
            status = client.call_tool("check_login_status", {})
            logged_in = _is_logged_in(status)
            if not args.quiet:
                print(
                    json.dumps(
                        {
                            "status": "logged_in" if logged_in else "login_required",
                            "logged_in": logged_in,
                            "server": initialized.get("serverInfo", {}),
                        },
                        ensure_ascii=False,
                    )
                )
            return 0 if logged_in else 2
        return run_search(args)
    except (McpTransportError, McpCallError, ValueError) as exc:
        print(
            json.dumps(
                {"status": "transport_error", "error": str(exc)},
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 3


def parse_mcp_body(body: bytes) -> dict[str, Any]:
    """Parse either a JSON response or the first JSON message in an SSE body."""
    text = body.decode("utf-8-sig").strip()
    if not text:
        return {}
    if text.startswith("{"):
        return json.loads(text)
    for line in text.splitlines():
        if line.startswith("data:"):
            data = line[5:].strip()
            if data:
                return json.loads(data)
    raise McpTransportError("MCP response contained neither JSON nor SSE data")


def _decode_tool_result(result: dict[str, Any]) -> Any:
    if result.get("isError"):
        messages = [
            str(item.get("text", ""))
            for item in result.get("content", [])
            if item.get("type") == "text"
        ]
        raise McpCallError("\n".join(messages).strip() or "MCP tool call failed")
    content = result.get("content", [])
    text_items = [
        str(item.get("text", ""))
        for item in content
        if item.get("type") == "text"
    ]
    if len(text_items) == 1:
        text = text_items[0].strip()
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text
    if text_items:
        return text_items
    return result.get("structuredContent", result)


class XhsMcpClient:
    allowed_tools = set(ALLOWED_TOOLS)

    def __init__(self, endpoint: str, timeout: float = 30.0):
        self.endpoint = endpoint
        self.timeout = timeout
        self.session_id: str | None = None
        self._request_id = 0
        self.server_info: dict[str, Any] = {}

    def _next_id(self) -> int:
        self._request_id += 1
        return self._request_id

    def _post(self, payload: dict[str, Any], expect_response: bool = True) -> dict[str, Any]:
        headers = {
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
            "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        }
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        request = urllib.request.Request(
            self.endpoint,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                session_id = response.headers.get("Mcp-Session-Id")
                if session_id:
                    self.session_id = session_id
                body = response.read()
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise McpTransportError(f"MCP request failed: {exc}") from exc
        if not expect_response or not body:
            return {}
        message = parse_mcp_body(body)
        if "error" in message:
            error = message["error"]
            raise McpTransportError(
                f"MCP error {error.get('code')}: {error.get('message')}"
            )
        return message

    def _rpc(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        request_id = self._next_id()
        message = self._post(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": params,
            }
        )
        if message.get("id") != request_id:
            raise McpTransportError("MCP response id did not match request")
        return message.get("result", {})

    def initialize(self) -> dict[str, Any]:
        result = self._rpc(
            "initialize",
            {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {
                    "name": "xiaohongshu-reference",
                    "version": "1.0.0",
                },
            },
        )
        self.server_info = dict(result.get("serverInfo", {}))
        self._post(
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            expect_response=False,
        )
        return result

    def call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
        if name not in ALLOWED_TOOLS:
            raise PermissionError(f"read-only Xiaohongshu client rejects tool: {name}")
        result = self._rpc("tools/call", {"name": name, "arguments": arguments})
        return _decode_tool_result(result)


if __name__ == "__main__":
    raise SystemExit(main())
