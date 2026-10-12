#!/usr/bin/env python3
"""Compare the Python §9 implementation against the golden physics traces.

Replays every corpus timeline that has a committed trace (goldens/<id>/
trace.json), feeding the same per-step host inputs into lyre_physics, and
checks every link output at every step against the golden values at the §12
tolerance (±0.1°). Also verifies the §9 exact-zero-vector constraint rule,
which the trace suite cannot cover (the §12 perturbation admission excludes
exact equality by construction — see conformance/README.md).

Usage:
    python3 compare_traces.py [--write-results]

stdlib only; exit code 0 = all within tolerance.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

from lyre_physics import Chain, Engine, fixed_step_count, normalized, rest_direction

HERE = Path(__file__).resolve().parent
CORPUS = HERE.parent
TOLERANCE = 0.1


def read_json(path: Path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def load_model_docs(model_dir: Path) -> tuple[dict, dict, dict]:
    """Returns (params, physics, guard_docs) for a container directory."""
    manifest = read_json(model_dir / "manifest.json")
    files = manifest.get("files", {})
    rig = read_json(model_dir / files.get("rig", "rig.json"))
    physics = read_json(model_dir / files["physics"])

    params: dict[str, tuple[float, float, float]] = {}
    for p in rig.get("params", []):
        params[p["id"]] = (p["min"], p["max"], p["default"])

    # Guard: this runner composes host input only (set/clear events). Refuse
    # models whose motions/expressions could move a physics input param —
    # none in the corpus do, and silently ignoring them would be wrong.
    input_params = {i["param"] for c in physics["chains"] for i in c["inputs"]}
    for rel in files.get("motions", []):
        doc = read_json(model_dir / rel)
        for track in doc.get("tracks", []):
            if track["param"] in input_params:
                raise SystemExit(f"{model_dir.name}: motion targets physics input {track['param']}")
    for rel in files.get("expressions", []):
        doc = read_json(model_dir / rel)
        for entry in doc.get("params", []):
            if entry["id"] in input_params:
                raise SystemExit(
                    f"{model_dir.name}: expression targets physics input {entry['id']}"
                )
    return params, physics, rig


def run_timeline(timeline_path: Path, chain_ids: list[str]) -> dict[str, list[list[float]]]:
    timeline = read_json(timeline_path)
    model_dir = (timeline_path.parent / timeline["model"]).resolve()
    params, physics, _rig = load_model_docs(model_dir)

    engine = Engine(physics, params)
    host: dict[str, float] = {}
    # §9 initialization happens at load, before any timeline event.
    values = {pid: d for pid, (_, _, d) in params.items()}
    engine.reset(values)

    by_step: dict[int, list[dict]] = {}
    for event in timeline.get("events", []):
        by_step.setdefault(event["step"], []).append(event)

    trace: dict[str, list[list[float]]] = {cid: [] for cid in chain_ids}
    elapsed = 0.0
    for step in range(timeline["steps"]):
        for event in by_step.get(step, []):
            for pid, v in event.get("set", {}).items():
                host[pid] = v
            for pid in event.get("clear", []):
                host.pop(pid, None)
        composed = {pid: host.get(pid, d) for pid, (_, _, d) in params.items()}
        def append_internal_step() -> None:
            for cid in chain_ids:
                angles = engine.chains[cid].angles()
                # Same 1e-9° rounding as the golden traces.
                trace[cid].append([round(a * 1e9) / 1e9 + 0.0 for a in angles])

        endpoint = (step + 1) / timeline["fps"]
        engine.advance(endpoint - elapsed, composed, append_internal_step)
        elapsed = endpoint
    return trace


def check_zero_vector_rule() -> None:
    """§9: coincident link → direction is exactly d̂(φ), output angle 0."""
    params = {"drive": (-1.0, 1.0, 0.0)}
    spec = {
        "id": "zv",
        "inputs": [{"param": "drive", "type": "angle", "weight": 1.0}],
        "links": [{"length": 50.0, "damping": 0.0, "stiffness": 0.0}],
        "gravity": [0.0, 0.0],
        "wind": [0.0, 0.0],
        "outputs": [],
    }
    chain = Chain(spec, params)
    chain.reset({"drive": 0.25})
    # Collapse the link onto its parent with zero velocity, then step.
    chain.p[1] = chain.p[0]
    chain.q[1] = chain.p[0]
    chain.step({"drive": 0.25}, 1.0 / 60.0)
    d = rest_direction(chain.phi)
    expected = chain.p[0] + 50.0 * d
    assert chain.p[1] == expected, "zero-vector fallback must be exactly anchor + length·d̂(φ)"
    angle = chain.angles()[0]
    assert angle == 0.0 and not math.copysign(1.0, angle) < 0, "fallback angle must be exactly +0"
    print("zero-vector rule: exact d̂(φ) fallback verified (angle == +0.0)")


def check_accumulator_boundaries() -> None:
    """§9 total-elapsed counting: stable ordinals and narrow boundary snaps."""
    ordinary = Engine({"fps": 59.94, "chains": []}, {})
    ordinary_steps = 0

    def count_ordinary() -> None:
        nonlocal ordinary_steps
        ordinary_steps += 1

    ordinary.advance(600 / 59.94, {}, count_ordinary)
    assert ordinary_steps == 600, "update(N/fps) must produce exactly N steps"

    near_boundary = Engine({"fps": 0.99999999995, "chains": []}, {})
    near_boundary_steps = 0

    def count_near_boundary() -> None:
        nonlocal near_boundary_steps
        near_boundary_steps += 1

    near_boundary.advance(10.0, {}, count_near_boundary)
    assert near_boundary_steps == 9, "a genuine 9.9999999995 steps must floor to nine"

    def indexed_distribution(script_fps: float) -> tuple[list[int], list[int]]:
        engine = Engine({"fps": 60.0, "chains": []}, {})
        actual: list[int] = []
        expected: list[int] = []
        elapsed = 0.0
        expected_completed = 0
        frame = 0
        while elapsed < 10.0:
            endpoint = min(10.0, (frame + 1) / script_fps)
            count = 0

            def count_step() -> None:
                nonlocal count
                count += 1

            engine.advance(endpoint - elapsed, {}, count_step)
            actual.append(count)
            final_completed = fixed_step_count(endpoint, engine.step_dt)
            expected.append(final_completed - expected_completed)
            expected_completed = final_completed
            elapsed = endpoint
            frame += 1
        return actual, expected

    # Integer-index 60 fps endpoints must yield one step on every update. A
    # remainder accumulator can preserve the final total while pathologically
    # alternating zero-step and two-step updates in the middle of the run.
    common_actual, common_expected = indexed_distribution(60.0)
    assert common_expected == [1] * 600
    assert common_actual == common_expected, "60 fps endpoints must produce one step per update"

    # A non-integral outer cadence must match the ordinal difference at every
    # update, not merely arrive at the same 600-step final total.
    fractional_actual, fractional_expected = indexed_distribution(29.9)
    assert fractional_actual == fractional_expected, (
        "29.9 fps cadence must preserve the per-update fixed-step distribution"
    )
    assert sum(fractional_actual) == 600
    print(
        "fixed-step boundaries: N/fps snap, near-boundary floor, and "
        "per-update indexed cadence verified"
    )


def check_normalized_input_bounds() -> None:
    """§9: hostile finite host values are held at parameter boundaries."""
    assert normalized(1e300, -2.0, 3.0, 0.5) == 1.0
    assert normalized(-1e300, -2.0, 3.0, 0.5) == -1.0
    print("normalized input: out-of-range host values clamp to ±1")


def main() -> int:
    write_results = "--write-results" in sys.argv[1:]
    check_zero_vector_rule()
    check_accumulator_boundaries()
    check_normalized_input_bounds()

    rows: list[tuple[str, str, int, float]] = []
    failed = False
    for trace_path in sorted(CORPUS.glob("goldens/*/trace.json")):
        timeline_id = trace_path.parent.name
        timeline_path = CORPUS / "timelines" / f"{timeline_id}.timeline.json"
        golden = read_json(trace_path)
        chain_ids = sorted(golden["chains"].keys())

        ours = run_timeline(timeline_path, chain_ids)
        for cid in chain_ids:
            gsteps = golden["chains"][cid]
            psteps = ours[cid]
            if len(gsteps) != len(psteps):
                raise SystemExit(f"{timeline_id}/{cid}: step count {len(psteps)} != {len(gsteps)}")
            max_dev = 0.0
            for gs, ps in zip(gsteps, psteps):
                for gv, pv in zip(gs, ps):
                    max_dev = max(max_dev, abs(gv - pv))
            ok = max_dev <= TOLERANCE
            failed |= not ok
            rows.append((timeline_id, cid, len(gsteps), max_dev))
            print(
                f"{'PASS' if ok else 'FAIL'} {timeline_id}/{cid}: "
                f"{len(gsteps)} steps, max deviation {max_dev:.9f}° (tolerance ±{TOLERANCE}°)"
            )

    if write_results:
        lines = [
            "# Independent physics conformance verification",
            "",
            "The §9/§12 conformance tolerance of ±0.1° per link per step holds across a",
            "deliberately different second implementation. The Python",
            "implementation in [`lyre_physics.py`](lyre_physics.py) (complex-number",
            "geometry, `math.hypot`, fused Verlet+stiffness loop — different operation",
            "grouping, therefore different IEEE-754 rounding) reproduces every committed",
            "golden trace within the figures below, orders of magnitude inside the",
            "tolerance.",
            "",
            "Regenerate: `python3 conformance/python/compare_traces.py --write-results`",
            "",
            "| timeline | chain | steps | max deviation (°) | tolerance (°) |",
            "| --- | --- | ---: | ---: | ---: |",
        ]
        for timeline_id, cid, steps, max_dev in rows:
            lines.append(f"| {timeline_id} | {cid} | {steps} | {max_dev:.9f} | 0.1 |")
        lines += [
            "",
            "The §9 exact-zero-vector rule (coincident link → direction d̂(φ)) is",
            "verified by an exact-arithmetic check in this script rather than by a",
            "golden trace: the §12 perturbation admission excludes exact equality by",
            "construction (any 1e-9 px displacement breaks it and flips the fallback",
            "direction), so no perturbation-stable trace scenario can reach that branch.",
            "",
        ]
        (HERE / "RESULTS.md").write_text("\n".join(lines), encoding="utf-8")
        print(f"wrote {HERE / 'RESULTS.md'}")

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
