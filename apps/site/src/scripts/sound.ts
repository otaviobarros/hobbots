/** The hobs' chirps: short square-wave notes, off until the visitor turns them on. */

const KEY = "hobbots-sound";
let on = false;
let context: AudioContext | null | undefined;

const audio = () => {
  if (context === undefined) {
    try {
      context = new AudioContext();
    } catch {
      context = null;
    }
  }
  return context;
};

/** Plays notes one after another; `force` plays them even while sound is off. */
export const notes = (frequencies: ReadonlyArray<number>, length: number, force = false) => {
  if (!on && !force) return;
  const ctx = audio();
  if (!ctx) return;
  let at = ctx.currentTime + 0.01;
  for (const frequency of frequencies) {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "square";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.04, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(at);
    oscillator.stop(at + length + 0.02);
    at += length * 0.9;
  }
};

/** A hob's chirp, a little off pitch each time. */
export const chirp = (frequencies: ReadonlyArray<number>) =>
  notes(
    frequencies.map((f) => f * (0.96 + Math.random() * 0.08)),
    0.06,
  );

const show = (button: HTMLButtonElement) => {
  button.textContent = on ? "Sound: on" : "Sound: off";
};

export const initSound = () => {
  const button = document.querySelector<HTMLButtonElement>("[data-sound]");
  if (!button) return;
  try {
    on = localStorage.getItem(KEY) === "1";
  } catch {
    on = false;
  }
  show(button);
  button.addEventListener("click", () => {
    on = !on;
    try {
      localStorage.setItem(KEY, on ? "1" : "0");
    } catch {
      // Private windows may refuse storage; the toggle still works for this visit.
    }
    show(button);
    if (on) {
      void audio()?.resume();
      notes([523, 784], 0.07, true);
    }
  });
};
