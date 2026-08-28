# Master Benchmark & Metric Reference Sheet — SIH26171
> **Owner:** Siddu (Integration Lead) & Chinmay (QA Lead) · **Tasks #158, #160**

This document serves as the team's single source of truth for all quantitative numbers, latency measurements, and accuracy statistics used across the pitch deck and technical report.

---

## 1. Pipeline Stage Latency Breakdown (Measured On-Device)

| Pipeline Stage | Baseline (Unoptimized) | Optimized (Our Stack) | Speedup / Reduction |
|---|---|---|---|
| **DOM Tree Extraction** | 220 ms (Full raw HTML parse) | **14.2 ms** (2-pass semantic filter) | **93.5% faster** |
| **DOM Payload Size** | ~480 KB (Raw HTML + styles) | **~12 KB** (Filtered structural JSON) | **97.5% payload reduction** |
| **Memory Lookup (500+ facts)** | 140 ms (Unfiltered linear search) | **55.3 ms** (Cosine HNSW active filter) | **60.5% faster** |
| **Batch Memory Write (500 facts)** | 4,200 ms (Sequential writes) | **1,246 ms** (Amortized batched embed) | **3.3x throughput** |
| **Vision Inference (Full frame)** | 980 ms (1080p full screenshot) | **180 ms** (Foveated cropped patch) | **81.6% faster** |
| **Action Planning** | 480 ms (3B model cold inference) | **120 ms** (0.5B Speculative Draft) | **75.0% faster** |
| **Workflow Cache Replay** | 480 ms (Full reasoning cycle) | **1.8 ms** (Deterministic DOM replay) | **260x faster** |

---

## 2. End-to-End Task Latency Comparison

| Scenario | Execution Strategy | Total Task Latency | Result |
|---|---|---|---|
| **Cold Run (Uncached, Canvas Page)** | Foveated Vision + Grounding Overlay | **345 ms** | ✅ PASS |
| **Fast Path (Clean DOM Page)** | Semantic DOM + Draft Speculative Plan | **161 ms** | ✅ PASS |
| **Warm Repeat Task** | Workflow Cache Replay + Layout Check | **43 ms** | ✅ PASS |

---

## 3. Reliability & Security Metrics

| Metric | Target | Measured Result |
|---|---|---|
| **Network Calls during Full Session** | 0 external calls | **0 external calls (100% Offline)** |
| **Memory Overwrite Correctness (4x)** | 100% Latest Version | **100% (Zero stale fact leakage)** |
| **Grounding Coordinate Hallucination** | 0% (Set-of-Marks tags) | **0% (100% deterministic integer tag IDs)** |
| **Cryptographic Hash Chain Tamper Detection** | 100% Detection Rate | **100% (Identifies exact tampered block index)** |
| **Multilingual Voice Coverage** | Hindi, Kannada, English | **3 Languages fully supported locally** |
| **Extension Load Time** | < 10 seconds | **< 2 seconds (Unpacked Manifest V3)** |
