"""Native host entry point and message dispatch (phases 13, 28, 59, 123).

Threading model, because it is the thing most likely to bite whoever
touches this next:

    main thread    reads framed messages from stdin forever. It never does
                   slow work. Replies from the extension are routed to
                   whoever is waiting; everything else is queued.
    worker thread  runs one command at a time (see request_queue).
    warm threads   speculative model loads, daemon, results discarded.

The worker frequently needs something from the browser mid-task -- run this
plan, re-read the page. Native messaging has no request/response built in,
so `ExtensionBridge` sends a message with a `request_id` and blocks on an
Event until the main thread routes the matching reply back. That only works
because the reader never blocks on the worker, which is why the split above
is not negotiable.
"""
from __future__ import annotations

import argparse
import logging
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from .agent_loop import AgentLoop, TaskOutcome
from .config import CONFIG, HOST_NAME, HOST_VERSION, Config
from .decision_log import DecisionLogger, summarize, verify_chain
from .errors import ProtocolError, VoiccError
from .ollama_client import OllamaClient
from .perception import DomProvider, PerceptionLadder, VisionProvider
from .prompts import build_agent_step_prompt
from .protocol import (MessageWriter, install_stdio_guard, iter_messages)
from .request_queue import QueuedRequest, RequestQueue
from .schemas import PageState, PerceptionTier, Plan
from .verifier import ExecutionReport
from .voice import VoiceTranscriber, decode_wav_base64, route

log = logging.getLogger("voicc.host")


def setup_logging(log_dir: Path, verbose: bool = False) -> None:
    """Log to a file and to stderr, both UTF-8.

    stderr matters: on Windows the console is cp1252 by default, and a
    Kannada transcript in a log line would raise UnicodeEncodeError inside
    the logging call -- turning a successful command into a crash.
    """
    log_dir.mkdir(parents=True, exist_ok=True)
    handlers: list[logging.Handler] = [
        logging.FileHandler(log_dir / "host.log", encoding="utf-8")]
    stream = logging.StreamHandler(sys.stderr)
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
    handlers.append(stream)
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        handlers=handlers, force=True)


class ExtensionBridge:
    """Request/response over the one-way native-messaging stream."""

    def __init__(self, writer: MessageWriter, timeout_s: float = 30.0):
        self.writer = writer
        self.timeout_s = timeout_s
        self._pending: dict[str, dict] = {}
        self._events: dict[str, threading.Event] = {}
        self._lock = threading.Lock()

    def send(self, payload: dict) -> None:
        self.writer.send(payload)

    def call(self, message_type: str, payload: dict | None = None, *,
             timeout_s: float | None = None) -> dict:
        request_id = uuid.uuid4().hex[:12]
        event = threading.Event()
        with self._lock:
            self._events[request_id] = event
        self.writer.send({"type": message_type, "request_id": request_id,
                          **(payload or {})})
        if not event.wait(timeout_s or self.timeout_s):
            with self._lock:
                self._events.pop(request_id, None)
            raise ProtocolError(
                f"the extension did not answer {message_type} in "
                f"{timeout_s or self.timeout_s}s",
                user_message="The browser stopped responding to the agent.")
        with self._lock:
            self._events.pop(request_id, None)
            return self._pending.pop(request_id, {})

    def deliver(self, message: dict) -> bool:
        """Route a reply. Returns True if someone was waiting for it."""
        request_id = message.get("in_reply_to")
        if not request_id:
            return False
        with self._lock:
            event = self._events.get(request_id)
            if event is None:
                return False
            self._pending[request_id] = message
        event.set()
        return True


