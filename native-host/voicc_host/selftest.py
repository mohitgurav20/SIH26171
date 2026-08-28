"""Offline end-to-end scenarios (phases 95, 96).

Runs the real agent loop against a scripted backend, so every path can be
exercised on a laptop with no Ollama and no models. Two jobs:

  * phase 95 -- prove every error path produces a clean, readable outcome
    rather than a crash or a hang;
  * phase 96 -- give a single command that forces low-confidence,
    vision-fallback, guardrail and offline moments on demand, so they can
    be rehearsed instead of hoped for.

    python -m voicc_host.main --self-test
    python -m voicc_host.selftest --scenario guardrail_block
"""
from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path
from typing import Callable

from .agent_loop import AgentLoop, TaskOutcome
from .config import CONFIG
from .decision_log import DecisionLogger, verify_chain
from .errors import BackendUnavailable
from .ollama_client import OllamaClient, ScriptedBackend
from .perception import DomProvider, PerceptionLadder, VisionProvider
from .schemas import Element, PageState, PerceptionTier, Plan
from .verifier import ExecutionReport
from .voice import ScriptedTranscriberBackend, VoiceTranscriber, route
from .workflow_cache import WorkflowCache

DRAFT = CONFIG.models.draft
TEXT = CONFIG.models.text
VISION = CONFIG.models.vision


def dashboard_page(**overrides) -> PageState:
    """Stands in for Chinmay's mock ISRO dashboard."""
    defaults = dict(
        url="http://localhost:8080/reports",
        title="Mission Reports",
        elements=[
            Element(tag_id=1, role="link", text="Reports", region="nav"),
            Element(tag_id=2, role="input", placeholder="Search reports",
                    region="main"),
            Element(tag_id=3, role="button", text="Search", region="main"),
            Element(tag_id=4, role="button", text="Export CSV", region="main"),
            Element(tag_id=5, role="button", text="Delete all",
                    region="main"),
        ],
        layout_hash="layout-v1",
        raw_html_bytes=184_000, dom_payload_bytes=11_400,
    )
    defaults.update(overrides)
    return PageState(**defaults)


def _plan(actions: str, confidence: float, reasoning: str = "",
          outcome: str = "the page updates") -> str:
    return ('{"actions":[' + actions + '],"confidence":' + str(confidence)
            + ',"reasoning":"' + reasoning + '","expected_outcome":"'
            + outcome + '"}')


def _draft(actions: str, confidence: float, ambiguous: bool = False) -> str:
    return ('{"plan":' + _plan(actions, confidence)
            + ',"ambiguous":' + ("true" if ambiguous else "false") + "}")


CLICK_SEARCH = '{"type":"click","tag_id":3,"intent":"Search"}'
TYPE_QUERY = '{"type":"type","tag_id":2,"value":"orbit"}'


def build_loop(responses: dict, *, cache_path: Path | None = None,
               log_path: Path | None = None,
               latency_ms: dict | None = None) -> tuple[AgentLoop, ScriptedBackend]:
    backend = ScriptedBackend(responses, latency_ms or {})
    client = OllamaClient(CONFIG, backend=backend)
    ladder = PerceptionLadder([
        DomProvider(),
        VisionProvider(client, PerceptionTier.CROPPED_VISION),
        VisionProvider(client, PerceptionTier.FULL_PAGE_VISION),
    ])
    logger = DecisionLogger(log_path or Path(tempfile.mkdtemp()) / "d.jsonl")
    loop = AgentLoop(client, ladder=ladder, logger=logger,
                     cache=WorkflowCache(cache_path), config=CONFIG)
    return loop, backend


def ok_executor(plan: Plan) -> ExecutionReport:
    return ExecutionReport(
        completed=len(plan),
        executed=[f"{a.type.value} {a.tag_id or ''}".strip()
                  for a in plan.actions])


def halting_executor(at: int) -> Callable[[Plan], ExecutionReport]:
    def _run(plan: Plan) -> ExecutionReport:
        return ExecutionReport(
            completed=at, failed_index=at,
            failure=f"element for step {at + 1} vanished after step {at}",
            executed=[f"{a.type.value} {a.tag_id or ''}".strip()
                      for a in plan.actions[:at]])
    return _run


# --------------------------------------------------------------------------
# Scenarios
# --------------------------------------------------------------------------


def scenario_draft_accepted() -> TaskOutcome:
    """Fast path: the 0.5B model plans it, nothing escalates."""
    loop, _ = build_loop({
        DRAFT: _draft(f"{TYPE_QUERY},{CLICK_SEARCH}", 0.92),
        TEXT: '{"satisfied":true,"confidence":0.9,"reason":"results shown"}',
    })
    return loop.run("search reports for orbit", dashboard_page(),
                    executor=ok_executor)


