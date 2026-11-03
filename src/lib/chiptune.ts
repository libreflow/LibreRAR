/**
 * Boucle chiptune originale jouée en mode Balatro (easter egg « JIMBO »).
 * Synthèse Web Audio pure, inspirée de l'ESTHETIQUE jazz-lounge chiptune du
 * jeu (swing, walking bass, accords de septième) sans reproduire son OST,
 * qui reste protégée par le droit d'auteur.
 *
 * Structure : boucle ii-V-I jazz de 4 mesures (Dm7 · G7 · Cmaj7 · A7),
 * basse marchande en noires, comp d'accords sur temps 2 et 4,
 * riff syncopé en mineur dorien, batterie souple brossée.
 */

export const CHIPTUNE_BPM = 104;

/** Fréquence en hertz d'une note MIDI (69 = A4 = 440 Hz). */
export function midiToFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/**
 * Courbe de saturation douce (soft-clip type étage analogique) pour un
 * WaveShaperNode. `drive` contrôle l'intensité ; 0 ou moins donne une
 * courbe identité (pas de distortion). La sortie est normalisée pour
 * rester dans [-1, 1].
 */
export function makeDistortionCurve(drive: number, samples = 1024) {
  const curve = new Float32Array(samples);
  const norm = drive > 0 ? Math.tanh(drive) : 1;
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = drive > 0 ? Math.tanh(drive * x) / norm : x;
  }
  return curve;
}

// Basse marchande : 4 noires par mesure (notes de l'accord + approches).
const BASS: number[][] = [
  [38, 41, 45, 48], // Dm7 : D F A C
  [43, 47, 50, 41], // G7 : G B D F (approche vers C)
  [36, 40, 43, 47], // Cmaj7 : C E G B
  [45, 49, 52, 43], // A7 : A C# E G (ramène vers D)
];

// Voix de comp à trois sons (registre médium, sans fondamentale).
const COMP: number[][] = [
  [62, 65, 72], // Dm7 : D F C
  [59, 62, 65], // G7 : B D F
  [59, 64, 67], // Cmaj7 : B E G
  [61, 64, 67], // A7 : C# E G
];

// Riff dorien syncopé, 8 croches swingées par mesure. 0 = silence.
const LEAD: number[][] = [
  [62, 0, 65, 69, 0, 72, 0, 71],
  [69, 0, 65, 62, 0, 60, 62, 0],
  [0, 64, 67, 0, 72, 0, 71, 69],
  [67, 0, 69, 0, 73, 0, 0, 0],
];

// Positions (en temps) des croches swingées dans une mesure à 4 temps.
const SWUNG_SLOTS = [0, 0.6, 1, 1.6, 2, 2.6, 3, 3.6];

/**
 * Démarre la boucle. Retourne une fonction d'arrêt (fondu court puis
 * fermeture du contexte audio).
 */
