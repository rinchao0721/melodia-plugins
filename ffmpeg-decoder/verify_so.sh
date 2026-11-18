#!/bin/bash
# 校验产物：架构、JNI 入口、NEEDED 依赖。用法：verify_so.sh <NDK 路径> <产物目录>
set -euo pipefail

NDK_PATH="$1"
OUT_DIR="$2"
READELF="${NDK_PATH}/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-readelf"
ALLOWED_NEEDED="libc.so libm.so libdl.so liblog.so libandroid.so"

declare -A MACHINE=(
  [arm64-v8a]="AArch64"
  [armeabi-v7a]="ARM"
  [x86_64]="Advanced Micro Devices X86-64"
)

for abi in arm64-v8a armeabi-v7a x86_64; do
  so="${OUT_DIR}/${abi}/libffmpegJNI.so"
  echo "== ${abi}"
  [[ -f "${so}" ]] || { echo "缺少 ${so}"; exit 1; }

  header="$("${READELF}" -h "${so}")"
  echo "${header}" | grep -E "^\s*Machine:" | grep -q "${MACHINE[$abi]}" \
    || { echo "${abi} 架构不匹配"; echo "${header}"; exit 1; }

  # 该版本 JNI 通过 JNI_OnLoad 中的 RegisterNatives 注册，无 Java_ 前缀导出
  "${READELF}" --dyn-syms -W "${so}" | grep -qE " JNI_OnLoad$" \
    || { echo "${abi} 未导出 JNI_OnLoad"; exit 1; }
  for needle in \
    androidx/media3/decoder/ffmpeg/FfmpegLibrary \
    androidx/media3/decoder/ffmpeg/FfmpegAudioDecoder \
    ffmpegInitialize; do
    grep -qa "${needle}" "${so}" || { echo "${abi} 缺少 JNI 注册字符串 ${needle}"; exit 1; }
  done

  needed="$("${READELF}" -d "${so}" | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p')"
  echo "NEEDED: ${needed//$'\n'/ }"
  for lib in ${needed}; do
    case " ${ALLOWED_NEEDED} " in
      *" ${lib} "*) ;;
      *) echo "${abi} 依赖了非系统库 ${lib}"; exit 1 ;;
    esac
  done

  "${READELF}" -lW "${so}" | grep " LOAD " | awk '{print $NF}' | grep -qx "0x4000" \
    || { echo "${abi} LOAD 段未按 16KB 对齐"; "${READELF}" -lW "${so}" | grep " LOAD "; exit 1; }
done
echo "校验通过"
