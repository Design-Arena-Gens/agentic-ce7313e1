'use client';

import { env, pipeline } from '@xenova/transformers';

type EmbeddingArray = Float32Array | number[];

let embedderPromise:
  | null
  | Promise<
      (
        input: string,
        config?: Record<string, unknown>
      ) => Promise<{ data: EmbeddingArray }>
    > = null;

env.allowLocalModels = false;
env.backends.onnx.wasm.proxy = true;

export async function getEmbedder() {
  if (!embedderPromise) {
    embedderPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      quantized: true,
    }).then((emb) => {
      return async (text: string) => {
        const result = await emb(text, {
          pooling: 'mean',
          normalize: true,
        });
        return { data: result.data as EmbeddingArray };
      };
    });
  }
  return embedderPromise;
}

export async function embedText(text: string) {
  const embedder = await getEmbedder();
  const { data } = await embedder(text);
  return Array.from(data);
}

export async function embedBatch(texts: string[]) {
  const embedder = await getEmbedder();
  const embeddings: number[][] = [];
  for (const text of texts) {
    const { data } = await embedder(text);
    embeddings.push(Array.from(data));
  }
  return embeddings;
}
