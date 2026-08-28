# SIH26171 — Benchmark & Latency Evaluation Summary

## 1. Granular Per-Phase Latency Breakdown (Task #110)

| Scenario / Trial | DOM Extr (ms) | Vector Mem (ms) | Vision (ms) | Inference (ms) | Crypto (ms) | Action (ms) | **Total Latency (ms)** | Status |
|---|---|---|---|---|---|---|---|---|
| Telemetry Calibration (Baseline) | 86.1 | 62.5 | 984.89 | 480.47 | 0.0 | 8.14 | **1622.1 ms** | PASS |
| Telemetry Calibration (Foveation ON) | 85.32 | 23.8 | 180.25 | 483.03 | 0.0 | 9.16 | **781.56 ms** | PASS |
| Telemetry Calibration (Optimized Edge) | 14.31 | 22.32 | 183.2 | 123.21 | 1.52 | 8.59 | **353.15 ms** | PASS |
| Telemetry Calibration (Cached Workflow) | 14.21 | 24.98 | 0.0 | 2.4 | 1.13 | 10.19 | **52.91 ms** | PASS |
| Orbital Visualizer Canvas Target | 15.78 | 22.39 | 180.29 | 120.11 | 1.07 | 8.1 | **347.74 ms** | PASS |

## 2. Optimization Comparison Matrix (Task #86 & #158)

| Architecture Layer | Baseline Unoptimized | SIH26171 Edge Optimized | Measured Improvement |
|---|---|---|---|
| **Visual Perception** | 980 ms (Full Frame 1080p) | 180 ms (Foveated Crop) | **81.6% Latency Reduction** |
| **DOM Payload Size** | 148.5 KB (Raw DOM) | 14.2 KB (2-Pass Filter) | **90.4% Token Compression** |
| **Planning Model** | 480 ms (3B Full Model) | 120 ms (0.5B Draft Model) | **75.0% Faster Inference** |
| **Cached Repeat Task** | 1,564 ms (Cold Reasoning) | 47 ms (Deterministic Replay) | **97.0% Latency Reduction** |
| **Local Memory DB** | Plaintext on Disk | AES-256-GCM Encrypted | **< 1.5 ms Cryptographic Cost** |
| **Network Requirement**| Cloud API Dependency | 100% On-Device / Offline | **Zero Outbound Calls** |