import urllib.request
import json
import time

def test_ollama():
    print("Testing Ollama API connection...")
    
    # 1. Test Qwen2.5:3b
    payload = {
        "model": "qwen2.5:3b",
        "prompt": "You are a web agent. User wants: compose a mail to Siddubakka and write hello message. Elements: [1] button 'Compose' [2] input 'Search'. Output JSON with actions.",
        "format": "json",
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
    print(f"Qwen2.5:3b Latency: {(t1 - t0)*1000:.1f}ms")
    print("Response:", res.get("response"))

    # 2. Test Moondream
    print("\nTesting Moondream:latest...")
    payload_v = {
        "model": "moondream:latest",
        "prompt": "What is visible on this screen?",
        "stream": False,
        "keep_alive": "60m"
    }
    t0 = time.time()
    req_v = urllib.request.Request(
        "http://127.0.0.1:11434/api/generate",
        data=json.dumps(payload_v).encode("utf-8"),
        headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req_v, timeout=10) as resp:
        res_v = json.loads(resp.read().decode("utf-8"))
    t1 = time.time()
    print(f"Moondream Latency: {(t1 - t0)*1000:.1f}ms")
    print("Response:", res_v.get("response"))

if __name__ == "__main__":
    test_ollama()
