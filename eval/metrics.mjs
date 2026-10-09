// Accuracy, F1, Brier score, reliability and automation rate, computed from per-item predictions.

export function accuracy(rows, correct) {
  return rows.length ? rows.filter(correct).length / rows.length : 0;
}

/** Macro F1 across the given labels. */
export function macroF1(pairs, labels) {
  const f1s = labels.map((label) => f1(pairs.map(([y, p]) => [y === label, p === label])));
  return f1s.reduce((a, b) => a + b, 0) / labels.length;
}

/** F1 for the positive class from [truth, predicted] boolean pairs. */
export function f1(pairs) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const [y, p] of pairs) {
    if (y && p) tp++;
    else if (!y && p) fp++;
    else if (y && !p) fn++;
  }
  return tp ? (2 * tp) / (2 * tp + fp + fn) : 0;
}

/** Multi-class Brier score: mean over items of the squared error across every option (0 is perfect, 2 is worst). */
export function brierMulti(rows) {
  const total = rows.reduce((sum, { truth, probabilities }) => {
    let s = 0;
    for (const [label, p] of Object.entries(probabilities)) s += (p - (label === truth ? 1 : 0)) ** 2;
    return sum + s;
  }, 0);
  return rows.length ? total / rows.length : 0;
}

/** Binary Brier score: mean squared error of the yes-probability (0 is perfect, 1 is worst). */
export function brierBinary(rows) {
  const total = rows.reduce((sum, { truth, probability }) => sum + (probability - (truth ? 1 : 0)) ** 2, 0);
  return rows.length ? total / rows.length : 0;
}

export const RELIABILITY_BINS = [
  [0, 0.6],
  [0.6, 0.8],
  [0.8, 0.9],
  [0.9, 0.99],
  [0.99, 1.0001],
];

/** Groups answers by the probability the backend gave its own answer, and compares it with how often it was right. */
export function reliability(rows) {
  return RELIABILITY_BINS.map(([lo, hi]) => {
    const inBin = rows.filter((r) => r.stated >= lo && r.stated < hi);
    const mean = inBin.reduce((s, r) => s + r.stated, 0) / (inBin.length || 1);
    const acc = inBin.filter((r) => r.correct).length / (inBin.length || 1);
    return { lo, hi: Math.min(hi, 1), n: inBin.length, stated: mean, accuracy: acc };
  });
}

export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/**
 * The share of items decided automatically at a threshold (every gating answer at or above it), and the accuracy
 * on that share. Everything else would go to a person. `threshold` is one number, or one per question key.
 */
export function automation(rows, threshold, keys) {
  const limits = typeof threshold === 'number' ? Object.fromEntries(keys.map((k) => [k, threshold])) : threshold;
  const auto = rows.filter((r) => keys.every((k) => r.confidence[k] >= limits[k]));
  const right = auto.filter((r) => keys.every((k) => r.correct[k]));
  return {
    threshold,
    automated: auto.length,
    rate: rows.length ? auto.length / rows.length : 0,
    accuracy: auto.length ? right.length / auto.length : 0,
    wrongLetThrough: auto.length - right.length,
  };
}
