"""Transport, streaming, logging, queueing, cache and voice plumbing."""
from __future__ import annotations

import io
import json
import threading
import time

import pytest

from voicc_host.decision_log import (DecisionLogger, read_entries, summarize,
                                     verify_chain)
from voicc_host.dom_batch import DomBatch, exists, label_of
from voicc_host.errors import ProtocolError, QueueOverflow, TranscriptionError
from voicc_host.ollama_client import (Completion, OllamaClient, PrefixSession,
                                      ScriptedBackend)
from voicc_host.protocol import (MAX_MESSAGE_FROM_HOST, encode_message,
                                 iter_messages, read_message)
from voicc_host.prompts import (build_draft_prompt, build_reasoning_prompt,
                                estimate_tokens, render_memory, stable_prefix)
from voicc_host.request_queue import RequestQueue
from voicc_host.schemas import Decision, Element, PageState
from voicc_host.streaming import PartialPlanReader, StreamingPlanCollector
from voicc_host.voice import ScriptedTranscriberBackend, VoiceTranscriber, route
from voicc_host.voice.transcriber import AudioClip, script_of
from voicc_host.voice.router import normalize_text
from voicc_host.workflow_cache import CacheOutcome, WorkflowCache

from voicc_host.selftest import dashboard_page


# -- protocol --------------------------------------------------------------

def test_message_round_trip() -> None:
    frame = encode_message({"type": "ping", "id": "abc"})
    assert read_message(io.BytesIO(frame)) == {"type": "ping", "id": "abc"}


def test_closed_stream_reads_as_clean_end() -> None:
    assert read_message(io.BytesIO(b"")) is None


def test_truncated_body_is_an_error_not_a_hang() -> None:
    frame = encode_message({"type": "ping"})
    with pytest.raises(ProtocolError, match="truncated"):
        read_message(io.BytesIO(frame[:-3]))


def test_oversized_outbound_message_is_refused() -> None:
    """Chrome caps host messages at 1 MB; fail loudly rather than truncate."""
    with pytest.raises(ProtocolError, match="too large"):
        encode_message({"blob": "x" * (MAX_MESSAGE_FROM_HOST + 10)})


def test_unicode_survives_the_wire() -> None:
    payload = {"text": "ವರದಿ ಪುಟ ತೆರೆ", "hi": "रिपोर्ट खोलो"}
    assert read_message(io.BytesIO(encode_message(payload))) == payload


def test_multiple_messages_stream_in_order() -> None:
    buffer = b"".join(encode_message({"n": i}) for i in range(5))
    assert [m["n"] for m in iter_messages(io.BytesIO(buffer))] == list(range(5))


# -- streaming (phase 108) -------------------------------------------------

FULL_PLAN = ('{"actions":[{"type":"click","tag_id":1,"intent":"Login"},'
             '{"type":"type","tag_id":2,"value":"admin"},'
             '{"type":"click","tag_id":3,"intent":"Submit"}],'
             '"confidence":0.88,"reasoning":"login"}')


@pytest.mark.parametrize("chunk", [1, 3, 7, 40, 500])
def test_actions_are_recovered_at_any_chunk_size(chunk: int) -> None:
    reader = PartialPlanReader()
    found = []
    for i in range(0, len(FULL_PLAN), chunk):
        found += reader.feed(FULL_PLAN[i:i + chunk])
    assert len(found) == 3
    assert json.loads(found[0])["tag_id"] == 1


def test_first_action_is_ready_before_the_stream_ends() -> None:
    collector = StreamingPlanCollector()
    for i in range(0, len(FULL_PLAN), 5):
        collector.on_token(FULL_PLAN[i:i + 5])
        time.sleep(0.0005)
    outcome = collector.finish(FULL_PLAN)
    assert outcome.first_action_ms is not None
    assert outcome.head_start_ms > 0, \
        "step 1 must be ready before the plan finishes streaming"
    assert outcome.first_action().tag_id == 1


def test_braces_inside_string_values_do_not_split_an_action() -> None:
    raw = ('{"actions":[{"type":"type","tag_id":2,"value":"a{b}c"}],'
           '"confidence":0.5}')
    reader = PartialPlanReader()
    found = []
    for char in raw:
        found += reader.feed(char)
    assert len(found) == 1
    assert json.loads(found[0])["value"] == "a{b}c"


def test_truncated_stream_yields_no_complete_action() -> None:
    reader = PartialPlanReader()
    assert reader.feed('{"actions":[{"type":"click","tag_id":1') == []


# -- prompts (phases 66, 107, 126, 150) ------------------------------------

