// Edit size: the share of words changed between the model's draft and the saved text, 0 to 1.
// Only this number is kept. The words themselves are never stored.

const words = (s) => String(s).trim().split(/\s+/).filter(Boolean);

export function editRatio(original, edited) {
  const a = words(original);
  const b = words(edited);
  const n = Math.max(a.length, b.length);
  if (n === 0) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return Math.min(1, prev[b.length] / n);
}
