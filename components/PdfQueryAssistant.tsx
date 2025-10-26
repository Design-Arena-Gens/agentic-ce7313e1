'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import clsx from 'clsx';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { embedBatch, embedText } from '@/lib/embedder';
import { cosineSimilarity } from '@/lib/vector';
import PagePreview from './PagePreview';

let pdfjsLibPromise: Promise<typeof import('pdfjs-dist')> | null = null;

async function ensurePdfjs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import('pdfjs-dist');
  }
  const pdfjsLib = await pdfjsLibPromise;
  if (typeof window !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
  }
  return pdfjsLib;
}

type Snippet = {
  id: string;
  page: number;
  text: string;
  embedding: number[];
  start: number;
  end: number;
  score?: number;
};

const CHUNK_SIZE = 700;
const CHUNK_OVERLAP = 150;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const highlightMatches = (text: string, query: string) => {
  const keywords = Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 2)
    )
  );

  if (!keywords.length) {
    return <span>{text}</span>;
  }

  const pattern = new RegExp(keywords.map(escapeRegExp).join('|'), 'gi');
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > lastIndex) {
      parts.push(text.slice(lastIndex, matchIndex));
    }
    parts.push(
      <mark key={`${matchIndex}-${match[0]}`} className="rounded bg-yellow-200 px-1 py-0.5">
        {text.slice(matchIndex, matchIndex + match[0].length)}
      </mark>
    );
    lastIndex = matchIndex + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return <span>{parts}</span>;
};

async function readPdf(buffer: ArrayBuffer) {
  const pdfjsLib = await ensurePdfjs();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  return pdf;
}

const buildChunks = (text: string, page: number): Omit<Snippet, 'embedding'>[] => {
  const cleaned = text.replace(/\u0000/g, '');
  const chunks: Omit<Snippet, 'embedding'>[] = [];
  let start = 0;
  while (start < cleaned.length) {
    const end = Math.min(start + CHUNK_SIZE, cleaned.length);
    const segment = cleaned.slice(start, end);
    const normalizedSegment = segment.trim();
    if (normalizedSegment.length > 0) {
      chunks.push({
        id: `${page}-${start}`,
        page,
        text: normalizedSegment,
        start,
        end,
      });
    }
    if (end === cleaned.length) {
      break;
    }
    start = end - CHUNK_OVERLAP;
    if (start < 0) {
      start = 0;
    }
  }
  return chunks;
};

