import urllib.request
import json
import time

def test_prompt():
    prompt = """<|im_start|>system
You are an autonomous browser agent. Your job is to complete the user's goal by deciding the next web action based on the interactive elements on the page.

Output JSON only in this format:
{
  "actions": [
    {"type": "click", "tag_id": 1, "intent": "Click Compose"},
    {"type": "type", "tag_id": 4, "value": "Siddubakka", "intent": "Type recipient"}
  ],
  "reasoning": "Explain step-by-step what action is taken and why",
  "is_done": false
}

Action types:
- "click": click button, link, tab, or checkbox (requires tag_id)
- "type": fill input or editable text area (requires tag_id, value)
- "navigate": go to URL (requires value="https://...")
- "scroll": scroll page (requires value="down" or "up")
- "done": when the user's goal has been fully completed (tag_id null, is_done true)

Rules:
1. Only use tag_id numbers that exist in the ELEMENTS list.
2. For typing, specify the exact text in 'value'.
3. Chain multiple logical actions if they are ready (e.g. click Compose, or fill inputs).
<|im_end|>
<|im_start|>user
GOAL: compose a mail to Siddubakka and write hello message
CURRENT PAGE: https://mail.google.com - Gmail Inbox
ELEMENTS:
[1] button "Compose"
[2] input "Search mail"
[3] link "Inbox"

Decide the next action(s).
<|im_end|>
<|im_start|>assistant
"""
    payload = {
        "model": "qwen2.5:3b",
        "prompt": prompt,
        "format": "json",
        "stream": False,
        "options": {
            "temperature": 0.1,
            "top_p": 0.9
        },
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
    print(f"Latency: {(t1 - t0)*1000:.1f}ms")
    print("Response:\n", res.get("response"))

if __name__ == "__main__":
    test_prompt()
