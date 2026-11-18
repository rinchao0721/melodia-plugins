#!/usr/bin/env python3
"""生成 ffmpeg-decoder-manifest.json。"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

ABIS = ("arm64-v8a", "armeabi-v7a", "x86_64")
MEDIA3_VERSION = "1.11.1"
JNI_ABI = 1


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        while chunk := fh.read(65536):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--so-dir", required=True, type=Path)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    files = {}
    for abi in ABIS:
        path = args.so_dir / f"libffmpegJNI-{abi}.so"
        if not path.is_file():
            raise SystemExit(f"缺少产物: {path}")
        files[abi] = {
            "file": path.name,
            "sha256": sha256_of(path),
            "size": path.stat().st_size,
        }

    manifest = {
        "version": f"{MEDIA3_VERSION}-{args.revision}",
        "jniAbi": JNI_ABI,
        "files": files,
    }
    args.output.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
