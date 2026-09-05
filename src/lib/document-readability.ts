// Site S2 / S2.1. The readability check that runs BEFORE payment, in the
// browser, on the image the customer picked.
//
// What it is: resolution, blur and orientation, measured on the pixels. What
// it is NOT: OCR. No text is read here, nothing is sent anywhere, and no
// judgement about the payslip's content is made — this only answers "is this
// picture legible enough to be worth paying to have read?", which is the
// question that prevents the refund.
//
// A PDF is not measured: it carries its own text or its own scan, and judging
// it needs the parser, not a canvas. Its page count is reported instead.

export type ReadabilityVerdict = "ok" | "warn" | "unmeasurable";

export type ReadabilityReport = Readonly<{
  verdict: ReadabilityVerdict;
  /** One short sentence for the customer, or null when there is nothing to say. */
  message: string | null;
  width: number | null;
  height: number | null;
  /** Higher is sharper. Null when not measured. */
  sharpness: number | null;
}>;

/** Below this, a payslip photographed on a phone is usually too small to read reliably. */
const MIN_LONG_EDGE = 1000;
/** Variance of the Laplacian, on the scale this implementation produces. Tuned to flag obvious blur only. */
const MIN_SHARPNESS = 40;

const UNMEASURABLE: ReadabilityReport = Object.freeze({ verdict: "unmeasurable", message: null, width: null, height: null, sharpness: null });

/**
 * Variance of the Laplacian over a grayscale downsample — the standard cheap
 * blur estimate. A sharp edge produces large second derivatives and so a large
 * variance; a blurred one flattens them.
 */
function sharpnessOf(data: ImageData): number {
  const { width, height } = data;
  const gray = new Float32Array(width * height);
  for (let index = 0; index < gray.length; index += 1) {
    const at = index * 4;
    gray[index] = 0.299 * data.data[at]! + 0.587 * data.data[at + 1]! + 0.114 * data.data[at + 2]!;
  }
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const at = y * width + x;
      const laplacian = -4 * gray[at]! + gray[at - 1]! + gray[at + 1]! + gray[at - width]! + gray[at + width]!;
      sum += laplacian;
      sumSquares += laplacian * laplacian;
      count += 1;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  return sumSquares / count - mean * mean;
}

export function verdictFor(input: Readonly<{ width: number; height: number; sharpness: number }>): ReadabilityReport {
  const longEdge = Math.max(input.width, input.height);
  const portrait = input.height >= input.width;
  if (longEdge < MIN_LONG_EDGE) {
    return { verdict: "warn", message: "התמונה קטנה. צילום מקרוב, בתאורה טובה, יקרא טוב יותר.", width: input.width, height: input.height, sharpness: input.sharpness };
  }
  if (input.sharpness < MIN_SHARPNESS) {
    return { verdict: "warn", message: "התמונה נראית מטושטשת. כדאי לצלם שוב עם יד יציבה.", width: input.width, height: input.height, sharpness: input.sharpness };
  }
  if (!portrait) {
    // Not a refusal: a landscape payslip is legible, it is just unusual and often a sideways photograph.
    return { verdict: "warn", message: "התמונה רוחבית. אם התלוש מסובב, כדאי ליישר אותו.", width: input.width, height: input.height, sharpness: input.sharpness };
  }
  return { verdict: "ok", message: null, width: input.width, height: input.height, sharpness: input.sharpness };
}

/** Measures an image file in the browser. Any failure is `unmeasurable`, never a refusal: the check may not block an upload. */
export async function measureImage(file: File): Promise<ReadabilityReport> {
  if (!file.type.startsWith("image/")) return UNMEASURABLE;
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return UNMEASURABLE;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 480 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(8, Math.round(bitmap.width * scale));
    const height = Math.max(8, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) return UNMEASURABLE;
    context.drawImage(bitmap, 0, 0, width, height);
    const report = verdictFor({ width: bitmap.width, height: bitmap.height, sharpness: sharpnessOf(context.getImageData(0, 0, width, height)) });
    bitmap.close();
    return report;
  } catch {
    return UNMEASURABLE;
  }
}

/** A PDF's page count, read from its own object table. Null when it cannot be counted — never a refusal. */
export async function countPdfPages(file: File): Promise<number | null> {
  if (file.type !== "application/pdf") return null;
  try {
    const text = new TextDecoder("latin1").decode(await file.arrayBuffer());
    const counts = [...text.matchAll(/\/Type\s*\/Page[^s]/gu)].length;
    return counts > 0 ? counts : null;
  } catch {
    return null;
  }
}
