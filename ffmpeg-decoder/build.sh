#!/bin/bash
# 构建 libffmpegJNI.so（三 ABI）。用法：build.sh <NDK 路径> <输出目录>
set -euo pipefail

NDK_PATH="$1"
OUT_DIR="$2"
HOST_PLATFORM="linux-x86_64"
MIN_SDK=26
FFMPEG_TAG="n6.0.1"
DECODERS=(
  alac aac mp3 flac opus vorbis ape wavpack tak tta
  dsd_lsbf dsd_msbf dsd_lsbf_planar dsd_msbf_planar
  mlp truehd ac3 eac3
  pcm_u8 pcm_s8 pcm_s16le pcm_s16be pcm_s24le pcm_s24be
  pcm_s32le pcm_s32be pcm_f32le pcm_f32be pcm_f64le pcm_alaw pcm_mulaw
)

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK_DIR="$(mktemp -d)"
MODULE_PATH="${WORK_DIR}/module"
mkdir -p "${MODULE_PATH}/jni" "${OUT_DIR}"
cp "${SRC_DIR}/ffmpeg_jni.cc" "${SRC_DIR}/CMakeLists.txt" "${MODULE_PATH}/jni/"

git clone --depth=1 --branch "${FFMPEG_TAG}" https://github.com/FFmpeg/FFmpeg.git "${MODULE_PATH}/jni/ffmpeg"

bash "${SRC_DIR}/build_ffmpeg.sh" "${MODULE_PATH}" "${NDK_PATH}" "${HOST_PLATFORM}" "${MIN_SDK}" "${DECODERS[@]}"

TOOLCHAIN_FILE="${NDK_PATH}/build/cmake/android.toolchain.cmake"
for abi in arm64-v8a armeabi-v7a x86_64; do
  build_dir="${WORK_DIR}/cmake-${abi}"
  cmake -S "${MODULE_PATH}/jni" -B "${build_dir}" -G Ninja \
    -DCMAKE_TOOLCHAIN_FILE="${TOOLCHAIN_FILE}" \
    -DANDROID_ABI="${abi}" \
    -DANDROID_PLATFORM="android-${MIN_SDK}" \
    -DANDROID_STL=c++_static \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_SHARED_LINKER_FLAGS="-Wl,-z,max-page-size=16384 -Wl,--gc-sections -Wl,--exclude-libs,ALL -Wl,--build-id=none"
  cmake --build "${build_dir}"
  mkdir -p "${OUT_DIR}/${abi}"
  "${NDK_PATH}/toolchains/llvm/prebuilt/${HOST_PLATFORM}/bin/llvm-strip" --strip-unneeded \
    -o "${OUT_DIR}/${abi}/libffmpegJNI.so" "${build_dir}/libffmpegJNI.so"
done
