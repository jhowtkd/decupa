// Tempos da interface (puros): relógio m:ss, relógio com décimo e duração
// com vírgula decimal pt-BR. Não-finito ou negativo vira zero.
function safe(seconds) {
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

/** 73.12 → "1:13" (segundos inteiros, truncados). */
export function clock(seconds) {
  const whole = Math.floor(safe(seconds));
  return Math.floor(whole / 60) + ":" + String(whole % 60).padStart(2, "0");
}

/** 14.6 → "0:14,6" (décimo arredondado). */
export function clockPrecise(seconds) {
  const tenths = Math.round(safe(seconds) * 10);
  const whole = Math.floor(tenths / 10);
  return Math.floor(whole / 60) + ":" + String(whole % 60).padStart(2, "0") + "," + (tenths % 10);
}

/** 21.32 → "21,3 s". */
export function seconds1(seconds) {
  return safe(seconds).toFixed(1).replace(".", ",") + " s";
}
