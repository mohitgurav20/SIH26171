import urllib.request
import json
import time
import base64

# Simple 1x1 transparent PNG base64
TEST_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

def test_moondream_vision():
    payload = {
        "model": "moondream:latest",
        "prompt": "What do you see in this image? Describe briefly.",
        "images": [TEST_PNG],
        "stream": False,
        "keep_alive": "60m"
    }
    t0 = time.time()
    req = urllib.request.Request(
        "http://127.0.0.1:11434/api/generate",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        res = json.loads(resp.read().decode("utf-8"))
    t1 = time.time()
    print(f"Moondream Vision Latency: {(t1 - t0)*1000:.1f}ms")
    print("Response:", res.get("response"))

if __name__ == "__main__":
    test_moondream_vision()
