import hashlib
import json
import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parent
FILES = (
    "plugin.json",
    "ui/wide.json",
    "ui/player.json",
    "ui/lyrics.json",
    "ui/mini.json",
    "background/mist.js",
)
# 与宿主 PlayerLayout 的上限一致
MAX_DEPTH = 8
MAX_NODES = 128


def measure(node, depth=1):
    if depth > MAX_DEPTH:
        raise ValueError(f"层级超过 {MAX_DEPTH}")
    count = 1
    for child in node.get("children", []):
        count += measure(child, depth + 1)
    return count


def has_play_pause(node):
    if node.get("type") == "controls" and "playPause" in node.get("buttons", []):
        return True
    return any(has_play_pause(child) for child in node.get("children", []))


def check_layouts():
    manifest = json.loads((root / "plugin.json").read_text(encoding="utf-8"))
    for area, file in manifest["contributes"]["playerLayouts"].items():
        data = json.loads((root / file).read_text(encoding="utf-8"))
        layout = data.get("layout")
        if layout == "host":
            extra = set(data) - {"layout", "frame"}
            if extra:
                raise ValueError(f"{file}: 宿主内容模式不支持 {sorted(extra)}")
            continue
        count = measure(layout)
        if count > MAX_NODES:
            raise ValueError(f"{file}: 节点超过 {MAX_NODES}")
        if not has_play_pause(layout):
            raise ValueError(f"{file}: 缺少 playPause")
        print(f"{area}: {count} 个节点")


def main():
    try:
        check_layouts()
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"布局校验失败：{error}", file=sys.stderr)
        return 1

    out = root / "mist-player.melodiaplugin"
    with ZipFile(out, "w", ZIP_DEFLATED) as package:
        for name in FILES:
            package.write(root / name, name)

    data = out.read_bytes()
    print(out)
    print(f"sha256 {hashlib.sha256(data).hexdigest()}")
    print(f"size {len(data)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