class Host:
    def __init__(self, config: Config | None = None,
                 client: OllamaClient | None = None,
                 writer: MessageWriter | None = None,
                 transcriber: VoiceTranscriber | None = None):
        self.config = config or CONFIG
        self.config.assert_local_only()
        self.writer = writer
        self.bridge: ExtensionBridge | None = None
        self.client = client or OllamaClient(self.config)
        self.transcriber = transcriber
        self.logger = DecisionLogger(
            self.config.log_dir / "decisions.jsonl")
        self.loop: AgentLoop | None = None
        self.queue = RequestQueue(self._handle_queued,
                                  max_depth=self.config.loop.max_queue_depth)
        #: Set by the UI's language selector (phase 120); None means detect.
        self.voice_language: str | None = None
        self.started_at = time.time()

    # -- wiring ------------------------------------------------------------

    def bind(self, writer: MessageWriter) -> None:
        self.writer = writer
        self.bridge = ExtensionBridge(writer)
        ladder = PerceptionLadder([
            DomProvider(),
            VisionProvider(self.client, PerceptionTier.CROPPED_VISION),
            VisionProvider(self.client, PerceptionTier.FULL_PAGE_VISION),
        ])
        self.loop = AgentLoop(self.client, ladder=ladder, logger=self.logger,
                              config=self.config, emit=self._emit)

    def _emit(self, payload: dict) -> None:
        if self.writer is not None:
            try:
                self.writer.send({"type": "progress", **payload})
            except ProtocolError as exc:
                log.warning("dropped progress frame: %s", exc)

    # -- message entry -----------------------------------------------------

    def dispatch(self, message: dict) -> None:
        """Called on the reader thread. Must stay fast."""
        if self.bridge is not None and self.bridge.deliver(message):
            return

        kind = message.get("type", "")
        message_id = message.get("id", "")

        # Answered inline: these are cheap and must work even when the
        # worker is busy with a long inference.
        if kind == "ping":
            self._reply(message_id, {"type": "pong", "host": HOST_NAME,
                                     "version": HOST_VERSION})
            return
        if kind == "health":
            self._reply(message_id, {"type": "health", **self.health()})
            return
        if kind == "set_language":
            language = message.get("language")
            self.voice_language = language if language in ("hi", "kn", "en") \
                else None
            self._reply(message_id, {"type": "ok",
                                     "language": self.voice_language or "auto"})
            return
        if kind == "set_model":
            self._handle_set_model(message_id, message)
            return
        if kind == "verify_log":
            result = verify_chain(self.logger.path)
            self._reply(message_id, {"type": "log_verification",
                                     **result.__dict__})
            return
        if kind == "log_summary":
            self._reply(message_id, {"type": "log_summary",
                                     **summarize(self.logger.path)})
            return

        if kind == "agent_step":
            self._handle_agent_step(message_id, message)
            return

        if kind in ("action_result", "dom_data", "screenshot"):
            self._reply(message_id, {"type": "ack", "status": "received"})
            return

        if kind in ("command", "voice", "confirm"):
            try:
                request = self.queue.submit(kind, {**message,
                                                   "id": message_id})
            except VoiccError as exc:
                self._reply(message_id, {"type": "error", **exc.to_dict()})
                return
            self._reply(message_id, {"type": "queued",
                                     "request_id": request.request_id,
                                     "depth": self.queue.depth()})
            return

        self._reply(message_id, {
            "type": "error", "code": "unknown_message",
            "message": f"unknown message type {kind!r}"})

    def _reply(self, message_id: str, payload: dict) -> None:
        if self.writer is None:
            return
        try:
            self.writer.send({**payload, "in_reply_to": message_id})
        except ProtocolError as exc:
            log.error("could not reply to %s: %s", message_id, exc)
            self.writer.send({"type": "error", "code": "protocol_error",
                              "message": exc.user_message,
                              "in_reply_to": message_id})

    def _handle_agent_step(self, message_id: str, message: dict) -> None:
        """Live-screen VLM + LLM agentic step handler.
        Uses Moondream to comprehend visual screen state + Qwen2.5 to decide actions.
        """
        def _worker():
            try:
                goal = str(message.get("goal", "")).strip()
                page_url = str(message.get("page_url", "")).strip()
                page_title = str(message.get("page_title", "")).strip()
                elements = message.get("elements") or []
                history = message.get("history") or []
                screenshot_b64 = message.get("screenshot_b64", "")

                vlm_summary = ""
                # Step 1: Visual Perception with Moondream (only if vision model is configured and installed)
                vision_model = self.client.config.models.vision if hasattr(self.client, 'config') else ""
                if screenshot_b64 and len(screenshot_b64) > 100 and vision_model:
                    try:
                        vlm_resp = self.client.generate(
                            role="vision",
                            prompt=f"Describe what is visible on screen, open dialogs, forms, or buttons relevant to: {goal}. Keep it concise in 2 sentences.",
                            images=[screenshot_b64],
                            options={"temperature": 0.2}
                        )
                        vlm_summary = vlm_resp.text.strip()
                    except Exception as e:
                        log.warning("Moondream VLM call failed: %s", e)

                # Step 2: Reasoning with Qwen2.5
                prompt = build_agent_step_prompt(
                    goal=goal,
                    page_url=page_url,
                    page_title=page_title,
                    elements=elements,
                    vlm_summary=vlm_summary,
                    history=history
                )

                llm_resp = self.client.generate(
                    role="text",
                    prompt=prompt,
                    schema={
                        "type": "object",
                        "properties": {
                            "actions": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "type": {"type": "string"},
                                        "tag_id": {"type": ["integer", "null"]},
                                        "value": {"type": "string"},
                                        "key": {"type": "string"},
                                        "intent": {"type": "string"}
                                    },
                                    "required": ["type"]
                                }
                            },
                            "reasoning": {"type": "string"},
                            "is_done": {"type": "boolean"}
                        },
                        "required": ["actions", "reasoning", "is_done"]
                    },
                    options={"temperature": 0.1, "top_p": 0.9}
                )

                parsed = {}
                try:
                    import json
                    parsed = json.loads(llm_resp.text)
                except Exception:
                    import re
                    m = re.search(r"\{.*\}", llm_resp.text, re.DOTALL)
                    if m:
                        try:
                            import json
                            parsed = json.loads(m.group(0))
                        except Exception:
                            pass

                actions = parsed.get("actions", [])
                reasoning = parsed.get("reasoning", "")
                is_done = parsed.get("is_done", False)

                self._reply(message_id, {
                    "type": "agent_step_result",
                    "actions": actions,
                    "reasoning": reasoning,
                    "vlm_summary": vlm_summary,
                    "is_done": is_done,
                    "model": llm_resp.model,
                    "latency_ms": round(llm_resp.total_ms, 1)
                })
            except Exception as exc:
                log.exception("agent_step execution failed")
                self._reply(message_id, {
                    "type": "error",
                    "code": "agent_step_error",
                    "message": str(exc)
                })

        threading.Thread(target=_worker, daemon=True).start()

    def _handle_set_model(self, message_id: str, message: dict) -> None:
        """Phase 122 -- swap a role's model without restarting the host."""
        role = message.get("role", "")
        model = message.get("model", "")
        try:
            previous = self.client.swap_role(role, model)
        except VoiccError as exc:
            self._reply(message_id, {"type": "error", **exc.to_dict()})
            return
        log.info("swapped %s model: %s -> %s", role, previous, model)
        self._reply(message_id, {"type": "ok", "role": role,
                                 "previous": previous, "current": model})

    # -- worker ------------------------------------------------------------

    def _handle_queued(self, request: QueuedRequest) -> Any:
        payload = request.payload
        kind = request.kind
        message_id = payload.get("id", "")
        try:
            if kind == "voice":
                outcome = self._run_voice(payload)
            else:
                outcome = self._run_command(
                    payload, confirmed=(kind == "confirm"))
        except VoiccError as exc:
            log.warning("%s failed: %s", kind, exc.detail)
            self._reply(message_id, {"type": "error", **exc.to_dict()})
            return None
        except Exception as exc:                               # noqa: BLE001
            log.exception("unhandled error in %s", kind)
            self._reply(message_id, {
                "type": "error", "code": "internal_error",
                "message": "Something went wrong inside the agent.",
                "detail": f"{type(exc).__name__}: {exc}"})
            return None

        self._reply(message_id, {"type": "result", **outcome.to_dict()})
        # Duplicates that were collapsed onto this request get the same
        # answer, so a double-click resolves rather than hanging.
        for duplicate_id in request.duplicates:
            self._reply(duplicate_id, {"type": "result", "collapsed": True,
                                       **outcome.to_dict()})
        return outcome

    def _run_command(self, payload: dict, *,
                     confirmed: bool = False,
                     task_override: str = "") -> TaskOutcome:
        if self.loop is None:
            raise VoiccError("host is not bound to a stream")
        task = task_override or str(payload.get("task", "")).strip()
        if not task:
            raise VoiccError("empty command",
                             user_message="I didn't get a command.")
        page = PageState.model_validate(payload.get("page") or {})
        return self.loop.run(
            task, page,
            executor=self._execute_plan,
            read_page=self._read_page,
            memories=[str(m) for m in (payload.get("memories") or [])],
            image_b64=str(payload.get("image_b64", "")),
            visible_tags=[int(t) for t in (payload.get("visible_tags") or [])],
            crop_id=str(payload.get("crop_id", "")),
            confirmed=confirmed or bool(payload.get("confirmed")))

    def _run_voice(self, payload: dict) -> TaskOutcome:
        """Phase 63/64 -- transcribe, then take the ordinary path."""
        if self.transcriber is None:
            self.transcriber = VoiceTranscriber(config=self.config.voice)
        clip = decode_wav_base64(str(payload.get("audio_b64", "")))
        language = payload.get("language") or self.voice_language
        transcript = self.transcriber.transcribe(clip, language=language)
        command = route(transcript)
        log.info("voice [%s] %r -> %r", command.language, command.original,
                 command.canonical)
        self._emit({"type": "transcript", **command.to_dict()})
        outcome = self._run_command(payload, task_override=command.canonical)
        # Show the user what they said, not the normalized form.
        outcome.why = (f"heard {command.original!r} in "
                       f"{command.language}; " + outcome.why)
        return outcome

    # -- calls back into the extension -------------------------------------

    def _execute_plan(self, plan: Plan) -> ExecutionReport:
        if self.bridge is None:
            raise VoiccError("no extension bridge")
        reply = self.bridge.call("execute_plan",
                                 {"plan": plan.model_dump(mode="json")},
                                 timeout_s=self.config.loop.task_timeout_s)
        return ExecutionReport.from_message(reply)

    def _read_page(self) -> PageState:
        if self.bridge is None:
            raise VoiccError("no extension bridge")
        reply = self.bridge.call("read_page", {})
        return PageState.model_validate(reply.get("page") or {})

    # -- status ------------------------------------------------------------

    def health(self) -> dict:
        report = self.client.health()
        report.update({
            "host": HOST_NAME,
            "version": HOST_VERSION,
            "uptime_s": round(time.time() - self.started_at, 1),
            "queue": self.queue.stats(),
            "voice_language": self.voice_language or "auto",
            "draft": self.loop.draft.stats.summary() if self.loop else {},
        })
        return report

    # -- lifecycle ---------------------------------------------------------

    def serve(self, stream=None) -> int:
        raw_stdout = install_stdio_guard()
        self.bind(MessageWriter(raw_stdout))
        self.queue.start()
        log.info("%s %s ready (pid %s)", HOST_NAME, HOST_VERSION,
                 __import__("os").getpid())

        report = self.client.health()
        if not report["connected"]:
            # Phase 118: say so immediately instead of hanging on the first
            # command. The extension renders this as a banner, not an error.
            log.warning("Ollama is not reachable at %s",
                        self.config.ollama_url)
        self.writer.send({"type": "ready", "host": HOST_NAME,
                          "version": HOST_VERSION, "health": report})

        source = stream if stream is not None else sys.stdin.buffer
        try:
            for message in iter_messages(source):
                try:
                    self.dispatch(message)
                except Exception:                              # noqa: BLE001
                    log.exception("dispatch failed for %r",
                                  message.get("type"))
        except ProtocolError as exc:
            log.error("protocol error, shutting down: %s", exc)
            return 1
        except KeyboardInterrupt:
            pass
        finally:
            self.queue.stop()
        log.info("stream closed, exiting")
        return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="voicc-host",
        description="SIH26171 native host: agent reasoning, draft planning "
                    "and local voice.")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--health", action="store_true",
                        help="print a health report and exit")
    parser.add_argument("--self-test", action="store_true",
                        help="run the offline scripted end-to-end check")
    # Chrome appends the extension origin and a handle; accept and ignore.
    args, _unknown = parser.parse_known_args(argv)

    setup_logging(CONFIG.log_dir, args.verbose)

    if args.health:
        import json
        print(json.dumps(OllamaClient(CONFIG).health(), indent=2),
              file=sys.stderr)
        return 0

    if args.self_test:
        from .selftest import run_self_test
        return run_self_test()

    return Host(CONFIG).serve()


if __name__ == "__main__":
    raise SystemExit(main())
