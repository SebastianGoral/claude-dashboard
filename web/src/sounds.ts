/**
 * Short alert sounds made with Web Audio, so there is no sound file.
 * The browser allows sound only after a click on the page, so unlock() runs on the first click.
 */
let ctx: AudioContext | null = null;

export function unlockSound(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    // No Web Audio: no sounds.
  }
}

function tones(frequencies: number[], step = 0.12): void {
  if (!ctx || ctx.state !== 'running') return;
  const start = ctx.currentTime;
  frequencies.forEach((frequency, i) => {
    const osc = ctx!.createOscillator();
    const gain = ctx!.createGain();
    osc.frequency.value = frequency;
    const t = start + i * step;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.2, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + step);
    osc.connect(gain).connect(ctx!.destination);
    osc.start(t);
    osc.stop(t + step);
  });
}

/** A session finished: two notes down. */
export const playFinished = () => tones([880, 660]);
/** A session needs you (permission): three notes up. */
export const playNeedsYou = () => tones([660, 880, 1100]);
