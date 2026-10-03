// stealth_keyboard.cpp
//
// Windows-only NAPI addon for PhantomLens: a low-level keyboard hook
// (WH_KEYBOARD_LL) that captures keystrokes OS-wide, translates them to
// characters, and SWALLOWS them so the foreground app never sees them.
// This is what lets the user type into PhantomLens without the window
// ever taking focus (the "natively" stealth-typing approach).
//
// Linking note: the NAPI functions are NOT linked at build time. They are
// resolved at load time via GetProcAddress, probing the host exe first and
// then node.dll / libnode.dll (Electron on Windows keeps NAPI in node.dll,
// not in the exe). This keeps the binary working no matter what the host
// exe is named, and avoids needing node.lib.
//
// Build (cross-compile from Linux):
//   x86_64-w64-mingw32-g++ -shared -O2 -o stealth_keyboard.node \
//     stealth_keyboard.cpp -I<node-headers>/include/node \
//     -static-libgcc -static-libstdc++ -static
//
// Safety rules:
//  - Only plain typing keys are swallowed. Any chord with Ctrl / Alt / Win
//    passes through untouched, so the user can always Alt+Tab away and the
//    app's own global shortcuts (Ctrl+K, Ctrl+Enter, ...) keep working.
//  - Swallow decisions are made on key-DOWN and remembered per virtual-key
//    code, so the matching key-UP gets the same treatment (no stuck keys).
//  - Characters are translated with ToUnicodeEx using the FOREGROUND
//    window's keyboard layout, so non-US layouts work.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

// Only for NAPI *types* - no linking against node.lib; every function used
// is resolved at runtime from the host process (see ResolveNapi).
#include <node_api.h>

#include <atomic>
#include <mutex>
#include <string>
#include <unordered_set>

// ---------------------------------------------------------------------------
// Runtime NAPI resolution
// ---------------------------------------------------------------------------
#define NAPI_FNS                               \
  X(napi_create_threadsafe_function)           \
  X(napi_call_threadsafe_function)             \
  X(napi_release_threadsafe_function)          \
  X(napi_create_object)                        \
  X(napi_create_string_utf8)                   \
  X(napi_set_named_property)                   \
  X(napi_create_function)                      \
  X(napi_call_function)                        \
  X(napi_get_cb_info)                          \
  X(napi_get_undefined)                        \
  X(napi_throw_error)                          \
  X(napi_throw_type_error)                     \
  X(napi_get_boolean)

struct NapiApi {
#define X(name) decltype(&name) name;
  NAPI_FNS
#undef X
};
static NapiApi g_napi;
static bool g_napiResolved = false;

