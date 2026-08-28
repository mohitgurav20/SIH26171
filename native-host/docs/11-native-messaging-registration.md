# 11 — Native-messaging host registration

Phase 11's done-condition is being able to explain the steps. This is that
explanation; `install/register_host.py` automates it.

## What Chrome actually requires

Chrome launches the host as a **child process** and talks to it over
stdin/stdout. It will not launch anything it has not been told about, and
the telling is per-OS.

1. **A manifest** describing the host:

```json
{
  "name": "com.sih26171.voicc",
  "description": "SIH26171 on-device browser agent host",
  "path": "C:\\Users\\Public\\voicc\\native-host\\install\\voicc_host.bat",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<EXTENSION_ID>/"]
}
```

2. **Registration of that manifest**, which differs by platform:

| OS | Where |
|---|---|
| Windows | registry value `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.sih26171.voicc`, default value = absolute path to the manifest |
| macOS | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.sih26171.voicc.json` |
| Linux | `~/.config/google-chrome/NativeMessagingHosts/com.sih26171.voicc.json` |

On Windows the manifest is found *through the registry*, not by scanning a
directory. Copying the JSON somewhere sensible does nothing on its own.

3. **The extension declares the permission** and connects:

```jsonc
// extension manifest
"permissions": ["nativeMessaging"]
```
```js
const port = chrome.runtime.connectNative("com.sih26171.voicc");
port.onMessage.addListener(handleHostMessage);
port.postMessage({ type: "ping", id: "1" });
```

## The four things that actually go wrong

**Relative `path`.** A relative path silently fails to launch, with no
error surfaced anywhere the user can see. It must be absolute.

**Wrong extension id.** The id is derived from the unpacked folder path, so
it changes when the extension is loaded from somewhere else, and the host
then refuses the connection. Pin it by adding a `key` to the extension
manifest, or re-run the registration script after reloading.

**Python cannot be launched directly on Windows.** Chrome executes the
`path` as a program; a `.py` file is not one. `register_host.py` writes a
`.bat` shim that sets `PYTHONPATH`, forces `PYTHONIOENCODING=utf-8`, and
runs `python -m voicc_host.main`. Never point the shim at `pythonw` — it
detaches stdio and native messaging dies with it.

**Anything printed to stdout corrupts the stream.** The protocol *is*
stdout. One stray `print()` in any imported module and every subsequent
message is misframed. `protocol.install_stdio_guard()` takes the real
stdout handle and rebinds `sys.stdout` to stderr, so an accidental print
lands in the log instead of breaking the session.

## Wire format

4-byte native-endian unsigned length prefix, then that many bytes of UTF-8
JSON. Limits: 1 MB per message **from** the host, 64 MB **to** it.
Screenshot payloads blow past the 1 MB host limit easily, which is why
images travel extension→host only, and `encode_message` refuses an
oversized frame loudly rather than truncating it.

## Verifying it works

```bash
python install/register_host.py --extension-id <id>
# restart the browser, then from the extension:
#   port.postMessage({type: "ping", id: "1"})  ->  {type: "pong", ...}
```

If nothing happens, run the launcher directly. A Python import error shows
up there and **nowhere in Chrome** — Chrome reports a failed host launch as
a generic disconnect with no detail.

```bash
install/voicc_host.bat        # Windows
python -m voicc_host.main --health
```