def test_memory_is_capped_at_three_facts() -> None:
    rendered = render_memory([f"fact {i}" for i in range(10)])
    assert rendered.count("- fact") == 3


def test_draft_prompt_stays_smaller_than_the_full_prompt() -> None:
    page = dashboard_page()
    draft = build_draft_prompt("search for orbit", page)
    full = build_reasoning_prompt("search for orbit", page,
                                  memories=["the search box is at the top"])
    assert draft.tokens() < full.tokens(), \
        "the draft model's speed advantage comes from a smaller prompt"


def test_prefix_is_stable_across_steps_of_one_task() -> None:
    """Phase 107 -- a changing prefix silently defeats KV-cache reuse."""
    page_one = dashboard_page()
    page_two = dashboard_page(elements=page_one.elements[:3])
    memories = ["reports live under /reports"]
    first = build_reasoning_prompt("export the report", page_one,
                                   memories=memories)
    second = build_reasoning_prompt("export the report", page_two,
                                    memories=memories)
    assert stable_prefix(first) == stable_prefix(second)
    assert first.suffix != second.suffix


def test_changed_only_rendering_shrinks_the_prompt() -> None:
    page = dashboard_page(changed_tag_ids=[3])
    full = build_reasoning_prompt("search", page)
    partial = build_reasoning_prompt("search", page, changed_only=True)
    assert partial.tokens() < full.tokens()


def test_token_estimate_is_monotonic() -> None:
    assert estimate_tokens("a" * 100) < estimate_tokens("a" * 400)


# -- client (phases 49, 107, 122, 123) -------------------------------------

def _client(**responses) -> tuple[OllamaClient, ScriptedBackend]:
    backend = ScriptedBackend(responses or {"m": "{}"})
    return OllamaClient(backend=backend), backend


def test_role_swap_takes_effect_without_restart() -> None:
    client, backend = _client(**{"a": "{}", "b": "{}"})
    previous = client.swap_role("text", "b")
    assert previous == client.config.models.text
    assert client.model_for("text") == "b"


def test_swapping_to_the_same_model_is_a_no_op() -> None:
    client, _ = _client(**{"a": "{}"})
    client.swap_role("text", "a")
    assert client.swap_role("text", "a") == "a"


def test_health_reports_a_dead_backend_without_raising() -> None:
    class Dead(ScriptedBackend):
        def get(self, endpoint):
            from voicc_host.errors import BackendUnavailable
            raise BackendUnavailable("refused")

    client = OllamaClient(backend=Dead({}))
    report = client.health()
    assert report["connected"] is False
    assert report["error"]["code"] == "backend_unavailable"


def test_health_lists_missing_models() -> None:
    client, backend = _client(**{"only-this": "{}"})
    backend.available = {"only-this"}
    report = client.health()
    assert report["connected"] is True
    assert client.config.models.text in report["missing_models"]


def test_prefix_session_reports_the_cache_benefit() -> None:
    session = PrefixSession("t1", "m", "prefix")
    for ttft in (300.0, 90.0, 85.0):
        session.record(Completion(text="", model="m", ttft_ms=ttft))
    benefit = session.cache_benefit_ms()
    assert benefit is not None and benefit > 0


def test_cache_benefit_needs_more_than_one_call() -> None:
    session = PrefixSession("t1", "m", "prefix")
    session.record(Completion(text="", model="m", ttft_ms=300.0))
    assert session.cache_benefit_ms() is None


def test_non_local_backend_is_refused() -> None:
    from voicc_host.config import Config
    from voicc_host.errors import NetworkPolicyViolation
    config = Config(ollama_url="http://10.0.0.5:11434")
    with pytest.raises(ValueError):
        config.assert_local_only()
    with pytest.raises(NetworkPolicyViolation):
        from voicc_host.ollama_client import HttpBackend
        HttpBackend("http://example.com:11434", 5.0)


# -- decision log and hash chain (phases 71, 81) ---------------------------

def test_chain_verifies_and_detects_tampering(tmp_path) -> None:
    path = tmp_path / "decisions.jsonl"
    logger = DecisionLogger(path, task_id="t1")
    for i in range(4):
        logger.event(f"stage{i}", Decision.ACCEPTED, step=i, detail="ok")

    assert verify_chain(path).valid, "an untouched log must verify"

    lines = path.read_text(encoding="utf-8").splitlines()
    entry = json.loads(lines[1])
    entry["detail"] = "tampered"
    lines[1] = json.dumps(entry, ensure_ascii=False, separators=(",", ":"))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    result = verify_chain(path)
    assert not result.valid and result.broken_at == 1


