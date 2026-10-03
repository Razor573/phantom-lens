#!/bin/bash
# Cross-compile the stealth keyboard hook for Windows x64 using mingw-w64.
# Produces native/stealth-keyboard/prebuilt/win32-x64/stealth_keyboard.node
#
# The addon does NOT link against node.lib: every NAPI function is resolved
# at load time via GetProcAddress (host exe, then node.dll/libnode.dll), so the binary
# works whatever the host exe is named (electron.exe, PhantomLens.exe...).
#
# Usage: ./build-win.sh [path-to-node-headers-include]
set -e
cd "$(dirname "$0")"

NODE_HEADERS="${1:-$HOME/workspace/.build/node-v20.19.0/include/node}"

if ! command -v x86_64-w64-mingw32-g++ >/dev/null; then
  echo "ERROR: x86_64-w64-mingw32-g++ not found. Install mingw-w64 first." >&2
  exit 1
fi
if [ ! -f "$NODE_HEADERS/node_api.h" ]; then
  echo "ERROR: node_api.h not found under $NODE_HEADERS" >&2
  exit 1
fi

mkdir -p prebuilt/win32-x64
x86_64-w64-mingw32-g++ -shared -O2 \
  -I"$NODE_HEADERS" \
  -o prebuilt/win32-x64/stealth_keyboard.node \
  stealth_keyboard.cpp \
  -static-libgcc -static-libstdc++ -static

echo "Built: prebuilt/win32-x64/stealth_keyboard.node"
echo "--- imported DLLs (should be kernel32/user32 only, no node dependency) ---"
x86_64-w64-mingw32-objdump -p prebuilt/win32-x64/stealth_keyboard.node | grep "DLL Name:"
echo "--- napi_register_module_v1 export ---"
x86_64-w64-mingw32-objdump -p prebuilt/win32-x64/stealth_keyboard.node | grep -i "napi_register_module_v1" | head -3
