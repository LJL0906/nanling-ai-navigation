#!/usr/bin/env python3
"""下载缺失的导航图标到本地，不修改原始站点库；仅使用 Python 标准库。"""
from __future__ import annotations

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
from html.parser import HTMLParser
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import struct
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROOT = Path(__file__).resolve().parent.parent
LOCAL_ICON = re.compile(r"^/site-icons/([a-f0-9]{64}\.(?:png|ico|jpg|gif|webp))$")
MAX_IMAGE = 2 * 1024 * 1024
MAX_HTML = 512 * 1024
USER_AGENT = "Mozilla/5.0 (compatible; NanlingIconFetcher/1.0; favicon caching)"


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def atomic_write(path: Path, content: bytes):
    """同目录临时文件 + 原子替换，避免中断写坏 manifest 或图片。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(content)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def write_json(path: Path, value):
    atomic_write(path, (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


def image_extension(data: bytes) -> str | None:
    """校验常见位图文件结构；HTML、SVG、空响应不可伪装成图标落盘。"""
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 45:
        if data[12:16] == b"IHDR" and b"IEND" in data[-12:]:
            width, height = struct.unpack(">II", data[16:24])
            return "png" if 0 < width <= 4096 and 0 < height <= 4096 else None
    if data.startswith((b"GIF87a", b"GIF89a")) and len(data) >= 14 and data.endswith(b";"):
        width, height = struct.unpack("<HH", data[6:10])
        return "gif" if 0 < width <= 4096 and 0 < height <= 4096 else None
    if data.startswith(b"\xff\xd8\xff") and data.rstrip().endswith(b"\xff\xd9"):
        return "jpg" if len(data) >= 32 else None
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP" and len(data) >= 20:
        return "webp" if int.from_bytes(data[4:8], "little") + 8 == len(data) else None
    if data[:4] == b"\x00\x00\x01\x00" and len(data) >= 22:
        count = int.from_bytes(data[4:6], "little")
        if not 0 < count <= 256 or len(data) < 6 + count * 16:
            return None
        for offset in range(6, 6 + count * 16, 16):
            length, start = struct.unpack("<II", data[offset + 8:offset + 16])
            if not length or start < 6 + count * 16 or start + length > len(data):
                return None
        return "ico"
    return None


def public_url(url: str) -> str:
    """只访问公开 HTTP(S)，初始 URL 及每次重定向均检查。"""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username or parts.password:
        raise ValueError("仅支持无账号密码的公开 HTTP(S) 地址")
    port = parts.port or (443 if parts.scheme == "https" else 80)
    addresses = socket.getaddrinfo(parts.hostname, port, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
        raise ValueError("跳过本机、内网及保留地址")
    return urlunsplit((parts.scheme, parts.netloc, parts.path or "/", parts.query, ""))


class PublicRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return super().redirect_request(req, fp, code, msg, headers, public_url(newurl))


def fetch(url: str, timeout: float, *, html: bool = False):
    request = Request(public_url(url), headers={"User-Agent": USER_AGENT, "Accept-Encoding": "identity"})
    with build_opener(PublicRedirect()).open(request, timeout=timeout) as response:
        limit = MAX_HTML if html else MAX_IMAGE
        body = response.read(limit + 1)
        if len(body) > limit and not html:
            raise ValueError("图片超过 2 MiB 限制")
        return body[:limit], response.geturl(), response.headers.get_content_charset() or "utf-8"


class IconLinks(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.base = None
        self.links = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "base" and self.base is None and attrs.get("href"):
            self.base = attrs["href"]
        if tag == "link" and attrs.get("href"):
            rel = set((attrs.get("rel") or "").lower().split())
            if rel & {"icon", "apple-touch-icon", "apple-touch-icon-precomposed"}:
                self.links.append(attrs["href"])


def discover_icons(body: bytes, page_url: str, encoding: str):
    parser = IconLinks()
    try:
        text = body.decode(encoding, errors="replace")
    except LookupError:
        text = body.decode("utf-8", errors="replace")
    parser.feed(text)
    base = urljoin(page_url, parser.base) if parser.base else page_url
    return list(dict.fromkeys(urljoin(base, href) for href in parser.links))[:4]


def source_image(site):
    icon = site.get("icon") or {}
    return icon.get("value") if icon.get("type") == "url" else None


def origin_of(url: str):
    parsed = urlsplit(url)
    return urlunsplit((parsed.scheme, parsed.netloc, "/", "", ""))


def download_icon(site, icons_dir: Path, timeout: float):
    errors, tried = [], set()

    def attempt(url):
        if not url or url in tried:
            return None
        tried.add(url)
        try:
            body, final_url, _ = fetch(url, timeout)
            extension = image_extension(body)
            if not extension:
                raise ValueError("不是支持的完整位图（SVG/HTML/截断文件会跳过）")
            filename = f"{hashlib.sha256(body).hexdigest()}.{extension}"
            destination = icons_dir / filename
            if not destination.exists() or destination.read_bytes() != body:
                atomic_write(destination, body)
            return {"path": f"/site-icons/{filename}", "source": final_url}
        except (OSError, ValueError, HTTPError, URLError) as error:
            errors.append({"url": url, "error": str(error)[:240]})
            return None

    origin = origin_of(site["url"])
    for candidate in (source_image(site), urljoin(origin, "favicon.ico")):
        result = attempt(candidate)
        if result:
            return {**result, "errors": errors}
    try:
        body, final_url, encoding = fetch(site["url"], timeout, html=True)
        candidates = discover_icons(body, final_url, encoding)
        candidates.append(urljoin(origin_of(final_url), "favicon.ico"))
        for candidate in candidates:
            result = attempt(candidate)
            if result:
                return {**result, "errors": errors}
    except (OSError, ValueError, HTTPError, URLError) as error:
        errors.append({"url": site["url"], "error": str(error)[:240]})
    return {"path": None, "errors": errors}


def cached_icon(value, icons_dir: Path):
    match = LOCAL_ICON.fullmatch(value) if isinstance(value, str) else None
    if not match:
        return False
    path = icons_dir / match[1]
    if not path.is_file() or path.stat().st_size > MAX_IMAGE:
        return False
    body = path.read_bytes()
    return (image_extension(body) == path.suffix[1:]
            and hashlib.sha256(body).hexdigest() == path.stem)


def select_sites(sites, manifest, icons_dir, legacy):
    branded = {f"{category['slug']}/{site['slug']}"
               for category in legacy.get("categories", [])
               for site in category["sites"] if site.get("icon")}
    counts, pending = Counter(), []
    for site in sites:
        old_brand = any(source.get("dataset") == "sites.json" and source.get("recordId") in branded
                        for source in site.get("sources", []))
        if (site.get("icon") or {}).get("type") == "iconify" or old_brand:
            counts["existing_brand"] += 1
        elif cached_icon(manifest.get(site["id"]), icons_dir):
            counts["cached"] += 1
        else:
            pending.append(site)
    return pending, counts


def positive(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("必须为正整数")
    return number


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=ROOT / "src/data/导航数据.json")
    parser.add_argument("--legacy", type=Path, default=ROOT / "src/data/sites.json")
    parser.add_argument("--manifest", type=Path, default=ROOT / "src/data/站点图标.json")
    parser.add_argument("--icons-dir", type=Path, default=ROOT / "public/site-icons")
    parser.add_argument("--report", type=Path, default=ROOT / "reports/站点图标补充报告.json")
    parser.add_argument("--workers", type=positive, default=12, help="并发数，最多 32（默认 12）")
    parser.add_argument("--timeout", type=positive, default=5, help="单次连接/读取超时秒数（默认 5）")
    parser.add_argument("--limit", type=positive, help="只处理前 N 条待补充记录，便于试跑")
    parser.add_argument("--dry-run", action="store_true", help="仅统计缺失图标，不联网、不写文件")
    args = parser.parse_args(argv)
    if args.workers > 32:
        parser.error("--workers 不得超过 32")
    return args


def run(args):
    data = read_json(args.data)
    sites = data["sites"]
    if not isinstance(sites, list) or any(not isinstance(s, dict) or not s.get("id") or not s.get("url") for s in sites):
        raise ValueError("站点库必须包含具有 id、url 字段的 sites 数组")
    manifest = read_json(args.manifest) if args.manifest.exists() else {}
    if not isinstance(manifest, dict):
        raise ValueError("图标映射必须为 JSON 对象")
    legacy = read_json(args.legacy)
    pending, counts = select_sites(sites, manifest, args.icons_dir, legacy)
    selected = pending[:args.limit] if args.limit else pending
    print(f"共 {len(sites)} 条；保留品牌图标 {counts['existing_brand']}；有效缓存 {counts['cached']}；"
          f"待补充 {len(pending)}；本次处理 {len(selected)}。", flush=True)
    if args.dry_run:
        return 0
    # 同一源站/同一原始图片共享抓取结果，防止同域名重复并发请求。
    groups = {}
    for site in selected:
        key = (origin_of(site["url"]), source_image(site))
        groups.setdefault(key, []).append(site)
    records, completed = [], 0
    started = time.monotonic()
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    lock = args.manifest.with_suffix(args.manifest.suffix + ".lock")
    try:
        descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        raise ValueError(f"另一个图标任务可能仍在运行：{lock}；确认没有进程后再手动移除锁") from None
    os.close(descriptor)
    try:
        # 拿锁后确认快照未被其它任务更新，避免覆盖对方已经完成的映射。
        current = read_json(args.manifest) if args.manifest.exists() else {}
        if current != manifest:
            raise ValueError("图标映射已被其它任务更新，请重新运行")
        with ThreadPoolExecutor(max_workers=args.workers) as executor:
            jobs = {executor.submit(download_icon, group[0], args.icons_dir, args.timeout): group
                    for group in groups.values()}
            try:
                for future in as_completed(jobs):
                    group = jobs[future]
                    try:
                        result = future.result()
                    except Exception as error:
                        result = {"path": None, "errors": [{"error": str(error)[:240]}]}
                    status = "downloaded" if result["path"] else "failed"
                    for site in group:
                        if result["path"]:
                            manifest[site["id"]] = result["path"]
                        elif site["id"] in manifest:
                            # 失效映射移除，前端继续显示原来的首字兜底，不留下坏图。
                            del manifest[site["id"]]
                        records.append({"id": site["id"], "name": site.get("name"), "url": site["url"],
                                        "status": status, **result})
                        counts[status] += 1
                    completed += len(group)
                    if completed % 25 < len(group) or completed == len(selected):
                        write_json(args.manifest, dict(sorted(manifest.items())))
                        print(f"[{completed}/{len(selected)}] 新增 {counts['downloaded']}，失败 {counts['failed']}", flush=True)
            except KeyboardInterrupt:
                # 不再启动排队中的网络任务；仅等待正在执行的请求超时/完成。
                for future in jobs:
                    future.cancel()
                write_json(args.manifest, dict(sorted(manifest.items())))
                raise
        write_json(args.manifest, dict(sorted(manifest.items())))
        remaining = len(pending) - counts["downloaded"]
        report = {"generatedAt": datetime.now(timezone.utc).isoformat(), "total": len(sites),
                  "selected": len(selected), "counts": dict(counts), "remaining": remaining,
                  "elapsedSeconds": round(time.monotonic() - started, 1),
                  "note": "图标获取成功不代表站点可用、安全或已获品牌授权；失败项下次运行自动重试。",
                  "records": sorted(records, key=lambda record: record["id"])}
        write_json(args.report, report)
        print(f"完成：新增 {counts['downloaded']}，失败 {counts['failed']}，仍待补充 {remaining}。\n"
              f"映射：{args.manifest}\n报告：{args.report}", flush=True)
        return 0
    finally:
        lock.unlink(missing_ok=True)


def main(argv=None):
    try:
        return run(arguments(argv))
    except KeyboardInterrupt:
        print("任务已中断；已保存的图标和检查点会在下次运行时复用。", file=sys.stderr)
        return 130
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"图标补充失败：{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
