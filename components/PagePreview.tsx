'use client';

import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';

type PagePreviewProps = {
  pdf: PDFDocumentProxy;
  pageNumber: number;
};

const PagePreview = ({ pdf, pageNumber }: PagePreviewProps) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const render = async () => {
      if (!canvasRef.current) {
        return;
      }
      setIsRendering(true);
      setError(null);

      try {
        const page = await pdf.getPage(pageNumber);
        if (cancelled) {
          return;
        }

        const viewport = page.getViewport({ scale: 0.9 });
        const canvas = canvasRef.current;
        const context = canvas.getContext('2d');
        if (!context) {
          setError('Canvas not supported');
          return;
        }

        const outputScale = window.devicePixelRatio || 1;
        canvas.width = viewport.width * outputScale;
        canvas.height = viewport.height * outputScale;
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;

        const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined;

        await page.render({
          canvasContext: context,
          viewport,
          transform,
          canvas,
        }).promise;
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setError('Unable to render this page.');
        }
      } finally {
        if (!cancelled) {
          setIsRendering(false);
        }
      }
    };

    render();

    return () => {
      cancelled = true;
    };
  }, [pdf, pageNumber]);

  if (error) {
    return (
      <div className="flex h-full w-full items-center justify-center text-center text-sm text-red-500">
        {error}
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col items-center gap-2">
      <canvas ref={canvasRef} className="max-h-[520px] max-w-full rounded-md bg-white shadow" />
      {isRendering && (
        <p className="text-xs uppercase tracking-wide text-zinc-500">Rendering page…</p>
      )}
    </div>
  );
};

export default PagePreview;
