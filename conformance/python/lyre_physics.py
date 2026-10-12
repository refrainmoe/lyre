"""Second, independent implementation of Lyre §9 physics (Python stdlib only).

Deliberately structured differently from the TypeScript reference — complex-
number geometry, math.hypot distances, fused Verlet+stiffness loop, different
operation grouping and therefore different floating-point rounding — so that
agreement within the conformance tolerance (±0.1° per link per step, §12)
demonstrates the tolerance is achievable across real implementations rather
than being an artifact of one codebase.

Both implementations follow the same normative text (§9): IEEE-754 doubles,
default-centered input normalization, rest chain from anchor + φ only,
Verlet → stiffness lerp → single root→tip constraint with the exact-zero-vector
d̂(φ) rule, signed clockwise angles in the +y-down frame.
"""

from __future__ import annotations

import cmath
import math
import sys
from collections.abc import Callable

DEG = math.pi / 180.0
FIXED_STEP_BOUNDARY_ULPS = 8


def fixed_step_count(total_elapsed: float, step_dt: float) -> int:
    """§9 completed-step count with the normative eight-ULP boundary snap."""
    quotient = total_elapsed / step_dt
    nearest = round(quotient)
    tolerance = (
        FIXED_STEP_BOUNDARY_ULPS
        * sys.float_info.epsilon
        * max(1.0, abs(quotient), abs(nearest))
    )
    if abs(quotient - nearest) <= tolerance:
        quotient = float(nearest)
    return math.floor(quotient)


def add_compensated(value: float, error: float, delta: float) -> tuple[float, float]:
    """Add a binary64 clock delta while retaining the discarded low component."""
    summed = value + delta
    if abs(value) >= abs(delta):
        residue = (value - summed) + delta
    else:
        residue = (delta - summed) + value
    correction = error + residue
    next_value = summed + correction
    return next_value, (summed - next_value) + correction


def normalized(value: float, pmin: float, pmax: float, default: float) -> float:
    """§9: piecewise-linear map with the default at zero.

    [min, default] → [−1, 0] and [default, max] → [0, 1]; a degenerate
    half-interval maps to 0.
    """
    value = max(pmin, min(pmax, value))
    if value >= default:
        span = pmax - default
        return 0.0 if span == 0.0 else (value - default) / span
    span = default - pmin
    return 0.0 if span == 0.0 else (value - default) / span


def rest_direction(phi: float) -> complex:
    """(0, 1) rotated clockwise (viewer sense, +y down) by phi radians.

    Clockwise rotation in the +y-down frame is complex multiplication by
    e^{iφ} on x + iy (§8.2), so d̂(φ) = i·e^{iφ} = (−sin φ) + i·(cos φ).
    """
    return 1j * cmath.exp(1j * phi)


class Chain:
    """One §9 pendulum chain. Positions are complex (x + iy), index 0 = anchor."""

    def __init__(self, spec: dict, params: dict[str, tuple[float, float, float]]):
        self.spec = spec
        self.params = params
        self.links: list[dict] = spec["links"]
        g = spec.get("gravity", [0.0, 0.0])
        w = spec.get("wind", [0.0, 0.0])
        self.accel = complex(g[0] + w[0], g[1] + w[1])
        self.phi = 0.0
        self.p: list[complex] = []
        self.q: list[complex] = []

    def _anchor(self, values: dict[str, float]) -> tuple[complex, float]:
        pos = 0j
        phi = 0.0
        for inp in self.spec["inputs"]:
            pmin, pmax, pdef = self.params[inp["param"]]
            n = normalized(values.get(inp["param"], pdef), pmin, pmax, pdef)
            contribution = inp["weight"] * n
            kind = inp["type"]
            if kind == "x":
                pos += complex(contribution, 0.0)
            elif kind == "y":
                pos += complex(0.0, contribution)
            else:  # "angle": weight · normalized · 30°
                phi += contribution * 30.0 * DEG
        return pos, phi

    def _rest_chain(self, pos: complex, d: complex) -> list[complex]:
        rest = [pos]
        for link in self.links:
            rest.append(rest[-1] + link["length"] * d)
        return rest

    def reset(self, values: dict[str, float]) -> None:
        """§9 initialization: p = q = rest chain at the current inputs."""
        pos, phi = self._anchor(values)
        self.phi = phi
        rest = self._rest_chain(pos, rest_direction(phi))
        self.p = rest[:]
        self.q = rest[:]

    def step(self, values: dict[str, float], dt: float) -> None:
        pos, phi = self._anchor(values)
        self.phi = phi
        d = rest_direction(phi)
        rest = self._rest_chain(pos, d)
        self.p[0] = pos
        self.q[0] = pos
        acc = self.accel * (dt * dt)
        # Verlet + stiffness, fused per link (no cross-link dependency).
        for i, link in enumerate(self.links, start=1):
            velocity = (self.p[i] - self.q[i]) * (1.0 - link["damping"])
            self.q[i] = self.p[i]
            moved = self.p[i] + velocity + acc
            moved += (rest[i] - moved) * link["stiffness"]
            self.p[i] = moved
        # Single constraint pass, root → tip.
        for i, link in enumerate(self.links, start=1):
            delta = self.p[i] - self.p[i - 1]
            dist = math.hypot(delta.real, delta.imag)
            if dist == 0.0:
                # Exact-zero-vector rule: direction is d̂(φ).
                self.p[i] = self.p[i - 1] + link["length"] * d
            else:
                self.p[i] = self.p[i - 1] + delta * (link["length"] / dist)

    def angles(self) -> list[float]:
        """Signed output angle (degrees, clockwise positive) per link."""
        d = rest_direction(self.phi)
        out = []
        for i in range(1, len(self.p)):
            v = self.p[i] - self.p[i - 1]
            z = v * d.conjugate()  # arg(v / d̂): rotation from d̂ to v
            out.append(math.atan2(z.imag, z.real) / DEG + 0.0)
        return out


class Engine:
    """All chains plus a compensated total-elapsed fixed-step clock."""

    def __init__(self, physics: dict, params: dict[str, tuple[float, float, float]]):
        self.step_dt = 1.0 / physics["fps"]
        self.chains = {c["id"]: Chain(c, params) for c in physics["chains"]}
        self.total_elapsed = 0.0
        self.total_elapsed_error = 0.0
        self.completed_steps = 0

    def reset(self, values: dict[str, float]) -> None:
        self.total_elapsed = 0.0
        self.total_elapsed_error = 0.0
        self.completed_steps = 0
        for chain in self.chains.values():
            chain.reset(values)

    def advance(
        self,
        dt: float,
        values: dict[str, float],
        on_step: Callable[[], None] | None = None,
    ) -> None:
        next_elapsed, next_error = add_compensated(
            self.total_elapsed, self.total_elapsed_error, dt
        )
        final_completed_steps = fixed_step_count(next_elapsed + next_error, self.step_dt)
        step_count = final_completed_steps - self.completed_steps
        if step_count < 0:
            raise ValueError("physics elapsed clock lost a completed fixed step")
        for _ in range(step_count):
            for chain in self.chains.values():
                chain.step(values, self.step_dt)
            if on_step is not None:
                on_step()
        self.total_elapsed = next_elapsed
        self.total_elapsed_error = next_error
        self.completed_steps = final_completed_steps
