interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 bg-zinc-900/80 px-6 py-4">
        <h1 className="text-xl font-semibold tracking-tight">
          WhiteNoise vs Vanilla MCP
        </h1>
        <p className="mt-1 text-sm text-zinc-400">
          Live benchmark: context, latency, round-trips, tokens
        </p>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">
        {children}
      </main>
    </div>
  );
}
