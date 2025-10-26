import PdfQueryAssistant from '@/components/PdfQueryAssistant';

export default function Home() {
  return (
    <main className="min-h-screen bg-gradient-to-b from-zinc-100 via-white to-white pb-16 font-sans dark:from-zinc-950 dark:via-zinc-950 dark:to-zinc-950">
      <div className="mx-auto max-w-7xl">
        <PdfQueryAssistant />
      </div>
    </main>
  );
}