export function startChiptune(): () => void {
  const ctx = new AudioContext();

  // Chaîne : bus → saturation (drive) → filtre doux → compresseur → volume.
  const bus = ctx.createGain();
  bus.gain.value = 1;

  const driveIn = ctx.createGain();
  driveIn.gain.value = 2.2; // pousse le signal dans la saturation

  const shaper = ctx.createWaveShaper();
  shaper.curve = makeDistortionCurve(2.4);
  shaper.oversample = "4x";

  const driveOut = ctx.createGain();
  driveOut.gain.value = 0.45; // compense le gain de poussée

  const warm = ctx.createBiquadFilter();
  warm.type = "lowpass";
  warm.frequency.value = 4200; // adoucit les ondes carrées (coté « keys »)

  const comp = ctx.createDynamicsCompressor();
  const master = ctx.createGain();
  master.gain.value = 0.14;

  bus.connect(driveIn);
  driveIn.connect(shaper);
  shaper.connect(driveOut);
  driveOut.connect(warm);
  warm.connect(comp);
  comp.connect(master);
  master.connect(ctx.destination);

  // Tampon de bruit blanc partagé (percussions « brush »).
  const noiseLength = Math.floor(ctx.sampleRate * 0.25);
  const noiseBuffer = ctx.createBuffer(1, noiseLength, ctx.sampleRate);
  const noiseData = noiseBuffer.getChannelData(0);
  for (let i = 0; i < noiseLength; i++) {
    noiseData[i] = Math.random() * 2 - 1;
  }

  const beat = 60 / CHIPTUNE_BPM;
  const barLength = beat * 4;

  const note = (
    freq: number,
    start: number,
    duration: number,
    type: OscillatorType,
    gain: number,
    detune = 0,
  ) => {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    osc.detune.value = detune;
    env.gain.setValueAtTime(gain, start);
    env.gain.exponentialRampToValueAtTime(0.001, start + duration);
    osc.connect(env);
    env.connect(bus);
    osc.start(start);
    osc.stop(start + duration);
  };

  const brush = (start: number, duration: number, gain: number, hz: number) => {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = hz;
    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, start);
    env.gain.exponentialRampToValueAtTime(0.001, start + duration);
    src.connect(filter);
    filter.connect(env);
    env.connect(bus);
    src.start(start);
    src.stop(start + duration);
  };

  const kick = (start: number, gain: number) => {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(120, start);
    osc.frequency.exponentialRampToValueAtTime(42, start + 0.1);
    env.gain.setValueAtTime(gain, start);
    env.gain.exponentialRampToValueAtTime(0.001, start + 0.13);
    osc.connect(env);
    env.connect(bus);
    osc.start(start);
    osc.stop(start + 0.13);
  };

  const scheduleBar = (time: number, bar: number) => {
    const bass = BASS[bar]!;
    const comp_ = COMP[bar]!;
    const lead = LEAD[bar]!;

    // Basse marchande : noires roundes, legato.
    for (let i = 0; i < 4; i++) {
      note(midiToFreq(bass[i]!), time + i * beat, beat * 0.95, "triangle", 0.9);
    }

    // Comp d'accords sur les temps 2 et 4 : deux oscillateurs légèrement
    // désaccordés pour un coté orgue/keys.
    for (const beatIndex of [1, 3]) {
      const at = time + beatIndex * beat;
      for (const midi of comp_) {
        const freq = midiToFreq(midi);
        note(freq, at, beat * 0.7, "square", 0.14);
        note(freq, at, beat * 0.7, "square", 0.14, 8);
      }
    }

    // Riff mélodique sur la grille swingée.
    for (let i = 0; i < 8; i++) {
      if (lead[i] === 0) continue;
      const at = time + SWUNG_SLOTS[i]! * beat;
      note(midiToFreq(lead[i]!), at, beat * 0.45, "square", 0.32, -5);
    }

    // Batterie lounge : charley swingé, kick discret, caisse claire brossée.
    for (let i = 0; i < 8; i++) {
      const at = time + SWUNG_SLOTS[i]! * beat;
      brush(at, 0.03, i % 2 === 0 ? 0.1 : 0.2, 8000);
    }
    kick(time, 0.8);
    kick(time + 2 * beat, 0.5);
    brush(time + beat, 0.14, 0.45, 1400);
    brush(time + 3 * beat, 0.14, 0.5, 1400);
  };

  let stopped = false;
  let nextBarTime = ctx.currentTime + 0.05;
  let bar = 0;
  let timer = 0;

  const tick = () => {
    if (stopped) return;
    while (nextBarTime < ctx.currentTime + 0.4) {
      scheduleBar(nextBarTime, bar);
      bar = (bar + 1) % BASS.length;
      nextBarTime += barLength;
    }
    timer = window.setTimeout(tick, 100);
  };
  timer = window.setTimeout(tick, 0);

  return () => {
    stopped = true;
    window.clearTimeout(timer);
    master.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
    window.setTimeout(() => void ctx.close(), 300);
  };
}
