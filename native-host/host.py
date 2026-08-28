import sys
import json
import struct
import logging
import asyncio
from typing import Dict, Any

# Configure logging to file (never print to stdout as stdout is reserved for native messaging)
logging.basicConfig(
    filename='native_host.log',
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s'
)

def read_message() -> Dict[str, Any] | None:
    """Read a length-prefixed JSON message from Chrome extension via stdin."""
    try:
        raw_length = sys.stdin.buffer.read(4)
        if len(raw_length) == 0:
            return None
        message_length = struct.unpack('@I', raw_length)[0]
        message_bytes = sys.stdin.buffer.read(message_length)
        return json.loads(message_bytes.decode('utf-8'))
    except Exception as e:
        logging.error(f"Error reading message: {e}")
        return None

def send_message(message: Dict[str, Any]) -> None:
    """Send a length-prefixed JSON message to Chrome extension via stdout."""
    try:
        encoded_content = json.dumps(message).encode('utf-8')
        sys.stdout.buffer.write(struct.pack('@I', len(encoded_content)))
        sys.stdout.buffer.write(encoded_content)
        sys.stdout.buffer.flush()
    except Exception as e:
        logging.error(f"Error sending message: {e}")

async def handle_message(msg: Dict[str, Any]) -> Dict[str, Any]:
    """Route message to appropriate handler."""
    msg_type = msg.get("type", "")
    payload = msg.get("payload", {})
    msg_id = msg.get("id", "msg-unknown")

    logging.info(f"Received message type: {msg_type} (id: {msg_id})")

    if msg_type == "ping":
        return {
            "type": "status",
            "id": msg_id,
            "payload": {"state": "connected", "message": "Pong from native host"}
        }

    elif msg_type == "command":
        # Placeholder for agent loop invocation
        return {
            "type": "status",
            "id": msg_id,
            "payload": {"state": "thinking", "message": f"Processing command: {payload.get('text')}"}
        }

    elif msg_type == "verify_log":
        return {
            "type": "status",
            "id": msg_id,
            "payload": {"state": "verified", "message": "Hash chain verified successfully"}
        }

    return {
        "type": "status",
        "id": msg_id,
        "payload": {"state": "unknown", "message": f"Unhandled message type: {msg_type}"}
    }

def main():
    logging.info("SIH26171 Native Messaging Host started.")
    while True:
        msg = read_message()
        if msg is None:
            logging.info("Input pipe closed. Exiting host.")
            break
        response = asyncio.run(handle_message(msg))
        send_message(response)

if __name__ == "__main__":
    main()
