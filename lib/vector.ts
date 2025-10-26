export function cosineSimilarity(a: number[], b: number[]) {
  if (a.length !== b.length) {
    throw new Error('Vectors must be the same length');
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const ai = a[i];
    const bi = b[i];
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / Math.sqrt(normA * normB);
}