def test_deleting_an_entry_breaks_the_chain(tmp_path) -> None:
    path = tmp_path / "d.jsonl"
    logger = DecisionLogger(path)
    for i in range(4):
        logger.event("stage", Decision.ACCEPTED, step=i)
    lines = path.read_text(encoding="utf-8").splitlines()
    del lines[2]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    assert not verify_chain(path).valid


def test_logger_resumes_an_existing_chain(tmp_path) -> None:
    path = tmp_path / "d.jsonl"
    DecisionLogger(path).event("a", Decision.ACCEPTED)
    DecisionLogger(path).event("b", Decision.ACCEPTED)   # new instance
    assert verify_chain(path).valid
    assert len(list(read_entries(path))) == 2


def test_summary_counts_stages(tmp_path) -> None:
    path = tmp_path / "d.jsonl"
    logger = DecisionLogger(path)
    logger.event("draft", Decision.ACCEPTED, latency_ms=10)
    logger.event("draft", Decision.ESCALATED, latency_ms=20)
    report = summarize(path)
    assert report["stages"]["draft"] == 2
    assert report["total_logged_latency_ms"] == 30.0


# -- request queue (phase 124) ---------------------------------------------

def test_duplicate_commands_collapse_onto_the_in_flight_one() -> None:
    gate = threading.Event()
    handled = []

    def handler(request):
        gate.wait(2.0)
        handled.append(request.request_id)
        return "done"

    queue = RequestQueue(handler, max_depth=8)
    queue.start()
    try:
        first = queue.submit("command", {"task": "search reports"})
        time.sleep(0.05)
        second = queue.submit("command", {"task": "search reports"})
        assert second is first
        assert first.duplicates, "the second click should ride along"
        gate.set()
        first.wait(2.0)
        assert len(handled) == 1, "the command must not run twice"
    finally:
        queue.stop()


def test_different_commands_do_not_collapse() -> None:
    queue = RequestQueue(lambda r: None, max_depth=8)
    first = queue.submit("command", {"task": "search"})
    second = queue.submit("command", {"task": "export"})
    assert first is not second


def test_queue_overflow_is_rejected_with_a_clear_error() -> None:
    queue = RequestQueue(lambda r: None, max_depth=2)   # not started
    queue.submit("command", {"task": "a"})
    queue.submit("command", {"task": "b"})
    with pytest.raises(QueueOverflow):
        queue.submit("command", {"task": "c"})
    assert queue.stats()["rejected_overflow"] == 1


def test_handler_errors_do_not_kill_the_worker() -> None:
    def handler(request):
        if request.payload["task"] == "boom":
            raise RuntimeError("bang")
        return "ok"

    queue = RequestQueue(handler, max_depth=8)
    queue.start()
    try:
        bad = queue.submit("command", {"task": "boom"})
        bad.wait(2.0)
        good = queue.submit("command", {"task": "fine"})
        good.wait(2.0)
        assert isinstance(bad.error, RuntimeError)
        assert good.result == "ok", "the worker must survive a failed task"
    finally:
        queue.stop()


# -- dom batching (phase 155) ----------------------------------------------

def test_batched_queries_use_one_round_trip() -> None:
    sent = []

    def transport(queries):
        sent.append(queries)
        return [True] * len(queries)

    batch = DomBatch(transport)
    exists(batch, 1)
    label_of(batch, 1)
    exists(batch, 2)
    batch.flush()
    assert len(sent) == 1 and len(sent[0]) == 3
    assert batch.stats()["round_trips"] == 1


def test_identical_queries_are_deduplicated() -> None:
    batch = DomBatch(lambda q: [None] * len(q))
    slot_a = exists(batch, 7)
    slot_b = exists(batch, 7)
    assert slot_a == slot_b
    batch.flush()
    assert batch.stats()["queries_deduplicated"] == 1


def test_empty_batch_sends_nothing() -> None:
    sent = []
    batch = DomBatch(lambda q: sent.append(q) or [])
    assert batch.flush() == [] and sent == []


# -- workflow cache (phase 79) ---------------------------------------------

def test_cache_hit_on_an_unchanged_page(tmp_path) -> None:
    from voicc_host.schemas import Plan
    cache = WorkflowCache(tmp_path / "wf.json")
    page = dashboard_page()
    plan = Plan.model_validate({
        "actions": [{"type": "click", "tag_id": 3, "intent": "Search"}],
        "confidence": 0.9})
    cache.record("standard search", page, plan)
    assert cache.lookup("standard search", page).outcome is CacheOutcome.HIT