def scenario_escalation() -> TaskOutcome:
    """Draft admits ambiguity, the 3B model re-plans."""
    loop, backend = build_loop({
        DRAFT: _draft(CLICK_SEARCH, 0.4, ambiguous=True),
        TEXT: lambda payload: (
            _plan(CLICK_SEARCH, 0.88, "Search is the only match")
            if "Elements:" in payload.get("prompt", "")
            else '{"satisfied":true,"confidence":0.9,"reason":"done"}'),
    })
    return loop.run("find the orbit report", dashboard_page(),
                    executor=ok_executor)


def scenario_guardrail_block() -> TaskOutcome:
    """The model aims at 'Delete all' while claiming to export."""
    loop, _ = build_loop({
        DRAFT: _draft('{"type":"click","tag_id":5,"intent":"Export CSV"}',
                      0.95),
        TEXT: '{"satisfied":true,"confidence":0.9,"reason":"n/a"}',
    })
    return loop.run("export the report", dashboard_page(),
                    executor=ok_executor)


def scenario_low_confidence() -> TaskOutcome:
    """Below the floor: pause and ask rather than guess."""
    loop, _ = build_loop({
        DRAFT: _draft(CLICK_SEARCH, 0.5),
        TEXT: lambda payload: (
            _plan(CLICK_SEARCH, 0.35, "not sure this is the right control")
            if "Elements:" in payload.get("prompt", "")
            else '{"satisfied":true,"confidence":0.5,"reason":"n/a"}'),
    })
    return loop.run("do the thing on the left", dashboard_page(),
                    executor=ok_executor)


def scenario_vision_fallback() -> TaskOutcome:
    """Canvas widget: the DOM cannot describe it, so vision answers."""
    page = dashboard_page(has_opaque_regions=True)
    loop, _ = build_loop({
        DRAFT: _draft(CLICK_SEARCH, 0.3, ambiguous=True),
        VISION: '{"tag_id":4,"confidence":0.86,"reasoning":"the labelled '
                'Export control is the only button in the crop",'
                '"rejected":[3,5]}',
        TEXT: '{"satisfied":true,"confidence":0.9,"reason":"file downloaded"}',
    })
    return loop.run("click the export control in the chart widget", page,
                    executor=ok_executor, image_b64="ZmFrZS1wbmc=",
                    visible_tags=[3, 4, 5], crop_id="crop-7")


def scenario_verification_failure() -> TaskOutcome:
    """Plan halts at step 2; verification fails deterministically."""
    loop, _ = build_loop({
        DRAFT: _draft(f"{TYPE_QUERY},{CLICK_SEARCH}", 0.9),
        TEXT: '{"satisfied":false,"confidence":0.9,"reason":"no results"}',
    })
    return loop.run("search reports for orbit", dashboard_page(),
                    executor=halting_executor(1))


def scenario_cache_hit_then_invalidation() -> list[TaskOutcome]:
    """Run, replay from cache, then change the page and watch it refuse."""
    cache_path = Path(tempfile.mkdtemp()) / "workflows.json"
    responses = {
        DRAFT: _draft(CLICK_SEARCH, 0.9),
        TEXT: '{"satisfied":true,"confidence":0.9,"reason":"results shown"}',
    }
    loop, backend = build_loop(responses, cache_path=cache_path)
    first = loop.run("run the standard search", dashboard_page(),
                     executor=ok_executor)
    calls_after_first = len(backend.calls)

    second = loop.run("run the standard search", dashboard_page(),
                      executor=ok_executor)
    replay_calls = len(backend.calls) - calls_after_first

    # Same tag ids, different labels: the dangerous drift a hash-only
    # check would miss if the extension reported a stale hash.
    drifted = dashboard_page(elements=[
        Element(tag_id=1, role="link", text="Reports", region="nav"),
        Element(tag_id=2, role="input", placeholder="Search reports"),
        Element(tag_id=3, role="button", text="Delete all"),
        Element(tag_id=4, role="button", text="Export CSV"),
        Element(tag_id=5, role="button", text="Search"),
    ])
    third = loop.run("run the standard search", drifted,
                     executor=ok_executor)
    second.summary += f"  [model calls during replay: {replay_calls}]"
    return [first, second, third]


def scenario_backend_down() -> TaskOutcome:
    """Ollama not running: a clear message, not a silent hang."""

    class DeadBackend(ScriptedBackend):
        def stream(self, endpoint, payload):
            raise BackendUnavailable("connection refused on 127.0.0.1:11434")
            yield {}                                   # pragma: no cover

        def get(self, endpoint):
            raise BackendUnavailable("connection refused")

    backend = DeadBackend({DRAFT: "", TEXT: ""})
    client = OllamaClient(CONFIG, backend=backend)
    ladder = PerceptionLadder([DomProvider()])
    logger = DecisionLogger(Path(tempfile.mkdtemp()) / "d.jsonl")
    loop = AgentLoop(client, ladder=ladder, logger=logger, config=CONFIG)
    return loop.run("search reports for orbit", dashboard_page(),
                    executor=ok_executor)


