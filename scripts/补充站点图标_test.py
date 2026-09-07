"""图标补充脚本的离线测试；不访问真实网络、不修改仓库数据。"""
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("icon_fetcher", Path(__file__).with_name("补充站点图标.py"))
icons = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(icons)
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")
PNG_NAME = hashlib.sha256(PNG).hexdigest() + ".png"
PNG_PATH = "/site-icons/" + PNG_NAME


def site(identifier="site_test", url="https://example.com/tool", icon=None):
    return {"id": identifier, "name": "测试站点", "url": url, "icon": icon, "sources": []}


class ImageTests(unittest.TestCase):
    def test_recognizes_png_and_rejects_html_svg_truncation(self):
        self.assertEqual(icons.image_extension(PNG), "png")
        for body in (b"", b"<html>404</html>", b"<svg xmlns='http://www.w3.org/2000/svg'/>", PNG[:35]):
            self.assertIsNone(icons.image_extension(body))

    def test_ico_validates_offsets(self):
        header = b"\x00\x00\x01\x00\x01\x00"
        entry = b"\x01\x01\x00\x00\x01\x00\x20\x00" + struct.pack("<II", len(PNG), 22)
        self.assertEqual(icons.image_extension(header + entry + PNG), "ico")
        self.assertIsNone(icons.image_extension(header + entry + PNG[:-1]))
        self.assertIsNone(icons.image_extension(header + entry[:8] + struct.pack("<II", 8, 2) + PNG))

    def test_cache_checks_content_hash_not_just_presence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / PNG_NAME).write_bytes(PNG)
            self.assertTrue(icons.cached_icon(PNG_PATH, root))
            self.assertFalse(icons.cached_icon("/site-icons/../../secret.png", root))
            self.assertFalse(icons.cached_icon("https://example.com/a.png", root))
            self.assertFalse(icons.cached_icon(None, root))
            (root / PNG_NAME).write_bytes(b"not an icon")
            self.assertFalse(icons.cached_icon(PNG_PATH, root))