static bool ResolveFromModule(HMODULE mod) {
#define X(fname)                                                        \
  g_napi.fname = reinterpret_cast<decltype(&fname)>(                     \
      GetProcAddress(mod, #fname));                                      \
  if (!g_napi.fname) return false;
  NAPI_FNS
#undef X
  return true;
}

static bool ResolveNapi() {
  if (g_napiResolved) return true;
  // The NAPI functions live in the Node runtime module, which is NOT always
  // the host exe: plain node.exe statically links them, but Electron keeps
  // them in node.dll (some distributions: libnode.dll). Probe each candidate
  // and use the first one that exports every function we need.
  static const wchar_t* kCandidates[] = {
      nullptr,          // host exe (plain node.exe, static builds)
      L"node.dll",      // Electron on Windows
      L"libnode.dll",   // alternative Node distributions
  };
  for (const wchar_t* name : kCandidates) {
    HMODULE mod = GetModuleHandleW(name);
    if (mod && ResolveFromModule(mod)) {
      g_napiResolved = true;
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Shared hook state
// ---------------------------------------------------------------------------
static HHOOK g_hook = nullptr;
static DWORD g_hookThreadId = 0;
static HANDLE g_hookThread = nullptr;
static std::atomic<bool> g_typing{false};    // true while a typing session is live
static std::atomic<bool> g_installed{false}; // true once the hook thread runs
static std::mutex g_stateMutex;
static napi_threadsafe_function g_tsfn = nullptr;

// Virtual-key codes whose key-DOWN we swallowed; their key-UP must also be
// swallowed so the foreground app never sees a half key press.
static std::unordered_set<DWORD> g_swallowedDown;
static std::mutex g_swallowedMutex;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Cached CapsLock toggle, seeded on the calling (JS) thread at session start -
// the hook worker thread cannot read toggle state reliably (mirrors natively).
static std::atomic<bool> g_capsLock{false};

// Translate a virtual key to UTF-8 text using the foreground layout.
// Keyboard state is built from GetAsyncKeyState (reliable from any thread)
// instead of GetKeyboardState (unreliable on the hook worker thread).
static std::string VkToUtf8(DWORD vk, DWORD scanCode) {
  BYTE kbState[256] = {0};
  if (GetAsyncKeyState(VK_SHIFT) & 0x8000) kbState[VK_SHIFT] = 0x80;
  if (GetAsyncKeyState(VK_CONTROL) & 0x8000) kbState[VK_CONTROL] = 0x80;
  if (GetAsyncKeyState(VK_MENU) & 0x8000) kbState[VK_MENU] = 0x80;
  if (g_capsLock.load()) kbState[VK_CAPITAL] = 0x01;

  HWND fg = GetForegroundWindow();
  HKL layout = GetKeyboardLayout(fg ? GetWindowThreadProcessId(fg, nullptr) : 0);

  WCHAR buf[8] = {0};
  int n = ToUnicodeEx(vk, scanCode, kbState, buf, 7, 0, layout);
  if (n <= 0) return "";  // dead key, no char, or error

  char utf8[32] = {0};
  int m = WideCharToMultiByte(CP_UTF8, 0, buf, n, utf8, sizeof(utf8) - 1, nullptr, nullptr);
  if (m <= 0) return "";
  return std::string(utf8, m);
}

struct KeyEvent {
  std::string kind;  // "char" | "backspace" | "enter" | "escape"
  std::string ch;    // UTF-8 char, only for kind == "char"
};

static void CallJs(napi_env env, napi_value js_cb, void* /*context*/, void* data) {
  KeyEvent* ev = static_cast<KeyEvent*>(data);
  napi_value obj, kindVal, undef, result;
  g_napi.napi_create_object(env, &obj);
  g_napi.napi_create_string_utf8(env, ev->kind.c_str(), ev->kind.size(), &kindVal);
  g_napi.napi_set_named_property(env, obj, "kind", kindVal);
  if (!ev->ch.empty()) {
    napi_value chVal;
    g_napi.napi_create_string_utf8(env, ev->ch.c_str(), ev->ch.size(), &chVal);
    g_napi.napi_set_named_property(env, obj, "char", chVal);
  }
  g_napi.napi_get_undefined(env, &undef);
  napi_value argv[1] = {obj};
  g_napi.napi_call_function(env, undef, js_cb, 1, argv, &result);
  delete ev;
}

static void EmitKey(KeyEvent ev) {
  if (!g_tsfn) return;
  KeyEvent* heapEv = new KeyEvent(std::move(ev));
  napi_status st = g_napi.napi_call_threadsafe_function(
      g_tsfn, heapEv, napi_tsfn_blocking);
  if (st != napi_ok) delete heapEv;
}

static bool CtrlHeld()  { return (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0; }
static bool AltHeld()   { return (GetAsyncKeyState(VK_MENU) & 0x8000) != 0; }
static bool WinHeld()   {
  return (GetAsyncKeyState(VK_LWIN) & 0x8000) != 0 ||
         (GetAsyncKeyState(VK_RWIN) & 0x8000) != 0;
}

// ---------------------------------------------------------------------------
// The low-level hook
// ---------------------------------------------------------------------------
static LRESULT CALLBACK LowLevelKeyboardProc(int nCode, WPARAM wParam, LPARAM lParam) {
  if (nCode == HC_ACTION && g_typing.load()) {
    const KBDLLHOOKSTRUCT* k = reinterpret_cast<KBDLLHOOKSTRUCT*>(lParam);
    const bool isDown = (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN);
    const bool isUp = (wParam == WM_KEYUP || wParam == WM_SYSKEYUP);
    const DWORD vk = k->vkCode;

    // Track CapsLock toggles (the worker thread can't query them reliably).
    if (vk == VK_CAPITAL && isDown) {
      g_capsLock.store(!g_capsLock.load());
    }

    if (isDown) {
      bool swallow = false;
      KeyEvent ev;

      const bool ctrl = CtrlHeld();
      const bool alt = AltHeld();
      // AltGr shows up as Ctrl+Alt on EU layouts and produces REAL text
      // (@ { } \ € …). It must be captured, not passed through - otherwise
      // those characters leak into the foreground app (mirrors natively).
      const bool altgr = ctrl && alt;

      if (WinHeld()) {
        // Win chord: NEVER swallow. The user must always be able to
        // Alt+Tab away.
        swallow = false;
      } else if ((ctrl || alt) && !altgr) {
        // Plain Ctrl/Alt chord: NEVER swallow. Our own global shortcuts
        // (Ctrl+K, Ctrl+Enter, ...) must keep working.
        swallow = false;
      } else if (vk == VK_BACK && !altgr) {
        ev.kind = "backspace"; swallow = true;
      } else if (vk == VK_RETURN && !altgr) {
        ev.kind = "enter"; swallow = true;
      } else if (vk == VK_ESCAPE && !altgr) {
        ev.kind = "escape"; swallow = true;
      } else if (vk == VK_SPACE && !altgr) {
        ev.kind = "char"; ev.ch = " "; swallow = true;
      } else if (vk == VK_TAB && !altgr) {
        ev.kind = "char"; ev.ch = "\t"; swallow = true;
      } else if ((vk >= 0x30 && vk <= 0x5A) ||       // 0-9, A-Z
                 (vk >= VK_OEM_1 && vk <= VK_OEM_8) || // punctuation block
                 (vk >= VK_NUMPAD0 && vk <= VK_NUMPAD9) ||
                 vk == VK_MULTIPLY || vk == VK_ADD || vk == VK_SEPARATOR ||
                 vk == VK_SUBTRACT || vk == VK_DECIMAL || vk == VK_DIVIDE) {
        std::string ch = VkToUtf8(vk, k->scanCode);
        if (!ch.empty()) { ev.kind = "char"; ev.ch = ch; swallow = true; }
      }
      // Anything else (arrows, F-keys, modifiers themselves, ...) passes through.

      {
        std::lock_guard<std::mutex> lock(g_swallowedMutex);
        if (swallow) g_swallowedDown.insert(vk);
        else g_swallowedDown.erase(vk);
      }

      if (swallow) {
        EmitKey(std::move(ev));
        return 1;  // swallow: the foreground app never sees this key
      }
      return CallNextHookEx(g_hook, nCode, wParam, lParam);
    }

    if (isUp) {
      bool wasSwallowed = false;
      {
        std::lock_guard<std::mutex> lock(g_swallowedMutex);
        auto it = g_swallowedDown.find(vk);
        if (it != g_swallowedDown.end()) {
          wasSwallowed = true;
          g_swallowedDown.erase(it);
        }
      }
      if (wasSwallowed) return 1;  // swallow the matching key-up
      return CallNextHookEx(g_hook, nCode, wParam, lParam);
    }
  }
  return CallNextHookEx(g_hook, nCode, wParam, lParam);
}

static DWORD WINAPI HookThreadProc(LPVOID) {
  g_hook = SetWindowsHookExW(WH_KEYBOARD_LL, LowLevelKeyboardProc,
                             GetModuleHandleW(nullptr), 0);
  if (!g_hook) return 1;
  g_hookThreadId = GetCurrentThreadId();
  g_installed.store(true);

  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }

  UnhookWindowsHookEx(g_hook);
  g_hook = nullptr;
  g_installed.store(false);
  return 0;
}

// ---------------------------------------------------------------------------
// NAPI surface: startTyping(callback) / stopTyping()
// ---------------------------------------------------------------------------
static napi_value StartTyping(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  g_napi.napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) {
    g_napi.napi_throw_type_error(env, nullptr, "startTyping(callback) requires a function");
    return nullptr;
  }

  std::lock_guard<std::mutex> lock(g_stateMutex);

  if (!g_tsfn) {
    napi_value name;
    g_napi.napi_create_string_utf8(env, "stealth-keys", NAPI_AUTO_LENGTH, &name);
    // NOTE: async_resource must be C++ nullptr (Node then creates a default
    // object). Passing a JS undefined *value* fails CHECK_TO_OBJECT inside
    // napi_create_threadsafe_function and the call returns napi_invalid_arg.
    napi_status st = g_napi.napi_create_threadsafe_function(
        env, argv[0], nullptr, name,
        0,            // max_queue_size: unlimited
        1,            // initial_thread_count
        nullptr,      // thread_finalize_data
        nullptr,      // thread_finalize_cb
        nullptr,      // context
        CallJs,       // call_js_cb
        &g_tsfn);
    if (st != napi_ok || !g_tsfn) {
      g_napi.napi_throw_error(env, nullptr, "Failed to create threadsafe function");
      return nullptr;
    }
  }

  if (!g_installed.load() && !g_hookThread) {
    g_hookThread = CreateThread(nullptr, 0, HookThreadProc, nullptr, 0, nullptr);
    if (!g_hookThread) {
      g_napi.napi_throw_error(env, nullptr, "Failed to create hook thread");
      return nullptr;
    }
    for (int i = 0; i < 50 && !g_installed.load(); ++i) Sleep(10);
    if (!g_installed.load()) {
      g_napi.napi_throw_error(env, nullptr, "Keyboard hook failed to install");
      return nullptr;
    }
  }

  // Seed CapsLock toggle state here on the JS thread (reliable), the hook
  // worker thread keeps it current from VK_CAPITAL key-downs afterwards.
  g_capsLock.store((GetKeyState(VK_CAPITAL) & 0x0001) != 0);

  g_typing.store(true);
  napi_value result;
  g_napi.napi_get_boolean(env, true, &result);
  return result;
}

static napi_value StopTyping(napi_env env, napi_callback_info /*info*/) {
  std::lock_guard<std::mutex> lock(g_stateMutex);
  g_typing.store(false);
  {
    std::lock_guard<std::mutex> slock(g_swallowedMutex);
    g_swallowedDown.clear();
  }
  napi_value result;
  g_napi.napi_get_boolean(env, true, &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  if (!ResolveNapi()) return nullptr;

  napi_value fn;
  g_napi.napi_create_function(env, "startTyping", NAPI_AUTO_LENGTH, StartTyping, nullptr, &fn);
  g_napi.napi_set_named_property(env, exports, "startTyping", fn);
  g_napi.napi_create_function(env, "stopTyping", NAPI_AUTO_LENGTH, StopTyping, nullptr, &fn);
  g_napi.napi_set_named_property(env, exports, "stopTyping", fn);
  return exports;
}

// Module registration: no link-time dependency on node - the host calls in.
extern "C" NAPI_MODULE_EXPORT napi_value napi_register_module_v1(napi_env env,
                                                                 napi_value exports) {
  return Init(env, exports);
}
