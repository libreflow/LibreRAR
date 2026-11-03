import { describe, expect, it } from "vitest";
import { CHIPTUNE_BPM, makeDistortionCurve, midiToFreq } from "./chiptune";

describe("midiToFreq", () => {
  it("vaut 440 Hz pour le A4 (MIDI 69)", () => {
    expect(midiToFreq(69)).toBeCloseTo(440, 5);
  });

  it("double la fréquence par octave", () => {
    expect(midiToFreq(81)).toBeCloseTo(880, 5);
    expect(midiToFreq(57)).toBeCloseTo(220, 5);
  });

  it("vaut environ 261,63 Hz pour le C4 central (MIDI 60)", () => {
    expect(midiToFreq(60)).toBeCloseTo(261.6256, 3);
  });
});

describe("CHIPTUNE_BPM", () => {
  it("est un tempo raisonnable", () => {
    expect(CHIPTUNE_BPM).toBeGreaterThan(60);
    expect(CHIPTUNE_BPM).toBeLessThan(200);
  });
});

describe("makeDistortionCurve", () => {
  it("retourne une courbe de la taille demandée, bornée dans [-1, 1]", () => {
    const curve = makeDistortionCurve(2.4, 512);
    expect(curve).toHaveLength(512);
    expect(curve[0]).toBeCloseTo(-1, 5);
    expect(curve[curve.length - 1]).toBeCloseTo(1, 5);
  });

  it("est symétrique impaire (f(-x) = -f(x))", () => {
    const curve = makeDistortionCurve(2.4, 512);
    const last = curve.length - 1;
    for (const i of [0, 64, 128, 256]) {
      expect(curve[i]).toBeCloseTo(-curve[last - i], 5);
    }
  });

  it("est croissante", () => {
    const curve = makeDistortionCurve(3, 256);
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]).toBeGreaterThanOrEqual(curve[i - 1]);
    }
  });

  it("sature le signal (un drive plus fort redresse la courbe)", () => {
    const soft = makeDistortionCurve(1.5, 1024);
    const hard = makeDistortionCurve(6, 1024);
    const mid = soft[Math.floor(soft.length * 0.75)]!; // x = 0.5
    const midHard = hard[Math.floor(hard.length * 0.75)]!;
    expect(mid).toBeLessThan(1);
    expect(midHard).toBeGreaterThan(mid); // plus de drive = saturation plus franche
  });

  it("donne une courbe identité sans drive", () => {
    const curve = makeDistortionCurve(0, 129);
    expect(curve[0]).toBeCloseTo(-1, 5);
    expect(curve[64]).toBeCloseTo(0, 5);
    expect(curve[128]).toBeCloseTo(1, 5);
  });
});