class DiscoveryTests(unittest.TestCase):
    def test_relative_base_shortcut_and_touch_icons(self):
        html = b'''<base href="/assets/"><link rel="shortcut ICON" href="logo.png?a=1&amp;b=2">
            <link rel="apple-touch-icon" href="//cdn.example.com/touch.png">
            <link rel="icon" href="logo.png?a=1&amp;b=2"><link rel="stylesheet" href="main.css">'''
        self.assertEqual(icons.discover_icons(html, "https://example.com/tools/", "utf-8"), [
            "https://example.com/assets/logo.png?a=1&b=2", "https://cdn.example.com/touch.png"])

    def test_invalid_encoding_and_candidate_limit(self):
        html = b"".join(f'<link rel="icon" href="/{i}.png">'.encode() for i in range(10))
        self.assertEqual(len(icons.discover_icons(html, "https://example.com/", "invalid-encoding")), 4)

    def test_private_and_credential_urls_are_rejected(self):
        for url in ("file:///tmp/icon.png", "data:image/png;base64,aa", "https://user:pass@example.com"):
            with self.assertRaises(ValueError):
                icons.public_url(url)
        for address in ("127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "192.168.1.1"):
            with patch.object(icons.socket, "getaddrinfo", return_value=[(0, 0, 0, "", (address, 443))]):
                with self.assertRaises(ValueError):
                    icons.public_url("https://example.com/icon.png")

    def test_public_urls_strip_fragments(self):
        with patch.object(icons.socket, "getaddrinfo", return_value=[(0, 0, 0, "", ("8.8.8.8", 443))]):
            self.assertEqual(icons.public_url("https://example.com/icon.png#fragment"), "https://example.com/icon.png")

    def test_redirect_to_private_host_is_rejected(self):
        with patch.object(icons.socket, "getaddrinfo", return_value=[(0, 0, 0, "", ("127.0.0.1", 80))]):
            with self.assertRaises(ValueError):
                icons.PublicRedirect().redirect_request(None, None, 302, "Found", {}, "http://localhost/favicon.ico")


class DownloadTests(unittest.TestCase):
    def test_existing_source_is_preferred_and_download_is_deduplicated(self):
        entry = site(icon={"type": "url", "value": "https://cdn.example.com/logo.png"})
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(icons, "fetch", return_value=(PNG, entry["icon"]["value"], "utf-8")) as fetch:
                first = icons.download_icon(entry, root, 3)
                second = icons.download_icon(entry, root, 3)
                self.assertEqual(fetch.call_args.args[0], entry["icon"]["value"])
                self.assertEqual(first["path"], PNG_PATH)
                self.assertEqual(second["path"], PNG_PATH)
                self.assertEqual(len(list(root.iterdir())), 1)

    def test_invalid_favicon_falls_back_to_homepage_discovery(self):
        def fetch(url, timeout, *, html=False):
            if html:
                return b'<link rel="icon" href="/brand.png">', "https://example.com/", "utf-8"
            if url.endswith("brand.png"):
                return PNG, url, "utf-8"
            return b"<html>not an image</html>", url, "utf-8"
        with tempfile.TemporaryDirectory() as directory, patch.object(icons, "fetch", side_effect=fetch):
            result = icons.download_icon(site(), Path(directory), 3)
            self.assertEqual(result["path"], PNG_PATH)
            self.assertEqual(len(result["errors"]), 1)

    def test_failure_is_reported_without_writing_fake_icon(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(icons, "fetch", side_effect=OSError("timeout")):
            result = icons.download_icon(site(), Path(directory), 3)
            self.assertIsNone(result["path"])
            self.assertEqual(len(result["errors"]), 2)
            self.assertFalse(list(Path(directory).iterdir()))


class RunTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = self.root / "data.json"
        self.legacy = self.root / "legacy.json"
        self.manifest = self.root / "manifest.json"
        self.report = self.root / "report.json"
        self.assets = self.root / "icons"
        icons.write_json(self.legacy, {"categories": []})
        icons.write_json(self.data, {"sites": [site()]})
        self.args = icons.arguments(["--data", str(self.data), "--legacy", str(self.legacy),
            "--manifest", str(self.manifest), "--report", str(self.report), "--icons-dir", str(self.assets)])

    def test_dry_run_does_not_fetch_or_create_outputs(self):
        self.args.dry_run = True
        before = self.data.read_bytes()
        with patch.object(icons, "fetch") as fetch:
            self.assertEqual(icons.run(self.args), 0)
            fetch.assert_not_called()
        self.assertEqual(self.data.read_bytes(), before)
        self.assertFalse(self.manifest.exists())
        self.assertFalse(self.report.exists())
        self.assertFalse(self.assets.exists())

    def test_resume_preserves_brand_and_cached_icons_and_repairs_missing_files(self):
        brand = site("site_brand", icon={"type": "iconify", "value": "simple-icons:python"})
        cached = site("site_cached")
        repair = site("site_repair")
        failed = site("site_fail", url="https://failed.example.com")
        icons.write_json(self.data, {"sites": [brand, cached, repair, failed]})
        self.assets.mkdir()
        (self.assets / PNG_NAME).write_bytes(PNG)
        icons.write_json(self.manifest, {cached["id"]: PNG_PATH, repair["id"]: "/site-icons/" + "0" * 64 + ".png"})
        original = self.data.read_bytes()
        def download(entry, directory, timeout):
            return {"path": PNG_PATH if entry["id"] == "site_repair" else None, "errors": []}
        with patch.object(icons, "download_icon", side_effect=download) as download_mock:
            icons.run(self.args)
            self.assertEqual(download_mock.call_count, 2)
        self.assertEqual(self.data.read_bytes(), original)
        self.assertEqual(icons.read_json(self.manifest), {cached["id"]: PNG_PATH, repair["id"]: PNG_PATH})
        report = icons.read_json(self.report)
        self.assertEqual(report["counts"], {"existing_brand": 1, "cached": 1, "downloaded": 1, "failed": 1})
        self.assertEqual(report["remaining"], 1)

    def test_same_origin_reuses_result_and_honors_limit(self):
        icons.write_json(self.data, {"sites": [site("site_a"), site("site_b"), site("site_c")]})
        self.args.limit = 2
        with patch.object(icons, "download_icon", return_value={"path": PNG_PATH, "errors": []}) as download:
            icons.run(self.args)
            download.assert_called_once()
        self.assertEqual(len(icons.read_json(self.manifest)), 2)
        self.assertEqual(icons.read_json(self.report)["remaining"], 1)

    def test_legacy_brand_is_not_overwritten(self):
        entry = site()
        entry["sources"] = [{"dataset": "sites.json", "recordId": "tools/old"}]
        legacy = {"categories": [{"slug": "tools", "sites": [{"slug": "old", "icon": "simple-icons:python"}]}]}
        pending, counts = icons.select_sites([entry], {}, self.assets, legacy)
        self.assertFalse(pending)
        self.assertEqual(counts["existing_brand"], 1)

    def test_lock_prevents_concurrent_manifest_writes(self):
        lock = self.manifest.with_suffix(".json.lock")
        lock.touch()
        with patch.object(icons, "download_icon") as download:
            with self.assertRaisesRegex(ValueError, "另一个"):
                icons.run(self.args)
            download.assert_not_called()
        self.assertTrue(lock.exists())
        self.assertFalse(self.manifest.exists())

    def test_interrupt_saves_checkpoint_and_cleans_lock(self):
        with patch.object(icons, "as_completed", side_effect=KeyboardInterrupt), \
                patch.object(icons, "download_icon", return_value={"path": None, "errors": []}):
            with self.assertRaises(KeyboardInterrupt):
                icons.run(self.args)
        self.assertEqual(icons.read_json(self.manifest), {})
        self.assertFalse(self.manifest.with_suffix(".json.lock").exists())

    def test_atomic_json_is_unicode_and_no_temp_files_remain(self):
        icons.write_json(self.manifest, {"中文": "图标"})
        self.assertEqual(json.loads(self.manifest.read_text(encoding="utf-8")), {"中文": "图标"})
        self.assertFalse(list(self.root.glob(".manifest.json.*")))


if __name__ == "__main__":
    unittest.main()