def scenario_hallucinated_element() -> TaskOutcome:
    """Adversarial: the model invents a control that is not on the page."""
    loop, _ = build_loop({
        DRAFT: _draft('{"type":"click","tag_id":42,"intent":"Archive"}', 0.97),
        TEXT: lambda payload: (
            _plan('{"type":"done"}', 0.2, "there is no Archive control here")
            if "Elements:" in payload.get("prompt", "")
            else '{"satisfied":false,"confidence":0.9,"reason":"nothing done"}'),
    })
    return loop.run("archive this report", dashboard_page(),
                    executor=ok_executor)


def scenario_plan_cap() -> TaskOutcome:
    """A seven-step speculative plan is split at the cap (phase 157)."""
    long_plan = ",".join([
        TYPE_QUERY, CLICK_SEARCH,
        '{"type":"click","tag_id":1,"intent":"Reports"}',
        '{"type":"scroll"}', '{"type":"click","tag_id":4,"intent":"Export CSV"}',
        '{"type":"scroll"}', '{"type":"click","tag_id":3,"intent":"Search"}',
    ])
    loop, _ = build_loop({
        DRAFT: _draft(long_plan, 0.9),
        TEXT: '{"satisfied":true,"confidence":0.9,"reason":"done"}',
    })
    return loop.run("do the full export routine", dashboard_page(),
                    executor=ok_executor)


def scenario_voice_three_languages() -> list[dict]:
    """Phases 63/64/97 -- all three languages reach the same pipeline."""
    from .voice.transcriber import AudioClip
    backend = ScriptedTranscriberBackend({
        "hi": ("रिपोर्ट्स पेज खोलो और सबमिट दबाओ", 0.9),
        "kn": ("ವರದಿ ಪುಟ ತೆರೆ ಮತ್ತು ಸಲ್ಲಿಸಿ ಒತ್ತಿ", 0.9),
        "en": ("open the reports page and click submit", 0.9),
    })
    transcriber = VoiceTranscriber(backend=backend, config=CONFIG.voice)
    clip = AudioClip([0.2, -0.2] * 16000, 16000)     # 2s of non-silence
    rows = []
    for language in ("hi", "kn", "en"):
        command = route(transcriber.transcribe(clip, language=language))
        rows.append(command.to_dict())
    return rows


SCENARIOS: dict[str, Callable] = {
    "draft_accepted": scenario_draft_accepted,
    "escalation": scenario_escalation,
    "guardrail_block": scenario_guardrail_block,
    "low_confidence": scenario_low_confidence,
    "vision_fallback": scenario_vision_fallback,
    "verification_failure": scenario_verification_failure,
    "cache": scenario_cache_hit_then_invalidation,
    "backend_down": scenario_backend_down,
    "hallucinated_element": scenario_hallucinated_element,
    "plan_cap": scenario_plan_cap,
    "voice": scenario_voice_three_languages,
}


def _render(name: str, result) -> None:
    print(f"\n=== {name} " + "=" * max(4, 58 - len(name)))
    items = result if isinstance(result, list) else [result]
    for item in items:
        if isinstance(item, dict):
            try:
                print(f"  voice[{item['language']}] {item['original']}")
            except UnicodeEncodeError:
                print(f"  voice[{item['language']}] {item['original'].encode('ascii', 'backslashreplace').decode('ascii')}")
            print(f"      -> {item['canonical']}")
            continue
        flag = "OK  " if item.ok else ("ASK " if item.needs_confirmation
                                       else "STOP")
        print(f"  [{flag}] {item.summary}")
        print(f"         tier={item.tier.value} cache={item.cache} "
              f"model_calls={item.model_calls} steps={item.steps_executed}")
        if item.why:
            print(f"         why: {item.why}")
        if item.error:
            print(f"         error: {item.error.get('code')}: "
                  f"{item.error.get('detail') or item.error.get('message')}")


def run_self_test(selected: str = "") -> int:
    names = [selected] if selected else list(SCENARIOS)
    failures = 0
    for name in names:
        runner = SCENARIOS.get(name)
        if runner is None:
            print(f"unknown scenario {name!r}; "
                  f"choose from {', '.join(SCENARIOS)}")
            return 2
        try:
            _render(name, runner())
        except Exception as exc:                               # noqa: BLE001
            failures += 1
            print(f"\n=== {name} CRASHED: {type(exc).__name__}: {exc}")
    print(f"\n{len(names) - failures}/{len(names)} scenarios completed "
          f"without crashing.")
    return 1 if failures else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="voicc-selftest")
    parser.add_argument("--scenario", default="",
                        help=f"one of: {', '.join(SCENARIOS)}")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    if args.json:
        runner = SCENARIOS[args.scenario or "draft_accepted"]
        result = runner()
        items = result if isinstance(result, list) else [result]
        print(json.dumps([i if isinstance(i, dict) else i.to_dict()
                          for i in items], indent=2, ensure_ascii=False))
        return 0
    return run_self_test(args.scenario)


if __name__ == "__main__":
    raise SystemExit(main())
