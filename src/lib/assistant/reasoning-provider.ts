import "server-only";

import type { Locale } from "@/i18n/config";
import { isServiceRoleConfigured, serviceInsert } from "@/lib/supabase-rpc";
import { detectLanguage } from "./language";
import { classifyIntent } from "./retrieval";
import type { AssistantIntent, KnowledgeArticle } from "./types";

export type ConversationContext = {
  locale: Locale;
  message: string;
  intent?: AssistantIntent;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  approvedKnowledge?: KnowledgeArticle[];
  conversationId?: string | null;
};

export type IntentResult = { intent: AssistantIntent; confidence: number };

export interface ReasoningProvider {
  readonly name: string;
  detectLanguage(input: string): Promise<string>;
  classifyIntent(input: string, context: ConversationContext): Promise<IntentResult>;
  rewriteSearchQuery(input: string, context: ConversationContext): Promise<string[]>;
  generateClarifyingQuestion(context: ConversationContext): Promise<string | null>;
  generateSuggestedQuestions(context: ConversationContext): Promise<string[]>;
  summarizeKnowledge(entries: KnowledgeArticle[], context: ConversationContext): Promise<string>;
}

const SYNONYMS: Array<[RegExp, string]> = [
  [/\b(bedsheets?|bed linen|sheets?)\b/giu, "linen change replacement bedding"],
  [/\b(key|keys)\b/giu, "property access physical key digital lock"],
  [/\b(first clean|first cleaning|first visit)\b/giu, "initial home assessment first paid cleaning onboarding"],
  [/\b(yearly|per year)\b/giu, "annual billing subscription"],
  [/\b(cancel|stop)\b/giu, "cancellation termination subscription booking"],
  [/\b(price|cost|how much)\b/giu, "pricing estimate property size frequency"],
  [/\b(window|windows)\b/giu, "interior exterior window cleaning"],
];

function normalizeQuery(value: string): string {
  return value.toLocaleLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}%€]+/gu, " ").replace(/\s+/g, " ").trim();
}

function correctCommonSpelling(value: string): string {
  return value
    .replace(/\b(?:clening|cleanig|cleanning)\b/giu, "cleaning")
    .replace(/\b(?:bedshet|bedshets|bedsheetes)\b/giu, "bedsheets")
    .replace(/\b(?:subscrption|subcription)\b/giu, "subscription")
    .replace(/\b(?:assestment|assesment)\b/giu, "assessment")
    .replace(/\bprce\b/giu, "price")
    .replace(/\bwindoows\b/giu, "windows");
}

/** Removes identifiers and sensitive operational data before optional reasoning calls. */
export function redactForReasoning(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[email]")
    .replace(/https?:\/\/\S+/giu, "[url]")
    .replace(/\bDTH-[A-Z0-9-]{4,}\b/giu, "[booking-reference]")
    .replace(/\b(?:\+|00)?\d[\d\s().-]{7,}\d\b/g, "[phone-or-number]")
    .replace(/\b(?:access|door|alarm|lock)\s*(?:code|pin)\s*[:#-]?\s*\S+/giu, "[access-code]")
    .replace(/\b(?:address|adres|adresse|direcci[óo]n|morada|العنوان)\s*[:#-]?\s*[^\n,.!?]{5,120}/giu, "[address]")
    .slice(0, 1600);
}

function deterministicRewrites(input: string): string[] {
  const normalized = normalizeQuery(input);
  const corrected = correctCommonSpelling(normalized);
  const expanded = SYNONYMS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), corrected);
  return [...new Set([input.trim(), normalized, corrected, expanded].filter((value) => value.length > 1))].slice(0, 5);
}

class DeterministicReasoningProvider implements ReasoningProvider {
  readonly name: string = "deterministic";

  async detectLanguage(input: string) { return detectLanguage(input).locale || "undetermined"; }
  async classifyIntent(input: string, _context: ConversationContext) { return { intent: classifyIntent(input), confidence: 0.82 }; }
  async rewriteSearchQuery(input: string, _context: ConversationContext) { return deterministicRewrites(input); }
  async generateClarifyingQuestion(_context: ConversationContext): Promise<string | null> { return null; }
  async generateSuggestedQuestions(_context: ConversationContext): Promise<string[]> { return []; }
  async summarizeKnowledge(entries: KnowledgeArticle[], _context: ConversationContext) {
    return entries.map((entry) => `${entry.title}: ${entry.summary || entry.content}`).join("\n\n").slice(0, 4000);
  }
}

type GrokJson = { queries?: unknown; question?: unknown; suggestions?: unknown; summary?: unknown };
let circuitOpenUntil = 0;
let recentCalls: number[] = [];

function grokConfigured(): boolean {
  return process.env.GROK_ENABLED === "true" && Boolean(process.env.GROK_API_KEY && process.env.GROK_MODEL);
}

async function logProviderEvent(input: {
  context: ConversationContext;
  operation: string;
  success: boolean;
  latencyMs: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  failureCode?: string;
}) {
  if (!isServiceRoleConfigured()) return;
  await serviceInsert("assistant_provider_events", {
    conversation_id: input.context.conversationId || null,
    provider: "grok",
    operation: input.operation,
    model: process.env.GROK_MODEL || null,
    success: input.success,
    latency_ms: input.latencyMs,
    prompt_tokens: input.usage?.prompt_tokens || null,
    completion_tokens: input.usage?.completion_tokens || null,
    total_tokens: input.usage?.total_tokens || null,
    failure_code: input.failureCode || null,
    metadata: { content_logged: false },
  }).catch(() => undefined);
}

async function callGrok(operation: string, prompt: string, context: ConversationContext): Promise<GrokJson | null> {
  if (!grokConfigured() || Date.now() < circuitOpenUntil) return null;
  const now = Date.now();
  recentCalls = recentCalls.filter((timestamp) => now - timestamp < 60_000);
  const limit = Math.max(1, Number(process.env.GROK_RATE_LIMIT_PER_MINUTE || 20));
  if (recentCalls.length >= limit) return null;
  recentCalls.push(now);
  const started = Date.now();
  const timeoutMs = Math.min(15_000, Math.max(1000, Number(process.env.GROK_TIMEOUT_MS || 6000)));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.GROK_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: process.env.GROK_MODEL,
          temperature: 0,
          max_tokens: Math.min(500, Number(process.env.GROK_MAX_TOKENS || 350)),
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: "You are a retrieval assistant. Never create Dar Tahara facts, policies, prices, promises, legal terms, service inclusions, cities, discounts, or availability. Work only on wording, grouping, and summarization of supplied approved text. Return JSON only." },
            { role: "user", content: prompt },
          ],
        }),
        cache: "no-store",
        signal: controller.signal,
      });
      const usageData = response.ok ? await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      } : null;
      if (!response.ok || !usageData) {
        if ((response.status === 429 || response.status >= 500) && attempt === 0) continue;
        circuitOpenUntil = Date.now() + 60_000;
        await logProviderEvent({ context, operation, success: false, latencyMs: Date.now() - started, failureCode: `http_${response.status}` });
        return null;
      }
      const content = usageData.choices?.[0]?.message?.content;
      const parsed = content ? JSON.parse(content) as GrokJson : null;
      await logProviderEvent({ context, operation, success: Boolean(parsed), latencyMs: Date.now() - started, usage: usageData.usage });
      return parsed;
    } catch (error) {
      if (attempt === 0) continue;
      circuitOpenUntil = Date.now() + 60_000;
      await logProviderEvent({ context, operation, success: false, latencyMs: Date.now() - started, failureCode: error instanceof Error && error.name === "AbortError" ? "timeout" : "provider_error" });
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
  return null;
}

