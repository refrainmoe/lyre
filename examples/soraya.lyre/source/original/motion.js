import { clamp, smoothstep } from "./math.js";

const TAU = Math.PI * 2;
const DEG_TO_RAD = Math.PI / 180;

export const IDLE_MOTION_DEFAULTS = Object.freeze({
  fixedDelta: 1 / 120,
  maxDelta: 0.1,
  floatPeriodA: 6.4,
  floatPeriodB: 9.1,
  breathPeriod: 4.2,
  blinkIntervalMin: 2.8,
  blinkIntervalMax: 5.6,
  blinkCloseDuration: 0.09,
  blinkHoldDuration: 0.035,
  blinkOpenDuration: 0.15,
  doubleBlinkChance: 0.15,
  doubleBlinkGap: 0.08,
  reducedBlinkIntervalMin: 4.8,
  reducedBlinkIntervalMax: 7.2,
});

function hashSeed(seed) {
  if (typeof seed === "number" && Number.isFinite(seed)) {
    return seed >>> 0;
  }

  const text = String(seed);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Deterministic Mulberry32 random source.
 */
export class SeededPRNG {
  constructor(seed = 0x6d2b79f5) {
    this.state = hashSeed(seed);
  }

  nextUint32() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  }

  next() {
    return this.nextUint32() / 0x100000000;
  }

  range(minimum, maximum) {
    return minimum + (maximum - minimum) * this.next();
  }

  int(minimum, maximumExclusive) {
    return Math.floor(this.range(minimum, maximumExclusive));
  }

  chance(probability) {
    return this.next() < clamp(probability, 0, 1);
  }

  getState() {
    return this.state;
  }

  setState(state) {
    this.state = hashSeed(state);
    return this;
  }
}

/**
 * Function-shaped PRNG for small consumers that do not need a class instance.
 */
export function createPRNG(seed) {
  const generator = new SeededPRNG(seed);
  const random = () => generator.next();
  random.range = (minimum, maximum) => generator.range(minimum, maximum);
  random.int = (minimum, maximumExclusive) => (
    generator.int(minimum, maximumExclusive)
  );
  random.chance = (probability) => generator.chance(probability);
  random.getState = () => generator.getState();
  random.setState = (state) => {
    generator.setState(state);
    return random;
  };
  return random;
}

/**
 * A scalar, fixed-timestep damped spring. Values are unitless so the same
 * implementation can drive angles, design-space offsets, or normalized cages.
 */
export class FixedStepSpring {
  constructor(initialValue = 0, options = {}) {
    if (typeof initialValue === "object") {
      options = initialValue;
      initialValue = options.value ?? 0;
    }

    this.value = Number.isFinite(initialValue) ? initialValue : 0;
    this.velocity = Number.isFinite(options.velocity) ? options.velocity : 0;
    this.frequency = options.frequency ?? options.frequencyHz ?? 2;
    this.damping = options.damping ?? options.dampingRatio ?? 0.75;
    this.fixedDelta = options.fixedDelta ?? 1 / 120;
    this.maxDelta = options.maxDelta ?? 0.1;
    this.accumulator = 0;
  }

  reset(value = 0, velocity = 0) {
    this.value = value;
    this.velocity = velocity;
    this.accumulator = 0;
    return this.value;
  }

  /**
   * Performs one integration step. IdleMotion uses this after applying its own
   * shared fixed clock so all secondary parts remain perfectly synchronized.
   */
  integrate(target, delta = this.fixedDelta) {
    if (!Number.isFinite(target) || !Number.isFinite(delta) || delta <= 0) {
      return this.value;
    }

    const angularFrequency = TAU * Math.max(0, this.frequency);
    const acceleration = (
      (target - this.value) * angularFrequency * angularFrequency
      - 2 * Math.max(0, this.damping) * angularFrequency * this.velocity
    );

    this.velocity += acceleration * delta;
    this.value += this.velocity * delta;
    return this.value;
  }

