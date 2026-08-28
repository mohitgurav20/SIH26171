"""Omkar's measurement harness (phases 49, 80, 107, 108, 109, 126, 127,
128, 143, 155, 161).

Every number the pitch quotes from this side of the system comes from here,
measured on the demo laptop, not estimated. Two modes:

    --scripted   runs against the offline scripted backend. Proves the
                 harness itself works and the plumbing is wired, but the
                 timings are simulated and must never be quoted.
    (default)    runs against the real local Ollama. These are the numbers
                 that go in the reference sheet.

Results are appended to bench/results.json so phase 160 can reconcile them
with Siddu's and Chinmay's without anyone retyping figures.

    python bench/harness.py all
    python bench/harness.py draft_latency --runs 20
    python bench/harness.py all --scripted
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from voicc_host.config import CONFIG                            # noqa: E402
from voicc_host.draft_planner import (DraftPlanner,             # noqa: E402
                                      average_cost_per_action)
from voicc_host.errors import VoiccError                        # noqa: E402
from voicc_host.ollama_client import (OllamaClient,             # noqa: E402
                                      ScriptedBackend)
from voicc_host.prompts import (build_draft_prompt,             # noqa: E402
                                build_reasoning_prompt,
                                estimate_tokens, stable_prefix)
from voicc_host.schemas import Plan, json_schema_for            # noqa: E402
from voicc_host.selftest import (CLICK_SEARCH, TYPE_QUERY,      # noqa: E402
                                 _draft, _plan, build_loop,
                                 dashboard_page, ok_executor)
from voicc_host.streaming import StreamingPlanCollector         # noqa: E402

RESULTS = Path(__file__).resolve().parent / "results.json"

DRAFT = CONFIG.models.draft
TEXT = CONFIG.models.text
VISION = CONFIG.models.vision

#: Representative tasks. Kept small and fixed so runs are comparable.
TASKS = [
    "search the reports for orbit",
    "export the report",
    "open the reports page",
    "type orbit into the search box",
    "go to the second report",
]


# --------------------------------------------------------------------------
# Plumbing
# --------------------------------------------------------------------------


def scripted_client(latency_ms: dict | None = None) -> OllamaClient:
    """Offline stand-in with plausible per-model latencies."""
    plan = _plan(CLICK_SEARCH, 0.9, "the Search button is the only match")
    backend = ScriptedBackend(
        {
            DRAFT: _draft(CLICK_SEARCH, 0.9),
            TEXT: lambda payload: (
                plan if "Elements:" in payload.get("prompt", "")
                else '{"satisfied":true,"confidence":0.9,"reason":"ok"}'),
            VISION: '{"tag_id":3,"confidence":0.9,"reasoning":"tag 3"}',
        },
        latency_ms or {DRAFT: 120.0, TEXT: 900.0, VISION: 1400.0})
    return OllamaClient(CONFIG, backend=backend)


def real_client() -> OllamaClient:
    client = OllamaClient(CONFIG)
    report = client.health()
    if not report["connected"]:
        raise SystemExit(
            "Ollama is not reachable at " + CONFIG.ollama_url +
            "\nStart it, or pass --scripted to exercise the harness offline.")
    if report["missing_models"]:
        raise SystemExit("missing models: "
                         + ", ".join(report["missing_models"]))
    return client


def stats(values: list[float]) -> dict:
    if not values:
        return {}
    ordered = sorted(values)
    return {
        "n": len(values),
        "mean_ms": round(statistics.fmean(values), 2),
        "median_ms": round(statistics.median(values), 2),
        "p90_ms": round(ordered[min(int(len(ordered) * 0.9),
                                    len(ordered) - 1)], 2),
        "min_ms": round(ordered[0], 2),
        "max_ms": round(ordered[-1], 2),
        "stdev_ms": (round(statistics.stdev(values), 2)
                     if len(values) > 1 else 0.0),
    }


# --------------------------------------------------------------------------
# Benchmarks
# --------------------------------------------------------------------------


def bench_draft_latency(client: OllamaClient, runs: int) -> dict:
    """Phase 80 -- per-action latency with and without the draft shortcut.

    Both paths run on the same tasks in the same session, because comparing
    a cold full-model run against a warm draft run would flatter the draft
    model for the wrong reason.
    """
    page = dashboard_page()
    planner = DraftPlanner(client, CONFIG)
    schema = json_schema_for(Plan)

    client.warm(client.model_for("draft"))
    client.warm(client.model_for("text"))

    draft_ms: list[float] = []
    full_ms: list[float] = []
    for index in range(runs):
        task = TASKS[index % len(TASKS)]
        result = planner.propose(task, page)
        draft_ms.append(result.latency_ms)

        prompt = build_reasoning_prompt(task, page)
        completion = client.generate("text", prompt.text,
                                     system=prompt.system, schema=schema)
        full_ms.append(completion.total_ms)

    summary = planner.stats.summary()
    economics = average_cost_per_action(
        planner.stats,
        draft_ms=statistics.fmean(draft_ms),
        full_ms=statistics.fmean(full_ms))
    return {
        "draft": stats(draft_ms),
        "full_text": stats(full_ms),
        "draft_stats": summary,
        "economics": economics,
    }


def bench_warm_keeping(client: OllamaClient, runs: int) -> dict:
    """Phase 49 -- what keep_alive actually buys.

    A cold first call includes the model load; subsequent calls do not.
    The gap is the number that justifies keeping models resident.
    """
    page = dashboard_page()
    prompt = build_draft_prompt(TASKS[0], page)
    schema = json_schema_for(Plan)

    cold = client.generate("draft", prompt.text, system=prompt.system,
                           schema=schema)
    warm_runs = [
        client.generate("draft", prompt.text, system=prompt.system,
                        schema=schema).total_ms
        for _ in range(max(runs - 1, 1))
    ]
    warm_mean = statistics.fmean(warm_runs)
    return {
        "cold_first_call_ms": round(cold.total_ms, 2),
        "warm": stats(warm_runs),
        "load_cost_ms": round(cold.total_ms - warm_mean, 2),
        "keep_alive": CONFIG.keep_alive,
    }


def bench_kv_cache(client: OllamaClient, runs: int) -> dict:
    """Phase 107 -- prefix reuse across the calls of one task.

    Time-to-first-token is the metric: prefix reuse removes prompt
    re-evaluation, which is exactly the part that happens before the first
    token. Total time is dominated by generation and would hide the effect.
    """
    page = dashboard_page()
    task = TASKS[0]
    prompt = build_reasoning_prompt(task, page)
    schema = json_schema_for(Plan)
    client.warm(client.model_for("text"))

    session = client.start_session("bench", "text", stable_prefix(prompt))
    shared: list[float] = []
    for step in range(runs):
        # Same prefix every call; only the suffix moves.
        suffix = f"{prompt.suffix}\nStep {step}: continue the task.\n"
        completion = client.generate(
            "text", session.compose(suffix), system=prompt.system,
            schema=schema, session=session)
        shared.append(completion.ttft_ms)

    # Control: a prefix that changes every call, defeating reuse.
    varied: list[float] = []
    for step in range(runs):
        changing = build_reasoning_prompt(
            f"{task} (attempt {step})", page,
            memories=[f"note {step}"])
        completion = client.generate("text", changing.text,
                                     system=changing.system, schema=schema)
        varied.append(completion.ttft_ms)

    return {
        "shared_prefix_ttft": stats(shared),
        "changing_prefix_ttft": stats(varied),
        "first_call_ttft_ms": round(shared[0], 2) if shared else 0.0,
        "later_calls_ttft": stats(shared[1:]),
        "cache_benefit_ms": (round(session.cache_benefit_ms(), 2)
                             if session.cache_benefit_ms() else 0.0),
    }


def bench_streaming_head_start(client: OllamaClient, runs: int) -> dict:
    """Phase 108 -- how early step 1 is ready, relative to the full plan."""
    page = dashboard_page()
    prompt = build_reasoning_prompt(
        "type orbit into search then click search", page)
    schema = json_schema_for(Plan)
    client.warm(client.model_for("text"))

    head_starts: list[float] = []
    totals: list[float] = []
    for _ in range(runs):
        collector = StreamingPlanCollector()
        completion = client.generate("text", prompt.text,
                                     system=prompt.system, schema=schema,
                                     on_token=collector.on_token)
        outcome = collector.finish(completion.text)
        totals.append(completion.total_ms)
        if outcome.head_start_ms is not None:
            head_starts.append(outcome.head_start_ms)
    return {
        "head_start": stats(head_starts),
        "full_response": stats(totals),
        "fraction_of_response_hidden": (
            round(statistics.fmean(head_starts) / statistics.fmean(totals), 4)
            if head_starts and totals else 0.0),
    }


def bench_warm_swap(client: OllamaClient, runs: int) -> dict:
    """Phase 109 / 156 -- pre-warming the next model during the current step.

    Measured as the cost of the first vision call in each arm: with
    pre-warming that call should not include the model load.
    """
    page = dashboard_page(has_opaque_regions=True)
    prompt = build_draft_prompt(TASKS[0], page)
    vision = client.model_for("vision")

    def one_round(prewarm: bool) -> float:
        client.generate("draft", prompt.text, system=prompt.system)
        if prewarm:
            client.warm_async(vision)
            client.await_warm(vision, timeout_s=60)
        started = time.perf_counter()
        try:
            client.generate("vision", "Which numbered tag is the search box?",
                            images=[])
        except VoiccError:
            pass
        return (time.perf_counter() - started) * 1000.0

    cold: list[float] = []
    warm: list[float] = []
    for index in range(runs):
        # Alternate so drift in machine load hits both arms equally.
        if index % 2 == 0:
            cold.append(one_round(False))
            warm.append(one_round(True))
        else:
            warm.append(one_round(True))
            cold.append(one_round(False))
    return {
        "vision_first_call_without_prewarm": stats(cold),
        "vision_first_call_with_prewarm": stats(warm),
        "saved_ms": round(statistics.fmean(cold) - statistics.fmean(warm), 2)
        if cold and warm else 0.0,
    }


def bench_handoff(client: OllamaClient, runs: int) -> dict:
    """Phase 143 -- does draft-to-vision escalation introduce a visible stall.

    'Visible' is the point: anything under ~100 ms reads as instant, so the
    result is reported against that threshold rather than as a bare number.
    """
    latencies: list[float] = []
    perception: list[float] = []
    for _ in range(runs):
        loop, _ = build_loop({
            DRAFT: _draft(CLICK_SEARCH, 0.3, ambiguous=True),
            VISION: '{"tag_id":3,"confidence":0.9,"reasoning":"tag 3"}',
            TEXT: '{"satisfied":true,"confidence":0.9,"reason":"ok"}',
        }) if isinstance(client.backend, ScriptedBackend) else (None, None)
        if loop is None:
            break
        outcome = loop.run("click the widget control",
                           dashboard_page(has_opaque_regions=True),
                           executor=ok_executor, image_b64="Zm9v",
                           visible_tags=[3, 4, 5], crop_id="c1")
        latencies.append(outcome.timings_ms.get("draft_to_full_handoff", 0.0))
        perception.append(outcome.timings_ms.get("perception_handoff", 0.0))
    return {
        "draft_to_full_handoff": stats(latencies),
        "wasted_ladder_rungs": stats(perception),
        "visible_stall_threshold_ms": 100.0,
        "within_threshold": (statistics.fmean(latencies) < 100.0
                             if latencies else None),
    }


def bench_prompt_size(client: OllamaClient, runs: int) -> dict:
    """Phase 126 -- token cost of each prompt template.

    Token counts are exact and hardware-independent, so these are quotable
    even from a scripted run.
    """
    page = dashboard_page()
    draft = build_draft_prompt(TASKS[0], page)
    full = build_reasoning_prompt(TASKS[0], page,
                                  memories=["reports live under /reports"])
    changed = build_reasoning_prompt(
        TASKS[0], page.model_copy(update={"changed_tag_ids": [3]}),
        memories=["reports live under /reports"], changed_only=True)
    verbose_element_json = json.dumps(
        [e.model_dump() for e in page.elements])
    return {
        "draft_prompt_tokens": draft.tokens(),
        "full_prompt_tokens": full.tokens(),
        "changed_only_prompt_tokens": changed.tokens(),
        "draft_vs_full_reduction": round(
            1 - draft.tokens() / full.tokens(), 4),
        "changed_only_reduction": round(
            1 - changed.tokens() / full.tokens(), 4),
        "line_format_vs_raw_json_element_list": round(
            1 - estimate_tokens(
                "\n".join(f"[{e.tag_id}] {e.role} {e.label()}"
                          for e in page.elements))
            / estimate_tokens(verbose_element_json), 4),
    }


def bench_sampling(client: OllamaClient, runs: int) -> dict:
    """Phase 128 -- which sampling settings give repeatable plans.

    Consistency is scored as: how often does the same command produce the
    identical action sequence. A demo needs this near 1.0.
    """
    page = dashboard_page()
    prompt = build_draft_prompt(TASKS[0], page)
    schema = json_schema_for(Plan)
    results = {}
    for temperature in (0.0, 0.1, 0.3, 0.7):
        signatures = []
        for _ in range(runs):
            completion = client.generate(
                "draft", prompt.text, system=prompt.system, schema=schema,
                options={"temperature": temperature})
            signatures.append(completion.text.strip())
        most_common = max(set(signatures), key=signatures.count)
        results[f"temperature_{temperature}"] = {
            "identical_fraction": round(
                signatures.count(most_common) / len(signatures), 3),
            "distinct_outputs": len(set(signatures)),
        }
    results["locked"] = {
        "draft": CONFIG.sampling.draft_temperature,
        "text": CONFIG.sampling.text_temperature,
        "vision": CONFIG.sampling.vision_temperature,
        "top_p": CONFIG.sampling.top_p,
        "seed": CONFIG.sampling.seed,
    }
    return results


def bench_load(client: OllamaClient, runs: int) -> dict:
    """Phase 127 -- ten-plus consecutive tasks, watching for leaks."""
    import gc
    import psutil

    process = psutil.Process()
    loop, _ = build_loop({
        DRAFT: _draft(f"{TYPE_QUERY},{CLICK_SEARCH}", 0.9),
        TEXT: '{"satisfied":true,"confidence":0.9,"reason":"ok"}',
    }) if isinstance(client.backend, ScriptedBackend) else (None, None)

    rss: list[float] = []
    durations: list[float] = []
    failures = 0
    gc.collect()
    baseline = process.memory_info().rss / 1e6

    for index in range(max(runs, 10)):
        started = time.perf_counter()
        try:
            if loop is not None:
                outcome = loop.run(TASKS[index % len(TASKS)],
                                   dashboard_page(), executor=ok_executor)
                if outcome.error and outcome.error.get("code") not in (
                        "no_matching_element",):
                    failures += 1
            else:
                prompt = build_draft_prompt(TASKS[index % len(TASKS)],
                                            dashboard_page())
                client.generate("draft", prompt.text, system=prompt.system)
        except Exception:                                      # noqa: BLE001
            failures += 1
        durations.append((time.perf_counter() - started) * 1000.0)
        rss.append(process.memory_info().rss / 1e6)

    gc.collect()
    final = process.memory_info().rss / 1e6
    return {
        "runs": len(durations),
        "failures": failures,
        "per_task": stats(durations),
        "rss_start_mb": round(baseline, 1),
        "rss_end_mb": round(final, 1),
        "rss_growth_mb": round(final - baseline, 1),
        "leak_suspected": (final - baseline) > 50.0,
    }


def bench_memory_ceiling(client: OllamaClient, runs: int) -> dict:
    """Phase 161 -- everything the demo needs, resident at once.

    Loads each model the demo touches and reports what the machine is
    holding. The three voice checkpoints are counted separately because
    they live in this process, not in Ollama's.
    """
    import psutil

    machine = psutil.virtual_memory()
    report: dict = {
        "total_ram_gb": round(machine.total / 1e9, 2),
        "available_before_gb": round(machine.available / 1e9, 2),
        "models": {},
        "errors": [],
    }

    for role in ("draft", "text", "vision"):
        model = client.model_for(role)
        try:
            elapsed = client.warm(model)
            report["models"][role] = {"model": model,
                                      "load_ms": round(elapsed, 1)}
        except VoiccError as exc:
            report["errors"].append(f"{role} ({model}): {exc}")

    try:
        loaded = client.backend.get("/api/ps").get("models", [])
        report["resident"] = [
            {"name": m.get("name"),
             "vram_mb": round(int(m.get("size_vram") or 0) / 1e6, 1),
             "size_mb": round(int(m.get("size") or 0) / 1e6, 1)}
            for m in loaded]
        report["resident_total_mb"] = round(
            sum(int(m.get("size") or 0) for m in loaded) / 1e6, 1)
    except Exception as exc:                                   # noqa: BLE001
        report["errors"].append(f"could not read /api/ps: {exc}")

    process = psutil.Process()
    report["host_process_rss_mb"] = round(
        process.memory_info().rss / 1e6, 1)
    after = psutil.virtual_memory()
    report["available_after_gb"] = round(after.available / 1e9, 2)
    report["headroom_ok"] = after.available > 1.5e9
    report["voice_checkpoints"] = {
        language: str(CONFIG.voice.model_dir / name)
        for language, name in CONFIG.voice.checkpoints.items()}
    return report


def bench_dom_round_trips(client: OllamaClient, runs: int) -> dict:
    """Phase 155 -- round trips saved by batching read-only queries."""
    from voicc_host.dom_batch import DomBatch, exists, is_enabled, label_of

    sent: list[list[dict]] = []
    batch = DomBatch(lambda queries: sent.append(queries) or
                     [True] * len(queries))
    # What one verification step asks about a 3-action plan.
    for tag_id in (2, 3, 4):
        exists(batch, tag_id)
        label_of(batch, tag_id)
        is_enabled(batch, tag_id)
    exists(batch, 3)                      # duplicate, should collapse
    batch.flush()
    return {**batch.stats(), "messages_sent": len(sent)}


BENCHMARKS: dict[str, Callable[[OllamaClient, int], dict]] = {
    "draft_latency": bench_draft_latency,
    "warm_keeping": bench_warm_keeping,
    "kv_cache": bench_kv_cache,
    "streaming": bench_streaming_head_start,
    "warm_swap": bench_warm_swap,
    "handoff": bench_handoff,
    "prompt_size": bench_prompt_size,
    "sampling": bench_sampling,
    "load": bench_load,
    "memory_ceiling": bench_memory_ceiling,
    "dom_round_trips": bench_dom_round_trips,
}

#: These need a real backend to mean anything; scripted runs are plumbing
#: checks only and are labelled as such in the output.
HARDWARE_DEPENDENT = {"draft_latency", "warm_keeping", "kv_cache",
                      "streaming", "warm_swap", "load", "memory_ceiling"}


def record(name: str, payload: dict, scripted: bool) -> None:
    RESULTS.parent.mkdir(parents=True, exist_ok=True)
    existing = {}
    if RESULTS.exists():
        try:
            existing = json.loads(RESULTS.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            existing = {}
    existing.setdefault("runs", []).append({
        "benchmark": name,
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "scripted": scripted,
        "quotable": not (scripted and name in HARDWARE_DEPENDENT),
        "models": {"draft": DRAFT, "text": TEXT, "vision": VISION},
        "result": payload,
    })
    RESULTS.write_text(json.dumps(existing, indent=2), encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="voicc-bench")
    parser.add_argument("benchmark", nargs="?", default="all",
                        help=f"one of: all, {', '.join(BENCHMARKS)}")
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--scripted", action="store_true",
                        help="offline plumbing check; timings are simulated")
    args = parser.parse_args(argv)

    client = scripted_client() if args.scripted else real_client()
    names = list(BENCHMARKS) if args.benchmark == "all" else [args.benchmark]
    for name in names:
        runner = BENCHMARKS.get(name)
        if runner is None:
            print(f"unknown benchmark {name!r}", file=sys.stderr)
            return 2
        print(f"\n=== {name} " + "=" * max(4, 54 - len(name)))
        if args.scripted and name in HARDWARE_DEPENDENT:
            print("  (scripted: plumbing check only, do NOT quote these)")
        try:
            payload = runner(client, args.runs)
        except SystemExit:
            raise
        except Exception as exc:                               # noqa: BLE001
            print(f"  FAILED: {type(exc).__name__}: {exc}")
            continue
        print(json.dumps(payload, indent=2))
        record(name, payload, args.scripted)
    print(f"\nresults appended to {RESULTS}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
