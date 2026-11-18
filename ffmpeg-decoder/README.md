# FFmpeg 解码组件

为 Melodia Android 端提供 `libffmpegJNI.so`，用于解码系统缺失的 ALAC 等格式。App 内置 media3 官方 `decoder_ffmpeg` 的 Java 层（包名 `androidx.media3.decoder.ffmpeg`），本目录只负责原生库的编译发布，App 运行时下载后以 `System.load(绝对路径)` 加载。

## 来源

- `ffmpeg_jni.cc`、`CMakeLists.txt`：取自 androidx/media tag `1.11.1`，`libraries/decoder_ffmpeg/src/main/jni/`，未改动（Apache 2.0）。
- `build_ffmpeg.sh`：同上来源，改动仅两处：去掉 x86 构建，并追加 `--disable-autodetect --disable-network --disable-debug --enable-small --extra-cflags=-fPIC`。
- FFmpeg：`n6.0.1`（官方 README 推荐 6.0 系列）。
- JNI 通过 `JNI_OnLoad` 内 `RegisterNatives` 注册，不导出 `Java_...` 符号。

## 构建约定

- ABI：arm64-v8a、armeabi-v7a、x86_64，每个 ABI 一个自包含的 `libffmpegJNI.so`（ffmpeg 静态链接，`c++_static`，仅依赖系统库）。
- minSdk 26，NDK `26.3.11579264`，`-Wl,-z,max-page-size=16384`。
- 解码器：alac aac mp3 flac opus vorbis ape wavpack tak tta dsd_lsbf dsd_msbf dsd_lsbf_planar dsd_msbf_planar mlp truehd ac3 eac3 及 pcm_u8/s8/s16le/s16be/s24le/s24be/s32le/s32be/f32le/f32be/f64le/alaw/mulaw。
- `jniAbi = 1`：JNI 接口版本，Java 层与原生库不兼容时递增。

## 发布

Actions 手动运行 `构建 FFmpeg 解码组件`：

- `publish=false`：仅上传 artifact 与 `ffmpeg-decoder-manifest.json`。
- `publish=true`：创建 Release `ffmpeg-decoder-v1.11.1-<revision>`，附件为 `libffmpegJNI-<abi>.so` 与清单。

清单格式：`{version, jniAbi, files: {<abi>: {file, sha256, size}}}`。