const PdfQueryAssistant = () => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [question, setQuestion] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isQuerying, setIsQuerying] = useState(false);
  const [results, setResults] = useState<Snippet[]>([]);
  const [selectedSnippet, setSelectedSnippet] = useState<Snippet | null>(null);
  const [progress, setProgress] = useState(0);

  const resetState = useCallback(() => {
    setSnippets([]);
    setResults([]);
    setSelectedSnippet(null);
    setQuestion('');
    setProgress(0);
  }, []);

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }
      event.target.value = '';

      resetState();
      setStatus('Loading PDF...');
      setIsProcessing(true);
      setFileName(file.name);

      try {
        const buffer = await file.arrayBuffer();
        if (pdfDocument) {
          pdfDocument.destroy();
        }
        const pdf = await readPdf(buffer);
        setPdfDocument(pdf);

        const localSnippets: Snippet[] = [];
        const totalPages = pdf.numPages;

        for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
          setStatus(`Extracting page ${pageNumber} of ${totalPages}...`);
          const page = await pdf.getPage(pageNumber);
          const textContent = await page.getTextContent();

          const pageText = textContent.items
            .map((item) => {
              if ('str' in item) {
                const suffix = (item as { hasEOL?: boolean }).hasEOL ? '\n' : ' ';
                return `${item.str}${suffix}`;
              }
              return '';
            })
            .join('')
            .replace(/\s+\n/g, '\n')
            .replace(/\n\s+/g, '\n')
            .replace(/[ \t]+/g, ' ')
            .trim();

          const pageChunks = buildChunks(pageText, pageNumber);
          if (pageChunks.length === 0) {
            setProgress(pageNumber / totalPages);
            continue;
          }

          setStatus(`Embedding page ${pageNumber} of ${totalPages}...`);
          const embeddings = await embedBatch(pageChunks.map((chunk) => chunk.text));

          embeddings.forEach((embedding, index) => {
            const chunk = pageChunks[index];
            localSnippets.push({
              ...chunk,
              embedding,
            });
          });

          setProgress(pageNumber / totalPages);
        }

        setSnippets(localSnippets);
        setStatus('Document ready. Ask a question to search.');
      } catch (error) {
        console.error(error);
        setStatus('Something went wrong while processing the PDF.');
      } finally {
        setIsProcessing(false);
      }
    },
    [pdfDocument, resetState]
  );

  const handleQuery = useCallback(
    async (event?: React.FormEvent) => {
      event?.preventDefault();
      if (!question.trim() || !snippets.length) {
        return;
      }

      setIsQuerying(true);
      setStatus('Finding the best matching passages...');

      try {
        const questionEmbedding = await embedText(question.trim());
        const scored = snippets
          .map((snippet) => ({
            ...snippet,
            score: cosineSimilarity(questionEmbedding, snippet.embedding),
          }))
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
          .slice(0, 5);

        setResults(scored);
        setSelectedSnippet(scored[0] ?? null);
        setStatus(
          scored.length
            ? 'Showing the most relevant excerpts.'
            : 'No matching content found for that question.'
        );
      } catch (error) {
        console.error(error);
        setStatus('Unable to search the document right now.');
      } finally {
        setIsQuerying(false);
      }
    },
    [question, snippets]
  );

  useEffect(() => {
    if (!question) {
      setResults([]);
      setSelectedSnippet(null);
    }
  }, [question]);

  const hasDocument = useMemo(() => snippets.length > 0, [snippets.length]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-4 pb-20 pt-10 lg:px-8">
      <header className="flex flex-col gap-3 border-b border-zinc-200 pb-6 dark:border-zinc-800">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              AI-Powered Contextual PDF Query Assistant
            </h1>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Upload dense PDFs, ask questions in natural language, and retrieve verbatim answers
              anchored to the source page.
            </p>
          </div>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-900 shadow-sm transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
          >
            Upload PDF
          </button>
        </div>
        {fileName && (
          <div className="rounded-md border border-dashed border-zinc-300 bg-zinc-50 px-4 py-3 text-sm text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900/40 dark:text-zinc-300">
            <p className="font-medium text-zinc-800 dark:text-zinc-100">{fileName}</p>
            <p>
              Pages processed:{' '}
              <span className="font-medium text-zinc-900 dark:text-zinc-200">
                {snippets.length ? Math.max(...snippets.map((snippet) => snippet.page)) : 0}
              </span>
            </p>
            <p>{status}</p>
            {isProcessing && (
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                <div
                  className="h-full rounded-full bg-blue-500 transition-all"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              </div>
            )}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={handleFileChange}
        />
      </header>

      <section
        className={clsx(
          'grid gap-6 transition-opacity duration-300 md:grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]',
          !hasDocument && 'pointer-events-none opacity-50'
        )}
      >
        <div className="flex flex-col gap-6">
          <form onSubmit={handleQuery} className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <label htmlFor="question" className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">
              Ask a question about your document
            </label>
            <div className="mt-3 flex flex-col gap-3 md:flex-row">
              <textarea
                id="question"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder={hasDocument ? 'E.g. What theorem is used to derive the variance on page 12?' : 'Upload a PDF to begin.'}
                rows={4}
                disabled={!hasDocument || isProcessing}
                className="w-full resize-none rounded-lg border border-zinc-300 bg-white px-4 py-3 text-sm text-zinc-900 shadow-sm transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-blue-400 dark:focus:ring-blue-400/30 dark:disabled:bg-zinc-900/80"
              />
              <button
                type="submit"
                disabled={!hasDocument || isProcessing || isQuerying || !question.trim()}
                className="rounded-lg bg-blue-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-blue-300"
              >
                {isQuerying ? 'Searching…' : 'Search'}
              </button>
            </div>
            {status && (
              <p className="mt-3 text-sm text-blue-600 dark:text-blue-400">{status}</p>
            )}
          </form>

          <div className="rounded-2xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
            <div className="border-b border-zinc-200 px-6 py-4 dark:border-zinc-800">
              <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Exact matches</h2>
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                Responses are verbatim excerpts. Click a result to preview the page context.
              </p>
            </div>
            <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {results.length === 0 && (
                <div className="px-6 py-12 text-center text-sm text-zinc-500 dark:text-zinc-400">
                  {hasDocument
                    ? 'Run a search to surface precise passages from your document.'
                    : 'Upload a PDF to enable contextual search.'}
                </div>
              )}
              {results.map((snippet) => (
                <button
                  key={snippet.id}
                  type="button"
                  onClick={() => setSelectedSnippet(snippet)}
                  className={clsx(
                    'flex w-full flex-col gap-2 px-6 py-4 text-left transition hover:bg-blue-50/60 dark:hover:bg-blue-500/10',
                    selectedSnippet?.id === snippet.id && 'bg-blue-50/80 dark:bg-blue-500/10'
                  )}
                >
                  <div className="flex items-center justify-between text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    <span>Page {snippet.page}</span>
                    {typeof snippet.score === 'number' && (
                      <span>Relevance {(snippet.score * 100).toFixed(1)}%</span>
                    )}
                  </div>
                  <p className="text-sm leading-relaxed text-zinc-800 dark:text-zinc-100">
                    {highlightMatches(snippet.text, question)}
                  </p>
                </button>
              ))}
            </div>
          </div>
        </div>

        <aside className="flex flex-col gap-4 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div>
            <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Page preview</h3>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Visual reference of the selected passage.
            </p>
          </div>
          <div className="flex h-full min-h-[420px] items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-950">
            {selectedSnippet && pdfDocument ? (
              <PagePreview pdf={pdfDocument} pageNumber={selectedSnippet.page} />
            ) : (
              <p className="px-4 text-center text-sm text-zinc-500 dark:text-zinc-400">
                Select a search result to see the original page context.
              </p>
            )}
          </div>

          {selectedSnippet && (
            <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-700 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
              <p>
                <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                  Exact location:
                </span>{' '}
                Page {selectedSnippet.page}, characters {selectedSnippet.start} –{' '}
                {selectedSnippet.end}
              </p>
            </div>
          )}
        </aside>
      </section>
    </div>
  );
};

export default PdfQueryAssistant;
