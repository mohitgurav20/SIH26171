# 14 + 145 — Agent loop and tool-calling architecture

Covers phase 14 (research: plan→act→verify patterns) and phase 145
(documentation of the loop and multi-action schema for the technical
report). Matches the frozen code in `voicc_host/agent_loop.py`.

## The loop

```
command (typed or spoken)
        │
        ▼
  ┌───────────────┐   hit    ┌──────────────────────────────┐
  │ workflow cache├─────────►│ replay plan, 0 planner calls │
  └───────┬───────┘          └──────────────┬───────────────┘
          │ miss / invalidated              │ still gated
          ▼                                 │
  ┌───────────────┐                         │
  │ draft (0.5B)  │  accepted ──────────────┤
  └───────┬───────┘                         │
          │ escalate                        │
          ▼                                 │
  ┌───────────────────────────┐             │
  │ full text (3B)            │             │
  │  or perception ladder ────┼─ DOM        │
  │                           │  → cropped vision
  │                           │  → full-page vision
  │                           │  → explained failure
  └───────────┬───────────────┘             │
              ▼                             │
        ┌─────────────┐                     │
        │   gates     │◄────────────────────┘
        │ evidence    │  no evidence  → refuse
        │ guardrails  │  label ≠ intent → refuse
        │ confidence  │  below floor  → pause and ask
        │ plan cap    │  > 5 actions  → split
        └──────┬──────┘
               ▼
      execute whole plan (no model call between steps)
               ▼
      verify end state ONCE
          satisfied → cache the workflow, done
          failed    → fall back to single-step from `resume_from`
```

## Why plan→act→verify, and not ReAct-per-step

The obvious loop is: think, act one step, observe, think again. It is also
the wrong shape here. Each "think" is a full local model call — on this
hardware, roughly a second — so a five-step task pays five of them even
when the page is unambiguous.

Batching moves the model calls to the edges: one call to plan, one to
verify. The risk it buys is that the page can change halfway through a
plan, which is handled in two places rather than one:

- **before the plan runs**, guardrails cross-check every action against
  current page state, so a plan that would be blocked at step 3 never
  executes step 1;
- **during the plan**, Mohit's executor re-checks element existence
  immediately before each individual action fires, and halts the rest of
  the plan if the target moved.

Those answer different questions — "is this plan sound?" versus "is this
step still possible right now?" — which is why both exist.

## Speculative planning

Borrowed from speculative decoding. The 0.5B draft model proposes; the 3B
model is only invoked when the draft is unusable. The economics are in
`draft_planner.average_cost_per_action`:

```
average cost = draft_ms + (1 − p) × full_ms       (p = acceptance rate)
worth keeping while  p > draft_ms / full_ms
```

With a 120 ms draft and a 900 ms full model, break-even acceptance is about
13%. Anything above that and the draft model pays for itself; below it,
phase 82 should drop it. The real acceptance rate is measured, not assumed
— `health()` reports it live.

Escalation triggers, in `_escalation_reason`:

| Trigger | Why |
|---|---|
| `self_reported_ambiguous` | the model saying it is unsure is the cheapest signal available, and more reliable than its own confidence number |
| `low_confidence` | below `draft_accept_confidence` (0.75) |
| `invalid_output` | failed schema validation |
| `ungrounded` | referenced a tag id not on the page |
| `opaque_region` | page has non-DOM content the plan ignored |
| `no_elements` | the DOM filter found nothing to act on |
| `backend_error` | a dead backend propagates instead of escalating |

A failed draft is never *repaired* — a repair round-trip costs more than
the escalation it would avoid.

## Multi-action plan schema (phase 32)

```jsonc
{
  "actions": [
    {
      "type": "click | type | scroll | select | navigate | wait_for | done",
      "tag_id": 3,            // numbered tag, never a coordinate
      "value": "orbit",       // for type/select
      "intent": "Search"      // the element's visible label; guardrail input
    }
  ],
  "confidence": 0.88,
  "reasoning": "one line, shown in the why-panel",
  "expected_outcome": "an observable change, checked by verification"
}
```

`Action` has **no x/y fields at all**, so a coordinate-emitting model fails
validation by construction rather than by a runtime check. `intent` is not
decoration: it is the string the guardrail compares against the real DOM
label before the action is allowed to run.

## Tool calling: why structured output, not function calling

Local 0.5–3B models are unreliable at the function-calling APIs hosted
models expose — they emit the right idea in the wrong envelope often
enough to matter. Two things make that survivable:

1. **Ollama's `format` parameter** takes a JSON Schema and constrains
   decoding, so most malformed output never gets generated.
2. **One parse boundary.** `parse_model_output` is the only place model
   text becomes a typed object. It is tolerant about wrapping (code fences,
   prose either side, a balanced-brace scan that respects string literals)
   and strict about content. Being lenient at exactly one point is what
   lets everything downstream be strict.

Phase 142's tests drive 22 malformed shapes at that boundary.

## Verification

One check, after the whole plan, against the end state. Two deterministic
answers come first, because a model call that can only confirm what is
already certain is wasted latency:

- the executor reported a halt → not satisfied, no model call;
- fewer steps ran than the plan had → not satisfied, no model call.

Otherwise the text model compares `expected_outcome` against the page as it
now is. **An unverifiable outcome is treated as unverified, never as
success** — silent optimism is the worst possible failure mode for an agent
that clicks things.

On failure the loop does not replay the plan. It reports `resume_from`,
which is why the executor logs how far it got.

## Threading (`main.py`)

| Thread | Job |
|---|---|
| main | reads framed stdin messages forever; never does slow work |
| worker | runs one command at a time (`request_queue`) |
| warm | speculative model loads, daemon, failures swallowed |

Native messaging has no request/response, so when the worker needs the
browser to run a plan, `ExtensionBridge` sends a `request_id` and blocks on
an Event until the reader routes the reply back. That only works because
the reader never blocks on the worker — the split is not negotiable.