class GrokReasoningProvider extends DeterministicReasoningProvider {
  override readonly name = "grok";

  override async rewriteSearchQuery(input: string, context: ConversationContext): Promise<string[]> {
    const fallback = deterministicRewrites(input);
    const result = await callGrok("rewrite_search_query", `Language: ${context.locale}\nRewrite this redacted customer question into at most 3 short retrieval queries. Preserve intent and do not answer it.\nQuestion: ${redactForReasoning(input)}\nReturn {"queries":[...]}.`, context);
    const queries = Array.isArray(result?.queries) ? result.queries.filter((item): item is string => typeof item === "string") : [];
    return [...new Set([...fallback, ...queries.map(normalizeQuery)])].filter(Boolean).slice(0, 6);
  }

  override async generateClarifyingQuestion(context: ConversationContext): Promise<string | null> {
    const result = await callGrok("generate_clarification", `Language: ${context.locale}\nWrite one concise clarification question about this redacted request. Do not state or assume any Dar Tahara policy.\nRequest: ${redactForReasoning(context.message)}\nReturn {"question":"..."}.`, context);
    return typeof result?.question === "string" ? result.question.slice(0, 300) : null;
  }

  override async generateSuggestedQuestions(context: ConversationContext): Promise<string[]> {
    const titles = (context.approvedKnowledge || []).map((item) => item.title).slice(0, 6).join(", ");
    const result = await callGrok("generate_suggestions", `Language: ${context.locale}\nCreate 3 concise follow-up questions answerable only from these approved knowledge titles: ${titles || "none"}. Return {"suggestions":[...]}.`, context);
    return Array.isArray(result?.suggestions)
      ? result.suggestions.filter((item): item is string => typeof item === "string").map((item) => item.slice(0, 180)).slice(0, 5)
      : [];
  }

  override async summarizeKnowledge(entries: KnowledgeArticle[], context: ConversationContext): Promise<string> {
    const approved = entries.map((entry) => `${entry.id}: ${entry.content}`).join("\n\n").slice(0, 8000);
    const result = await callGrok("summarize_knowledge", `Language: ${context.locale}\nSummarize only the approved facts below without adding conditions or conclusions. Return {"summary":"..."}.\n${approved}`, context);
    return typeof result?.summary === "string" ? result.summary.slice(0, 4000) : super.summarizeKnowledge(entries, context);
  }
}

const deterministicProvider = new DeterministicReasoningProvider();
const grokProvider = new GrokReasoningProvider();

export function getReasoningProvider(): ReasoningProvider {
  return grokConfigured() ? grokProvider : deterministicProvider;
}