  update(target, delta) {
    const safeDelta = Number.isFinite(delta)
      ? clamp(delta, 0, this.maxDelta)
      : 0;
    this.accumulator += safeDelta;

    while (this.accumulator + Number.EPSILON >= this.fixedDelta) {
      this.integrate(target, this.fixedDelta);
      this.accumulator -= this.fixedDelta;
    }

    if (Math.abs(this.accumulator) < Number.EPSILON) {
      this.accumulator = 0;
    }
    return this.value;
  }
}

function makeSpring(frequency, damping, fixedDelta, maxDelta) {
  return new FixedStepSpring(0, {
    frequency,
    damping,
    fixedDelta,
    maxDelta,
  });
}

/**
 * Autonomous, deterministic motion controller.
 *
 * Root offsets are design-space pixels; rootRoll is radians; breath and all
 * secondary values are normalized. Blink values use 0=open and 1=closed.
 */
export class IdleMotion {
  constructor(options = {}) {
    this.fixedDelta = options.fixedDelta ?? IDLE_MOTION_DEFAULTS.fixedDelta;
    this.maxDelta = options.maxDelta ?? IDLE_MOTION_DEFAULTS.maxDelta;
    this.random = new SeededPRNG(options.seed ?? 1234);
    this.elapsed = 0;
    this.accumulator = 0;
    this.lastDelta = 0;
    this.reducedMotion = Boolean(options.reducedMotion);

    this._rootX = 0;
    this._rootY = 0;
    this._rootRollDegrees = 0;
    this._breath = 0;
    this._blinkLeft = 0;
    this._blinkRight = 0;
    this._backHairLift = 0;
    this._frontHairLift = 0;
    this._skirtFlutter = 0;
    this._armSwing = 0;
    this._legSwing = 0;
    this._kneeBend = 0;
    this._activeBlink = null;

    this._springs = {
      backHair: makeSpring(0.68, 1.02, this.fixedDelta, this.maxDelta),
      frontHair: makeSpring(0.92, 0.96, this.fixedDelta, this.maxDelta),
      skirt: makeSpring(0.82, 1.02, this.fixedDelta, this.maxDelta),
      bouquetSwing: makeSpring(1, 0.72, this.fixedDelta, this.maxDelta),
      bouquetFlex: makeSpring(1.15, 0.78, this.fixedDelta, this.maxDelta),
      bag: makeSpring(1.35, 0.64, this.fixedDelta, this.maxDelta),
    };

    this._nextBlinkAt = this._sampleBlinkInterval(this.reducedMotion);
  }

  reset(seed) {
    if (seed !== undefined) {
      this.random = new SeededPRNG(seed);
    }

    this.elapsed = 0;
    this.accumulator = 0;
    this.lastDelta = 0;
    this._rootX = 0;
    this._rootY = 0;
    this._rootRollDegrees = 0;
    this._breath = 0;
    this._blinkLeft = 0;
    this._blinkRight = 0;
    this._backHairLift = 0;
    this._frontHairLift = 0;
    this._skirtFlutter = 0;
    this._armSwing = 0;
    this._legSwing = 0;
    this._kneeBend = 0;
    this._activeBlink = null;
    Object.values(this._springs).forEach((spring) => spring.reset());
    this._nextBlinkAt = this._sampleBlinkInterval(this.reducedMotion);
    return this.parameters;
  }

  _sampleBlinkInterval(reducedMotion) {
    if (reducedMotion) {
      return this.random.range(
        IDLE_MOTION_DEFAULTS.reducedBlinkIntervalMin,
        IDLE_MOTION_DEFAULTS.reducedBlinkIntervalMax,
      );
    }
    return this.random.range(
      IDLE_MOTION_DEFAULTS.blinkIntervalMin,
      IDLE_MOTION_DEFAULTS.blinkIntervalMax,
    );
  }

