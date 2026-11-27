#!/usr/bin/env python3
"""校验插件发布产物并按需创建 GitHub Release。"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlparse


SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
REPO_RE = re.compile(r"^[^/\s]+/[^/\s]+$")
GH_TIMEOUT_SECONDS = 120


@dataclass(frozen=True)
class PluginSpec:
    label: str
    name: str
    version: str
    description: str
    author: str
    author_url: str
    dir_name: str
    tag: str
    filename: str
    expected_sha256: str
    expected_size: int
    artifact_path: Path


def compute_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        while chunk := fh.read(65536):
            digest.update(chunk)
    return digest.hexdigest()


def parse_source_dir(source: str) -> tuple[str | None, str | None]:
    parsed = urlparse(source)
    if parsed.scheme != "https" or not parsed.netloc or parsed.query or parsed.fragment:
        return None, f"source URL 格式异常: {source}"

    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) < 5 or parts[2] != "tree":
        return None, f"source URL 需为 .../tree/<tag>/<目录名> 格式: {source}"

    dir_name = parts[-1]
    if dir_name in {".", ".."} or "\\" in dir_name or any(ch.isspace() for ch in dir_name):
        return None, f"source URL 目录名非法: {dir_name}"

    return dir_name, None


def parse_download_url(url: str) -> tuple[str | None, str | None, str | None]:
    parsed = urlparse(url)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.query
        or parsed.fragment
        or parsed.path.endswith("/")
    ):
        return None, None, f"download.url 格式异常: {url}"

    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) != 6 or parts[2] != "releases" or parts[3] != "download":
        return None, None, f"download.url 需为 .../releases/download/<tag>/<文件名> 格式: {url}"

    return parts[4], parts[5], None


def parse_plugin_entry(
    entry: object,
    idx: int,
    repo_root: Path,
) -> tuple[PluginSpec | None, list[str]]:
    if not isinstance(entry, dict):
        return None, [f"plugins[{idx}]: 条目必须是对象"]

    raw_id = entry.get("id")
    label = f"plugins[{idx}] ({raw_id})" if isinstance(raw_id, str) and raw_id.strip() else f"plugins[{idx}]"
    errors: list[str] = []

    required_strings: dict[str, str] = {}
    for field in ("id", "name", "version", "description", "source"):
        value = entry.get(field)
        if not isinstance(value, str) or not value.strip():
            errors.append(f"{label}: 缺少或无效的字段 '{field}'")
        else:
            required_strings[field] = value.strip()

    author = ""
    if "author" in entry:
        raw_author = entry.get("author")
        if not isinstance(raw_author, str) or not raw_author.strip():
            errors.append(f"{label}: 字段 'author' 必须是非空字符串")
        else:
            author = raw_author.strip()

    author_url = ""
    if "authorUrl" in entry:
        raw_author_url = entry.get("authorUrl")
        if not isinstance(raw_author_url, str) or not raw_author_url.strip():
            errors.append(f"{label}: 'authorUrl' 必须是合法的 https URL")
        else:
            candidate_url = raw_author_url.strip()
            parsed_author_url = urlparse(candidate_url)
            if parsed_author_url.scheme != "https" or not parsed_author_url.netloc:
                errors.append(f"{label}: 'authorUrl' 必须是合法的 https URL")
            else:
                author_url = candidate_url
        if not author:
            errors.append(f"{label}: 存在 'authorUrl' 时必须提供 'author'")

    download = entry.get("download")
    dl_url = ""
    expected_sha256 = ""
    expected_size = -1
    if not isinstance(download, dict):
        errors.append(f"{label}: 缺少或无效的对象 'download'")
    else:
        raw_url = download.get("url")
        if not isinstance(raw_url, str) or not raw_url.strip():
            errors.append(f"{label}: 缺少或无效的字段 'download.url'")
        else:
            dl_url = raw_url.strip()

        raw_sha256 = download.get("sha256")
        if not isinstance(raw_sha256, str) or not SHA256_RE.fullmatch(raw_sha256):
            errors.append(f"{label}: 'download.sha256' 必须是 64 位小写十六进制字符串")
        else:
            expected_sha256 = raw_sha256

        raw_size = download.get("size")
        # Python 中 bool 是 int 的子类，需单独排除
        if isinstance(raw_size, bool) or not isinstance(raw_size, int) or raw_size < 0:
            errors.append(f"{label}: 'download.size' 必须是非负整数")
        else:
            expected_size = raw_size

    dir_name: str | None = None
    if "source" in required_strings:
        dir_name, source_err = parse_source_dir(required_strings["source"])
        if source_err:
            errors.append(f"{label}: {source_err}")

    tag: str | None = None
    filename: str | None = None
    if dl_url:
        tag, filename, dl_err = parse_download_url(dl_url)
        if dl_err:
            errors.append(f"{label}: {dl_err}")

    if dir_name and "version" in required_strings and tag and filename:
        expected_tag = f"{dir_name}-v{required_strings['version']}"
        if tag != expected_tag:
            errors.append(f"{label}: download.url 的 tag '{tag}' 与期望 '{expected_tag}' 不一致")

        expected_filename = f"{dir_name}.melodiaplugin"
        if filename != expected_filename:
            errors.append(
                f"{label}: download.url 的文件名 '{filename}' 与期望 '{expected_filename}' 不一致"
            )

    if errors or dir_name is None or tag is None or filename is None:
        return None, errors

    resolved_root = repo_root.resolve()
    artifact_path = (resolved_root / dir_name / filename).resolve()
    if not artifact_path.is_relative_to(resolved_root):
        return None, [f"{label}: 产物路径越界: {dir_name}/{filename}"]

    return (
        PluginSpec(
            label=label,
            name=required_strings["name"],
            version=required_strings["version"],
            description=required_strings["description"],
            author=author,
            author_url=author_url,
            dir_name=dir_name,
            tag=tag,
            filename=filename,
            expected_sha256=expected_sha256,
            expected_size=expected_size,
            artifact_path=artifact_path,
        ),
        [],
    )


def run_gh(args: list[str]) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(
            ["gh", *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=GH_TIMEOUT_SECONDS,
            check=False,
        )
    except FileNotFoundError as exc:
        raise RuntimeError("未找到 gh CLI，请确认已安装并在 PATH 中") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"gh 命令执行超时: gh {' '.join(args)}") from exc
    except OSError as exc:
        raise RuntimeError(f"执行 gh 命令失败: {exc}") from exc

    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def release_exists(tag: str, repo: str) -> tuple[bool, str | None]:
    try:
        code, stdout, stderr = run_gh(["release", "view", tag, "--repo", repo])
    except RuntimeError as exc:
        return False, str(exc)

    if code == 0:
        return True, None

    combined = f"{stderr}\n{stdout}".lower()
    # 仅将明确未找到 Release 视为待发布，避免把鉴权或网络故障误判为不存在
    if "release not found" in combined:
        return False, None

    detail = stderr or stdout or f"退出码 {code}"
    return False, f"查询 Release '{tag}' 失败: {detail}"


def verify_artifact(plugin: PluginSpec) -> list[str]:
    rel_path = f"{plugin.dir_name}/{plugin.filename}"
    if not plugin.artifact_path.is_file():
        return [f"{plugin.label}: 缺少本地打包产物 {rel_path}"]

    errors: list[str] = []
    actual_size = plugin.artifact_path.stat().st_size
    if actual_size != plugin.expected_size:
        errors.append(
            f"{plugin.label}: {rel_path} size 不一致（期望 {plugin.expected_size}，实际 {actual_size}）"
        )

    actual_sha256 = compute_sha256(plugin.artifact_path)
    if actual_sha256 != plugin.expected_sha256:
        errors.append(
            f"{plugin.label}: {rel_path} sha256 不一致（期望 {plugin.expected_sha256}，实际 {actual_sha256}）"
        )

    return errors


def create_release(plugin: PluginSpec, repo: str, target_sha: str) -> str | None:
    title = f"{plugin.name} {plugin.version}"
    lines = [plugin.description, ""]
    if plugin.author:
        escaped_author = plugin.author.replace("[", "\\[").replace("]", "\\]")
        if plugin.author_url:
            lines.append(f"作者：[{escaped_author}]({plugin.author_url})")
        else:
            lines.append(f"作者：{escaped_author}")
    lines.append(
        f"源码：[{plugin.dir_name}](https://github.com/{repo}/tree/{plugin.tag}/{plugin.dir_name})"
    )
    notes = "\n".join(lines)
    try:
        code, stdout, stderr = run_gh(
            [
                "release",
                "create",
                plugin.tag,
                str(plugin.artifact_path),
                "--repo",
                repo,
                "--target",
                target_sha,
                "--title",
                title,
                "--notes",
                notes,
            ]
        )
    except RuntimeError as exc:
        return f"{plugin.label}: 创建 Release '{plugin.tag}' 失败: {exc}"

    if code != 0:
        detail = stderr or stdout or f"退出码 {code}"
        return f"{plugin.label}: 创建 Release '{plugin.tag}' 失败: {detail}"

    return None


def main() -> int:
    default_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description="校验并发布 Melodia 插件 Release")
    parser.add_argument("--publish", action="store_true", help="为未发布且校验通过的插件创建 Release")
    parser.add_argument("--index", type=Path, default=None, help="index.json 路径")
    parser.add_argument("--repo-root", type=Path, default=default_root, help="仓库根目录")
    args = parser.parse_args()

    repo_root = args.repo_root.resolve()
    index_path = args.index.resolve() if args.index else repo_root / "index.json"

    repo = os.environ.get("GITHUB_REPOSITORY", "").strip()
    if not REPO_RE.fullmatch(repo):
        print(
            f"错误: 环境变量 GITHUB_REPOSITORY 无效或未设置（当前值: {repo!r}）",
            file=sys.stderr,
        )
        return 1

    target_sha = os.environ.get("GITHUB_SHA", "").strip()
    if args.publish and not target_sha:
        print("错误: 使用 --publish 时必须设置环境变量 GITHUB_SHA", file=sys.stderr)
        return 1

    try:
        raw_text = index_path.read_text(encoding="utf-8")
        data = json.loads(raw_text)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        print(f"错误: 读取或解析 {index_path} 失败: {exc}", file=sys.stderr)
        return 1

    if not isinstance(data, dict) or not isinstance(data.get("plugins"), list):
        print(f"错误: {index_path} 缺少有效的 'plugins' 数组", file=sys.stderr)
        return 1

    plugins_raw = data["plugins"]
    all_errors: list[str] = []
    parsed_plugins: list[PluginSpec] = []
    seen_tags: set[str] = set()

    for idx, entry in enumerate(plugins_raw):
        spec, parse_errors = parse_plugin_entry(entry, idx, repo_root)
        if parse_errors:
            all_errors.extend(parse_errors)
            continue
        assert spec is not None
        if spec.tag in seen_tags:
            all_errors.append(f"{spec.label}: tag '{spec.tag}' 在 index.json 中重复")
            continue
        seen_tags.add(spec.tag)
        parsed_plugins.append(spec)

    pending_releases: list[PluginSpec] = []
    for plugin in parsed_plugins:
        exists, gh_err = release_exists(plugin.tag, repo)
        if gh_err:
            all_errors.append(f"{plugin.label}: {gh_err}")
            continue
        if exists:
            print(f"跳过 {plugin.tag}（Release 已存在）")
            continue

        artifact_errors = verify_artifact(plugin)
        if artifact_errors:
            all_errors.extend(artifact_errors)
            continue

        pending_releases.append(plugin)

    if all_errors:
        print("校验失败，发现以下问题：", file=sys.stderr)
        for err in all_errors:
            print(f"- {err}", file=sys.stderr)
        return 1

    if not pending_releases:
        print("所有插件 Release 均已存在，无需处理。")
        return 0

    if not args.publish:
        for plugin in pending_releases:
            print(f"校验通过（待发布）: {plugin.tag} -> {plugin.dir_name}/{plugin.filename}")
        return 0

    publish_errors: list[str] = []
    for plugin in pending_releases:
        print(f"正在发布 {plugin.tag}...")
        err = create_release(plugin, repo, target_sha)
        if err:
            publish_errors.append(err)
        else:
            print(f"已发布 {plugin.tag}")

    if publish_errors:
        print("发布过程中发生错误：", file=sys.stderr)
        for err in publish_errors:
            print(f"- {err}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