def test_cache_survives_a_reload(tmp_path) -> None:
    from voicc_host.schemas import Plan
    path = tmp_path / "wf.json"
    page = dashboard_page()
    plan = Plan.model_validate({
        "actions": [{"type": "click", "tag_id": 3, "intent": "Search"}],
        "confidence": 0.9})
    WorkflowCache(path).record("t", page, plan)
    assert WorkflowCache(path).lookup("t", page).outcome is CacheOutcome.HIT


@pytest.mark.parametrize("mutate,expected", [
    (lambda p: p.model_copy(update={"layout_hash": "layout-v2"}),
     CacheOutcome.INVALIDATED_LAYOUT),
    (lambda p: p.model_copy(update={
        "elements": [e for e in p.elements if e.tag_id != 3]}),
     CacheOutcome.INVALIDATED_MISSING_ELEMENT),
    (lambda p: p.model_copy(update={"elements": [
        e if e.tag_id != 3 else Element(tag_id=3, role="button",
                                        text="Delete all")
        for e in p.elements]}),
     CacheOutcome.INVALIDATED_LABEL_CHANGED),
    (lambda p: p.model_copy(update={"elements": [
        e if e.tag_id != 3 else Element(tag_id=3, role="button",
                                        text="Search", enabled=False)
        for e in p.elements]}),
     CacheOutcome.INVALIDATED_DISABLED),
])
def test_cache_invalidates_on_every_kind_of_drift(tmp_path, mutate,
                                                  expected) -> None:
    from voicc_host.schemas import Plan
    cache = WorkflowCache(tmp_path / "wf.json")
    page = dashboard_page()
    plan = Plan.model_validate({
        "actions": [{"type": "click", "tag_id": 3, "intent": "Search"}],
        "confidence": 0.9})
    cache.record("t", page, plan)
    decision = cache.lookup("t", mutate(page))
    assert decision.outcome is expected
    assert not decision.replayable


def test_a_corrupt_cache_file_is_simply_no_cache(tmp_path) -> None:
    path = tmp_path / "wf.json"
    path.write_text("{not json", encoding="utf-8")
    assert len(WorkflowCache(path)) == 0


# -- voice (phases 63, 64, 125) --------------------------------------------

def _clip(seconds: float = 2.0) -> AudioClip:
    return AudioClip([0.2, -0.2] * int(seconds * 8000), 16000)


def _transcriber(**responses) -> VoiceTranscriber:
    return VoiceTranscriber(backend=ScriptedTranscriberBackend(responses))


def test_all_three_languages_transcribe_and_route() -> None:
    transcriber = _transcriber(
        hi=("रिपोर्ट्स पेज खोलो", 0.9),
        kn=("ವರದಿ ಪುಟ ತೆರೆ", 0.9),
        en=("open the reports page", 0.9))
    for language in ("hi", "kn", "en"):
        command = route(transcriber.transcribe(_clip(), language=language))
        assert command.language == language
        assert "open" in command.canonical and "page" in command.canonical


def test_silence_is_refused_before_any_model_runs() -> None:
    transcriber = _transcriber(en=("hello", 0.9))
    with pytest.raises(TranscriptionError):
        transcriber.transcribe(AudioClip([0.0] * 16000), language="en")


def test_unsupported_language_is_rejected() -> None:
    with pytest.raises(TranscriptionError):
        _transcriber(en=("hi", 0.9)).transcribe(_clip(), language="fr")


def test_language_detection_prefers_the_matching_script() -> None:
    """Phase 125 -- routing without a manual selection."""
    transcriber = _transcriber(
        hi=("रिपोर्ट्स पेज खोलो", 0.9),
        kn=("ಗಿಬ್ಬರಿಶ್", 0.2),
        en=("report page cologne", 0.3))
    language, confidence, _ = transcriber.detect_language(_clip())
    assert language == "hi" and confidence > 0


def test_inconclusive_detection_asks_rather_than_guesses() -> None:
    transcriber = _transcriber(
        hi=("", 0.0), kn=("", 0.0), en=("", 0.0))
    with pytest.raises(TranscriptionError):
        transcriber.transcribe(_clip(), language=None)


def test_proper_nouns_survive_normalization() -> None:
    canonical, _ = normalize_text("नाम बॉक्स में Ramesh लिखो")
    assert "Ramesh" in canonical and "type" in canonical


def test_script_detection() -> None:
    assert script_of("रिपोर्ट") == "deva"
    assert script_of("ವರದಿ") == "knda"
    assert script_of("report") == "latin"
    assert script_of("123 !!") == "unknown"


def test_wav_decoding_rejects_non_wav_payloads() -> None:
    import base64
    from voicc_host.voice import decode_wav_base64
    with pytest.raises(TranscriptionError, match="WAV"):
        decode_wav_base64(base64.b64encode(b"OggS not-a-wav").decode())
