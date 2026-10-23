// Tempos e formatos da interface (puros): relógio m:ss, relógio com décimo, duração
// com vírgula decimal pt-BR (não-finito ou negativo vira zero) e o formato do quadro.
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

/** 21.32 → "21,3 s" (décimo arredondado, o mesmo critério de clockPrecise). */
export function seconds1(seconds) {
  const tenths = Math.round(safe(seconds) * 10);
  return Math.floor(tenths / 10) + "," + (tenths % 10) + " s";
}

/** Proporções que o studio oferece, na ordem do diálogo de formato. */
export const PROPORCOES = [
  { id: "16:9", w: 16, h: 9, uso: "horizontal" },
  { id: "9:16", w: 9, h: 16, uso: "vertical" },
  { id: "1:1", w: 1, h: 1, uso: "quadrado" },
  { id: "4:5", w: 4, h: 5, uso: "vertical para feed" },
];

/** {num: 30, den: 1} → "30 fps"; 30000/1001 → "29,97 fps". */
export function fpsLabel(fps) {
  const value = fps && fps.den > 0 ? fps.num / fps.den : 0;
  return String(Number(value.toFixed(2))).replace(".", ",") + " fps";
}

/**
 * Nome da proporção do quadro: uma das PROPORCOES quando bate (a resolução
 * par arredonda, daí a folga de 1%), senão a razão reduzida.
 */
export function formatRatio(width, height) {
  if (!(width > 0) || !(height > 0)) return "";
  const known = PROPORCOES.find((item) => Math.abs((width / height) / (item.w / item.h) - 1) < 0.01);
  if (known) return known.id;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const d = gcd(width, height);
  return width / d + ":" + height / d;
}

/** Formato com a resolução de saída: "16:9 · 1920×1080 · 30 fps". */
export function formatChip(assembly) {
  if (!assembly) return "";
  return formatRatio(assembly.width, assembly.height) + " · " + assembly.width + "×" + assembly.height + " · " + fpsLabel(assembly.fps);
}
