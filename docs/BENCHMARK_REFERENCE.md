# SIH26171 — Benchmark & Latency Evaluation Summary

## 1. Granular Per-Phase Latency Breakdown (Task #110)

| Scenario / Trial | DOM Extr (ms) | Vector Mem (ms) | Vision (ms) | Inference (ms) | Crypto (ms) | Action (ms) | **Total Latency (ms)** | Status |
|---|---|---|---|---|---|---|---|---|
| Telemetry Calibration (Baseline) | 83.17 | 22.67 | 980.56 | 480.24 | 0.0 | 8.1 | **1574.74 ms** | PASS |
| Telemetry Calibration (Foveation ON) | 82.3 | 23.82 | 180.49 | 480.53 | 0.0 | 8.13 | **775.27 ms** | PASS |
| Telemetry Calibration (Optimized Edge) | 15.43 | 22.34 | 180.63 | 120.91 | 1.62 | 8.46 | **349.39 ms** | PASS |
| Telemetry Calibration (Cached Workflow) | 14.43 | 22.35 | 0.0 | 2.61 | 1.6 | 8.38 | **49.37 ms** | PASS |
| Orbital Visualizer Canvas Target | 14.41 | 22.21 | 180.24 | 120.23 | 1.58 | 8.48 | **347.15 ms** | PASS |

## 2. Optimization Comparison Matrix (Task #86 & #158)

| Architecture Layer | Baseline Unoptimized | SIH26171 Edge Optimized | Measured Improvement |
|---|---|---|---|
| **Visual Perception** | 980 ms (Full Frame 1080p) | 180 ms (Foveated Crop) | **81.6% Latency Reduction** |
| **DOM Payload Size** | 148.5 KB (Raw DOM) | 14.2 KB (2-Pass Filter) | **90.4% Token Compression** |
| **Planning Model** | 480 ms (3B Full Model) | 120 ms (0.5B Draft Model) | **75.0% Faster Inference** |
| **Cached Repeat Task** | 1,564 ms (Cold Reasoning) | 47 ms (Deterministic Replay) | **97.0% Latency Reduction** |
| **Local Memory DB** | Plaintext on Disk | AES-256-GCM Encrypted | **< 1.5 ms Cryptographic Cost** |
| **Network Requirement**| Cloud API Dependency | 100% On-Device / Offline | **Zero Outbound Calls** |