"""Native-messaging host registration (phase 11).

Chrome will not talk to a native host it has not been told about. The
registration is per-OS and per-browser, and the three things that actually
go wrong are all handled here:

  * the manifest's `path` must be absolute -- a relative path silently
    fails to launch with no error anywhere the user can see;
  * `allowed_origins` must contain the extension's real id, and the id
    changes when the extension is reloaded from a different folder unless
    a `key` is pinned in its manifest;
  * on Windows the manifest is found through a registry value, not a
    directory scan, so copying the file somewhere sensible is not enough.

Windows   HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\<name>
          (default value = absolute path to the manifest json)
macOS     ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
Linux     ~/.config/google-chrome/NativeMessagingHosts/

Because the host is Python, Chrome cannot execute the .py directly on
Windows -- it needs a .bat shim, which this script writes.

    python install/register_host.py --extension-id <id>
    python install/register_host.py --extension-id <id> --uninstall
    python install/register_host.py --print-only
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HOST_NAME = "com.sih26171.voicc"
MANIFEST_PATH = ROOT / "install" / f"{HOST_NAME}.json"
LAUNCHER_BAT = ROOT / "install" / "voicc_host.bat"
LAUNCHER_SH = ROOT / "install" / "voicc_host.sh"

#: Chrome, Chromium, Edge and Brave all read the same manifest format from
#: their own locations. Registering everywhere is harmless and saves a
#: debugging session when the demo laptop turns out to run Brave.
BROWSER_DIRS = {
    "Windows": {
        "chrome": r"Software\Google\Chrome\NativeMessagingHosts",
        "edge": r"Software\Microsoft\Edge\NativeMessagingHosts",
        "brave": r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
    },
    "Darwin": {
        "chrome": "~/Library/Application Support/Google/Chrome/"
                  "NativeMessagingHosts",
        "edge": "~/Library/Application Support/Microsoft Edge/"
                "NativeMessagingHosts",
        "brave": "~/Library/Application Support/BraveSoftware/"
                 "Brave-Browser/NativeMessagingHosts",
    },
    "Linux": {
        "chrome": "~/.config/google-chrome/NativeMessagingHosts",
        "chromium": "~/.config/chromium/NativeMessagingHosts",
        "brave": "~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
    },
}


def write_launcher() -> Path:
    """Write the shim Chrome actually executes."""
    python = Path(sys.executable).resolve()
    if platform.system() == "Windows":
        # pythonw would detach stdio and break native messaging; use the
        # console interpreter and keep stdout binary-clean.
        LAUNCHER_BAT.write_text(
            "@echo off\r\n"
            "setlocal\r\n"
            f'set "PYTHONPATH={ROOT}"\r\n'
            "set PYTHONIOENCODING=utf-8\r\n"
            "set PYTHONUNBUFFERED=1\r\n"
            f'"{python}" -m voicc_host.main %*\r\n',
            encoding="utf-8")
        return LAUNCHER_BAT

    LAUNCHER_SH.write_text(
        "#!/usr/bin/env bash\n"
        f'export PYTHONPATH="{ROOT}"\n'
        "export PYTHONIOENCODING=utf-8\n"
        "export PYTHONUNBUFFERED=1\n"
        f'exec "{python}" -m voicc_host.main "$@"\n',
        encoding="utf-8")
    LAUNCHER_SH.chmod(0o755)
    return LAUNCHER_SH


def build_manifest(extension_ids: list[str], launcher: Path) -> dict:
    return {
        "name": HOST_NAME,
        "description": "SIH26171 on-device browser agent host",
        "path": str(launcher.resolve()),          # must be absolute
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{eid}/"
                            for eid in extension_ids],
    }


def register_windows(manifest_path: Path, uninstall: bool) -> list[str]:
    import winreg

    touched = []
    for browser, subkey in BROWSER_DIRS["Windows"].items():
        key_path = f"{subkey}\\{HOST_NAME}"
        try:
            if uninstall:
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_path)
                touched.append(f"removed HKCU\\{key_path}")
            else:
                with winreg.CreateKey(winreg.HKEY_CURRENT_USER,
                                      key_path) as key:
                    winreg.SetValueEx(key, "", 0, winreg.REG_SZ,
                                      str(manifest_path))
                touched.append(f"HKCU\\{key_path} -> {manifest_path}")
        except FileNotFoundError:
            touched.append(f"(not registered) {browser}")
        except OSError as exc:
            touched.append(f"FAILED {browser}: {exc}")
    return touched


def register_posix(manifest: dict, uninstall: bool) -> list[str]:
    touched = []
    for browser, raw_dir in BROWSER_DIRS[platform.system()].items():
        target_dir = Path(os.path.expanduser(raw_dir))
        target = target_dir / f"{HOST_NAME}.json"
        if uninstall:
            if target.exists():
                target.unlink()
                touched.append(f"removed {target}")
            continue
        if not target_dir.parent.exists():
            touched.append(f"(skipped, {browser} not installed) {target_dir}")
            continue
        target_dir.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        touched.append(str(target))
    return touched


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="register_host")
    parser.add_argument(
        "--extension-id", action="append", default=[],
        help="the unpacked extension's id from chrome://extensions "
             "(repeatable)")
    parser.add_argument("--uninstall", action="store_true")
    parser.add_argument("--print-only", action="store_true",
                        help="show the manifest without installing it")
    args = parser.parse_args(argv)

    system = platform.system()
    if system not in BROWSER_DIRS:
        print(f"unsupported platform {system!r}", file=sys.stderr)
        return 2

    if not args.extension_id and not args.uninstall:
        print("An extension id is required.\n"
              "  1. chrome://extensions -> Developer mode -> Load unpacked\n"
              "  2. copy the id shown under the extension's name\n"
              "  3. python install/register_host.py --extension-id <id>\n\n"
              "The id changes if the extension is loaded from a different\n"
              "folder. Pin it by adding a 'key' to the extension manifest,\n"
              "or re-run this script after reloading.", file=sys.stderr)
        return 2

    launcher = write_launcher()
    manifest = build_manifest(args.extension_id, launcher)

    if args.print_only:
        print(json.dumps(manifest, indent=2))
        return 0

    if not args.uninstall:
        MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
        MANIFEST_PATH.write_text(json.dumps(manifest, indent=2),
                                 encoding="utf-8")
        print(f"launcher: {launcher}")
        print(f"manifest: {MANIFEST_PATH}")

    if system == "Windows":
        results = register_windows(MANIFEST_PATH, args.uninstall)
    else:
        results = register_posix(manifest, args.uninstall)

    for line in results:
        print(f"  {line}")

    if not args.uninstall:
        print("\nRestart the browser, then check the extension can reach "
              "the host:\n  the host answers {\"type\":\"ping\"} with "
              "{\"type\":\"pong\"}.\n"
              "If nothing happens, run the launcher directly -- a Python "
              "import error\nshows up there and nowhere in Chrome.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