  _setReducedMotion(reducedMotion) {
    if (reducedMotion === this.reducedMotion) {
      return;
    }

    this.reducedMotion = reducedMotion;
    if (!this._activeBlink) {
      this._nextBlinkAt = (
        this.elapsed + this._sampleBlinkInterval(reducedMotion)
      );
    }

    if (reducedMotion) {
      Object.values(this._springs).forEach((spring) => spring.reset());
    }
  }

  _startBlink(startTime) {
    const eyeDifference = this.random.range(-0.014, 0.014);
    const leftOffset = Math.max(0, -eyeDifference);
    const rightOffset = Math.max(0, eyeDifference);
    const isDouble = this.random.chance(
      IDLE_MOTION_DEFAULTS.doubleBlinkChance,
    );
    const blinkDuration = (
      IDLE_MOTION_DEFAULTS.blinkCloseDuration
      + IDLE_MOTION_DEFAULTS.blinkHoldDuration
      + IDLE_MOTION_DEFAULTS.blinkOpenDuration
    );
    const secondOffset = (
      blinkDuration + IDLE_MOTION_DEFAULTS.doubleBlinkGap
    );
    const sequenceDuration = (
      blinkDuration + (isDouble ? secondOffset : 0)
    );

    this._activeBlink = {
      startTime,
      leftOffset,
      rightOffset,
      isDouble,
      secondOffset,
      endTime: (
        startTime
        + sequenceDuration
        + Math.max(leftOffset, rightOffset)
      ),
    };
  }

  _blinkCurve(localTime) {
    const closeEnd = IDLE_MOTION_DEFAULTS.blinkCloseDuration;
    const holdEnd = closeEnd + IDLE_MOTION_DEFAULTS.blinkHoldDuration;
    const openEnd = holdEnd + IDLE_MOTION_DEFAULTS.blinkOpenDuration;

    if (localTime < 0 || localTime >= openEnd) {
      return 0;
    }
    if (localTime < closeEnd) {
      return smoothstep(0, closeEnd, localTime);
    }
    if (localTime < holdEnd) {
      return 1;
    }
    return 1 - smoothstep(holdEnd, openEnd, localTime);
  }

  _blinkForEye(offset) {
    if (!this._activeBlink) {
      return 0;
    }

    const localTime = (
      this.elapsed - this._activeBlink.startTime - offset
    );
    let value = this._blinkCurve(localTime);
    if (this._activeBlink.isDouble) {
      value = Math.max(
        value,
        this._blinkCurve(localTime - this._activeBlink.secondOffset),
      );
    }
    return value;
  }

  _updateBlink() {
    if (!this._activeBlink && this.elapsed >= this._nextBlinkAt) {
      this._startBlink(this._nextBlinkAt);
    }

    if (
      this._activeBlink
      && this.elapsed >= this._activeBlink.endTime
    ) {
      const sequenceEnd = this._activeBlink.endTime;
      this._activeBlink = null;
      this._nextBlinkAt = (
        sequenceEnd + this._sampleBlinkInterval(this.reducedMotion)
      );
    }

    this._blinkLeft = this._blinkForEye(
      this._activeBlink?.leftOffset ?? 0,
    );
    this._blinkRight = this._blinkForEye(
      this._activeBlink?.rightOffset ?? 0,
    );
  }

