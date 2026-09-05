"""Startup script for SIH26171 Local Agent HTTP Server.
Usage:
    py server/run.py
"""
import os
import sys
from pathlib import Path

# Add root directory to sys.path
_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))
sys.path.insert(0, str(_ROOT / "native-host"))

from server.app import app

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print("=" * 65)
    print("  SIH26171 Browser AI Agent — Local HTTP Reasoning Gateway")
    print(f"  Running on: http://127.0.0.1:{port}")
    print("  Endpoints:")
    print(f"    - GET  http://127.0.0.1:{port}/api/health")
    print(f"    - POST http://127.0.0.1:{port}/api/plan")
    print(f"    - POST http://127.0.0.1:{port}/api/voice")
    print(f"    - GET  http://127.0.0.1:{port}/api/audit_log")
    print(f"    - POST http://127.0.0.1:{port}/api/verify_log")
    print("=" * 65)
    app.run(host="127.0.0.1", port=port, debug=False, use_reloader=False)
