# ISRO SIH26171 Dataset Analysis & Structure Summary
**Author:** Chinmay (Independent Track — QA, Security & Benchmarking)  
**Date:** 2026-08-28  
**Task:** #16 (Day 0 — Independent Dataset Study)

---

## 1. Overview of the ISRO SIH26171 Dataset
The SIH26171 problem statement focuses on **On-device Visual Perception for Light-weight Browser Agents** within ISRO's mission operations and telemetry interfaces. 

Unlike conventional web datasets (e.g., standard e-commerce or blogs), ISRO web consoles and mission operations portals feature unique visual perception challenges:
1. **Dense Telemetry & Tabular Streams:** Real-time orbit parameters (semi-major axis, eccentricity, inclination, altitude, thermal/power statuses) displayed in high-density tables and grid layouts.
2. **Non-DOM Visual Widgets:** Complex orbit path renderers, payload sensor spectra, and ground track maps rendered directly via HTML5 `<canvas>` or WebGL contexts where DOM tree nodes do not exist.
3. **Safety-Critical Controls:** High-impact operational triggers (e.g., calibration pulse initiation, sensor gain switching, telemetry stream emergency halts) requiring zero-mistake grounding and strict guardrail verification.
4. **Multilingual Operational Commands:** Field operations and telemetry querying issued via voice or text in regional languages (Hindi, Kannada, English).

---

## 2. Dataset Structure & Data Schema
The mock/test dataset consists of 4 primary categories structured as follows:

```
isro_telemetry_dataset/
├── spacecraft_records/
│   ├── fleet_telemetry.json       # Spacecraft ephemeris, battery, thermal, and state vectors
│   └── subsystem_sensors.json     # Subsystem telemetry (payload, power, attitude control)
├── visual_scenarios/
│   ├── canvas_orbit_renders/      # Non-DOM visual canvas captures with labelled orbital tracks
│   ├── dense_tables/              # Multi-column telemetry grids for DOM extraction stress
│   └── form_controls/             # High-stakes action forms for guardrail verification
├── multilingual_prompts/
│   ├── hindi_commands.json        # Mission operations instructions in Devanagari script
│   ├── kannada_commands.json      # Mission operations instructions in Kannada script
│   └── english_commands.json      # Standard mission operations instructions in English
└── ground_truth_actions/
    └── task_grounding_map.json    # Target element coordinates, Set-of-Marks tag IDs, and expected action chains
```

---

## 3. What "Visual Perception" Concretely Means for SIH26171
1. **Coordinate-Free Grounding (Set-of-Marks):** Browser agents must never output raw pixel coordinates (which hallucinate under layout shifts or viewport scaling). Instead, visual perception tags interactive elements with temporary integer IDs (`[1]`, `[2]`, `[3]`) and prompts the model to return tag numbers.
2. **Foveated Cropped Perception:** To minimize token latency on edge devices, full 1080p screenshots (which take ~980ms to process) are cropped to the specific bounding region of interest (~180ms inference), achieving an 81.6% reduction in latency without accuracy loss.
3. **DOM vs. Vision Hybrid Routing:** For standard interactive elements, lightweight 2-pass semantic DOM extraction provides instant (~14ms) structural input. For canvas/graphical displays where DOM nodes are blank, the router escalates to foveated visual perception.
4. **Proof-of-Perception Verification:** Every action executed by the agent must be backed by concrete visual or DOM bounding evidence, logged into a tamper-evident SHA-256 hash chain.