  _step(delta) {
    this.elapsed += delta;

    const phaseA = TAU * this.elapsed / IDLE_MOTION_DEFAULTS.floatPeriodA;
    const phaseB = TAU * this.elapsed / IDLE_MOTION_DEFAULTS.floatPeriodB;
    const breathPhase = (
      TAU * this.elapsed / IDLE_MOTION_DEFAULTS.breathPeriod
    );
    const windPhaseA = TAU * this.elapsed / 6.8;
    const windPhaseB = TAU * this.elapsed / 11.4;
    const hairPrimary = TAU * this.elapsed / 9.6;
    const hairDrift = TAU * this.elapsed / 15.7;
    const hairRipple = TAU * this.elapsed / 6.4;
    const armPhase = TAU * this.elapsed / 5.9;
    const legPhase = TAU * this.elapsed / 5.25;

    this._rootX = (
      0.45 * Math.sin(phaseA)
      + 0.2 * Math.sin(phaseB + 0.8)
    );
    this._rootY = (
      1.1 * Math.sin(phaseA - 0.25)
      + 0.5 * Math.sin(phaseB + 1.4)
    );
    this._rootRollDegrees = (
      0.08 * Math.sin(phaseA + 0.7)
      + 0.04 * Math.sin(phaseB - 0.4)
    );
    this._breath = Math.sin(breathPhase - 0.35);
    const sharedHairWind = (
      0.8 * Math.sin(hairPrimary - 0.15)
      + 0.15 * Math.sin(hairDrift + 0.55)
      + 0.05 * Math.sin(hairRipple - 0.35)
    );
    // Keep a fast fabric ripple tied to both gusts and the walking cadence.
    // Horizontal travel is authored separately and remains strictly left-only.
    this._skirtFlutter = clamp(
      0.52 * Math.sin(windPhaseA - 0.38)
      + 0.22 * Math.sin(windPhaseB + 0.48)
      + 0.36 * Math.sin(legPhase + 0.9),
      -1,
      1,
    );
    this._armSwing = clamp(
      0.72 * Math.sin(armPhase + 1.1)
      + 0.28 * Math.sin(phaseB - 0.7),
      -1,
      1,
    );
    this._legSwing = clamp(
      0.76 * Math.sin(legPhase - 0.6)
      + 0.24 * Math.sin(phaseA + 0.3),
      -1,
      1,
    );
    this._kneeBend = clamp(
      0.78 * Math.sin(legPhase - 0.25)
      + 0.22 * Math.sin(phaseB + 0.15),
      -1,
      1,
    );

    if (this.reducedMotion) {
      Object.values(this._springs).forEach((spring) => spring.reset());
      this._backHairLift = 0;
      this._frontHairLift = 0;
    } else {
      const normalizedX = this._rootX / 0.65;
      const normalizedRoll = this._rootRollDegrees / 0.12;
      const backWind = (
        0.92 * sharedHairWind
        + 0.06 * Math.sin(hairDrift - 0.4)
      );
      const frontWind = (
        0.66 * sharedHairWind
        + 0.16 * Math.sin(hairDrift + 1.25)
        + 0.08 * Math.sin(hairRipple + 0.75)
      );
      const skirtWindStrength = clamp(
        0.58
        - 0.55 * backWind
        + 0.14 * Math.sin(windPhaseB - 0.3)
        + 0.18 * Math.max(0, this._legSwing),
        0,
        1,
      );

      this._springs.backHair.integrate(
        clamp(backWind, -0.92, 0.92),
        delta,
      );
      this._springs.frontHair.integrate(
        clamp(frontWind, -0.82, 0.82),
        delta,
      );
      this._backHairLift = clamp(
        0.28 * this._springs.backHair.value
        + 0.055 * Math.sin(hairDrift - 0.15)
        + 0.025 * Math.sin(hairRipple + 0.9),
        -0.36,
        0.36,
      );
      this._frontHairLift = clamp(
        0.22 * this._springs.frontHair.value
        + 0.065 * Math.sin(hairDrift + 0.85)
        + 0.035 * Math.sin(hairRipple + 1.2),
        -0.3,
        0.3,
      );
      this._springs.skirt.integrate(
        -0.92 * skirtWindStrength,
        delta,
      );
      this._springs.bouquetSwing.integrate(
        clamp(
          -0.74 * this._armSwing
          + 0.26 * Math.sin(windPhaseA + 0.9),
          -1.08,
          1.08,
        ),
        delta,
      );
      this._springs.bouquetFlex.integrate(
        clamp(
          -0.32 * this._armSwing
          + 0.52 * Math.sin(windPhaseA - 1.05)
          + 0.16 * Math.sin(windPhaseB + 0.3),
          -1,
          1,
        ),
        delta,
      );
      this._springs.bag.integrate(
        clamp(
          -0.12 * normalizedX
          + 0.14 * normalizedRoll
          + 0.74 * this._armSwing,
          -1.08,
          1.08,
        ),
        delta,
      );
    }

    this._updateBlink();
  }

