let ctx: AudioContext | null = null;

/** Short alert tone (no audio files needed, works offline). */
export function beep(pattern: number[] = [880, 0, 880], stepMs = 140) {
  try {
    ctx ??= new AudioContext();
    const t0 = ctx.currentTime;
    pattern.forEach((freq, i) => {
      if (!freq) return;
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.frequency.value = freq;
      osc.type = 'square';
      gain.gain.setValueAtTime(0.08, t0 + (i * stepMs) / 1000);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + ((i + 1) * stepMs) / 1000);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(t0 + (i * stepMs) / 1000);
      osc.stop(t0 + ((i + 1) * stepMs) / 1000);
    });
  } catch {
    /* audio blocked until the user interacts with the page */
  }
}

/** Browsers require one user gesture before audio can play. */
export function unlockAudio() {
  try {
    ctx ??= new AudioContext();
    void ctx.resume();
  } catch {
    /* ignore */
  }
}
