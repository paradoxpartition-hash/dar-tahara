import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/brand/logo";

export function AuthShell({ title, intro, children }: { title: string; intro?: string; children: ReactNode }) {
  return <main className="wash flex min-h-screen items-center justify-center p-6"><section className="w-full max-w-md rounded-[2rem] border border-border bg-card p-7 shadow-lift sm:p-9"><Link href="/" className="inline-flex"><Logo variant="wordmark" /></Link><h1 className="mt-8 font-serif text-3xl text-foreground">{title}</h1>{intro?<p className="mt-2 text-sm leading-relaxed text-muted-foreground">{intro}</p>:null}{children}</section></main>;
}