  update(delta, reducedMotion = this.reducedMotion) {
    this._setReducedMotion(Boolean(reducedMotion));
    const safeDelta = Number.isFinite(delta)
      ? clamp(delta, 0, this.maxDelta)
      : 0;
    this.lastDelta = safeDelta;
    this.accumulator += safeDelta;

    while (this.accumulator + Number.EPSILON >= this.fixedDelta) {
      this._step(this.fixedDelta);
      this.accumulator -= this.fixedDelta;
    }

    if (Math.abs(this.accumulator) < Number.EPSILON) {
      this.accumulator = 0;
    }
    return this.parameters;
  }

  get parameters() {
    const isReduced = this.reducedMotion;
    const rootX = isReduced ? 0 : this._rootX;
    const rootY = isReduced ? 0 : this._rootY;
    const rootRollDegrees = isReduced ? 0 : this._rootRollDegrees;
    const rootRoll = rootRollDegrees * DEG_TO_RAD;
    const breath = this._breath * (isReduced ? 0.18 : 1);
    const breathScale = 1 + breath * (isReduced ? 0.002 : 0.006);
    const backHairSway = isReduced ? 0 : this._springs.backHair.value;
    const frontHairSway = isReduced ? 0 : this._springs.frontHair.value;
    // The painted skirt is already at its furthest-right silhouette. Treat
    // that source pose as a hard stop and expose only leftward deformation.
    const skirtSway = isReduced
      ? 0
      : clamp(this._springs.skirt.value, -1, 0);
    const bouquetSwing = isReduced ? 0 : this._springs.bouquetSwing.value;
    const bouquetFlex = isReduced ? 0 : this._springs.bouquetFlex.value;
    const bagLag = isReduced ? 0 : this._springs.bag.value;
    const backHairLift = isReduced ? 0 : this._backHairLift;
    const frontHairLift = isReduced ? 0 : this._frontHairLift;
    const skirtFlutter = isReduced ? 0 : this._skirtFlutter;
    const armSwing = isReduced ? 0 : this._armSwing;
    const legSwing = isReduced ? 0 : this._legSwing;
    const kneeBend = isReduced ? 0 : this._kneeBend;
    const isBlinking = Boolean(this._activeBlink);
    const isDoubleBlink = Boolean(this._activeBlink?.isDouble);

    return {
      time: this.elapsed,
      delta: this.lastDelta,
      rootX,
      rootY,
      rootRoll,
      rootRollDeg: rootRollDegrees,
      breath,
      breathScale,
      blinkLeft: this._blinkLeft,
      blinkRight: this._blinkRight,
      backHairSway,
      frontHairSway,
      skirtSway,
      skirtFlutter,
      bouquetSwing,
      bouquetFlex,
      bagLag,
      backHairLift,
      frontHairLift,
      // Backwards-compatible aggregate channels for manual consumers.
      hairSway: backHairSway,
      hairLift: backHairLift,
      bouquetLag: bouquetSwing,
      armSwing,
      legSwing,
      kneeBend,
      root: {
        x: rootX,
        y: rootY,
        roll: rootRoll,
        rollDegrees: rootRollDegrees,
      },
      blink: {
        left: this._blinkLeft,
        right: this._blinkRight,
        active: isBlinking,
        double: isDoubleBlink,
      },
      secondary: {
        backHair: backHairSway,
        frontHair: frontHairSway,
        skirt: skirtSway,
        skirtFlutter,
        bouquet: bouquetSwing,
        bouquetFlex,
        bag: bagLag,
        backHairLift,
        frontHairLift,
        arm: armSwing,
        leg: legSwing,
        knee: kneeBend,
      },
    };
  }
}

export default IdleMotion;
