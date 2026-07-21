import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureHarnessRepository } from "../src/core/bootstrap/repository.ts";
import { appendRunEvent, readRunEvents, type RunEvent } from "../src/core/runs/events.ts";
import { runEventsFromStreamEvent } from "../src/core/runs/normalize-events.ts";
import {
  aggregateUsageEvents,
  mergeUsageTotals
} from "../src/core/runs/usage-aggregate.ts";
import { parseUsageFromStreamEvent } from "../src/core/runs/usage-parsers.ts";
import { runEventsFromAcpUpdate } from "../src/runners/acp/events.ts";

function usageEvent(
  partial: Partial<RunEvent> & { usage: NonNullable<RunEvent["usage"]> },
  seq: number
): RunEvent {
  return { seq, at: new Date(seq).toISOString(), type: "usage", ...partial };
}

describe("usage parsers — cursor", () => {
  it("parses codex-shaped stream-json usage through the cursor agent id", () => {
    expect(
      parseUsageFromStreamEvent("cursor", {
        type: "turn.completed",
        usage: { input_tokens: 120, output_tokens: 42, cached_input_tokens: 10 }
      })
    ).toEqual({
      type: "usage",
      usageMode: "cumulative",
      usage: { inputTokens: 120, outputTokens: 42, cachedInputTokens: 10 },
      usageRaw: { input_tokens: 120, output_tokens: 42, cached_input_tokens: 10 }
    });
  });
});

describe("usage parsers — codex", () => {
  it("parses turn.completed usage as cumulative", () => {
    expect(
      parseUsageFromStreamEvent("codex", {
        type: "turn.completed",
        usage: { input_tokens: 120, output_tokens: 42, cached_input_tokens: 10 }
      })
    ).toEqual({
      type: "usage",
      usageMode: "cumulative",
      usage: { inputTokens: 120, outputTokens: 42, cachedInputTokens: 10 },
      usageRaw: { input_tokens: 120, output_tokens: 42, cached_input_tokens: 10 }
    });
  });

  it("parses token_count items", () => {
    expect(
      parseUsageFromStreamEvent("codex", {
        type: "item.completed",
        item: { id: "item_2", type: "token_count", input_tokens: 10, output_tokens: 20 }
      })
    ).toMatchObject({
      type: "usage",
      usageMode: "cumulative",
      usage: { inputTokens: 10, outputTokens: 20 }
    });
  });
});

describe("usage parsers — claude", () => {
  it("parses result usage with cache and reasoning fields", () => {
    expect(
      parseUsageFromStreamEvent("claude", {
        type: "result",
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 12,
          cache_creation_input_tokens: 8,
          reasoning_tokens: 30
        }
      })
    ).toEqual({
      type: "usage",
      usageMode: "cumulative",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 12,
        cacheWriteTokens: 8,
        reasoningTokens: 30
      },
      usageRaw: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 12,
        cache_creation_input_tokens: 8,
        reasoning_tokens: 30
      }
    });
  });

  it("parses streaming message_delta usage as cumulative", () => {
    expect(
      parseUsageFromStreamEvent("claude", {
        type: "message_delta",
        usage: { input_tokens: 5, output_tokens: 2 }
      })
    ).toMatchObject({
      usageMode: "cumulative",
      usage: { inputTokens: 5, outputTokens: 2 }
    });
  });

  it("parses api_retry as cumulative retry count", () => {
    expect(
      parseUsageFromStreamEvent("claude", {
        type: "system",
        subtype: "api_retry",
        attempt: 3,
        max_retries: 10
      })
    ).toEqual({
      type: "usage",
      usageMode: "cumulative",
      usage: { retries: 2 },
      usageRaw: { attempt: 3, max_retries: 10 }
    });
  });
});

describe("usage parsers — grok", () => {
  it("parses result usage when present", () => {
    expect(
      parseUsageFromStreamEvent("grok", {
        type: "result",
        usage: { prompt_tokens: 11, completion_tokens: 7 }
      })
    ).toMatchObject({
      usage: { inputTokens: 11, outputTokens: 7 }
    });
  });
});

describe("usage parsers — opencode", () => {
  it("reuses claude-style result usage", () => {
    expect(
      parseUsageFromStreamEvent("opencode", {
        type: "result",
        usage: { input_tokens: 3, output_tokens: 4 }
      })
    ).toMatchObject({
      usage: { inputTokens: 3, outputTokens: 4 }
    });
  });
});

describe("usage parsers — kiro/acp", () => {
  it("records retry attempts from retry_warning without inventing tokens", () => {
    expect(
      runEventsFromAcpUpdate({
        sessionUpdate: "retry_warning",
        attempt: 3,
        maxAttempts: 3,
        message: "Retrying"
      })
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "usage",
          usageMode: "cumulative",
          usage: { retries: 2 }
        })
      ])
    );
  });
});

describe("usage parsers — direct provider", () => {
  it("parses a top-level usage object on generic stream lines", () => {
    expect(
      parseUsageFromStreamEvent("custom-openai", {
        type: "usage",
        usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 }
      })
    ).toMatchObject({
      usageMode: "delta",
      usage: { inputTokens: 9, outputTokens: 6 }
    });
  });
});

describe("usage parsers — malformed and absent", () => {
  it("returns null for events without usage evidence", () => {
    expect(parseUsageFromStreamEvent("codex", { type: "turn.started" })).toBeNull();
    expect(parseUsageFromStreamEvent("claude", { type: "assistant", message: { content: [] } })).toBeNull();
  });

  it("drops malformed fields but keeps valid ones", () => {
    expect(
      parseUsageFromStreamEvent("codex", {
        type: "turn.completed",
        usage: { input_tokens: "nope", output_tokens: 20, reasoning_tokens: -1 }
      })
    ).toMatchObject({
      usage: { outputTokens: 20 }
    });
    expect(
      parseUsageFromStreamEvent("codex", {
        type: "turn.completed",
        usage: { input_tokens: "nope", output_tokens: "bad" }
      })
    ).toBeNull();
  });

  it("never invents zero for missing metrics", () => {
    const parsed = parseUsageFromStreamEvent("codex", {
      type: "turn.completed",
      usage: { output_tokens: 42 }
    });
    expect(parsed?.usage).toEqual({ outputTokens: 42 });
    expect(parsed?.usage).not.toHaveProperty("inputTokens");
  });
});

describe("usage aggregation", () => {
  it("sums incremental deltas", () => {
    const total = aggregateUsageEvents([
      usageEvent({ usageMode: "delta", usage: { inputTokens: 10, outputTokens: 5 } }, 1),
      usageEvent({ usageMode: "delta", usage: { inputTokens: 3, outputTokens: 2 } }, 2)
    ]);
    expect(total).toEqual({ inputTokens: 13, outputTokens: 7 });
  });

  it("counts streaming cumulative usage exactly once", () => {
    const total = aggregateUsageEvents([
      usageEvent({ usageMode: "cumulative", usage: { inputTokens: 100, outputTokens: 10 } }, 1),
      usageEvent({ usageMode: "cumulative", usage: { inputTokens: 120, outputTokens: 25 } }, 2),
      usageEvent({ usageMode: "cumulative", usage: { inputTokens: 120, outputTokens: 25 } }, 3)
    ]);
    expect(total).toEqual({ inputTokens: 120, outputTokens: 25 });
  });

  it("counts counter resets across multiple provider responses", () => {
    const events = [
      usageEvent({ usageMode: "cumulative", usage: { inputTokens: 100, outputTokens: 10 } }, 1),
      usageEvent({ usageMode: "cumulative", usage: { inputTokens: 20, outputTokens: 5 } }, 2),
      usageEvent({ usageMode: "cumulative", usage: { inputTokens: 50, outputTokens: 8 } }, 3)
    ];
    expect(aggregateUsageEvents(events)).toEqual({ inputTokens: 150, outputTokens: 18 });
  });

  it("diffs three or more strictly increasing cumulative snapshots", () => {
    const total = aggregateUsageEvents([
      usageEvent({ usageMode: "cumulative", usage: { inputTokens: 100, outputTokens: 10 } }, 1),
      usageEvent({ usageMode: "cumulative", usage: { inputTokens: 120, outputTokens: 25 } }, 2),
      usageEvent({ usageMode: "cumulative", usage: { inputTokens: 150, outputTokens: 40 } }, 3)
    ]);
    expect(total).toEqual({ inputTokens: 150, outputTokens: 40 });
  });

  it("counts multiple retry notifications without over-counting", () => {
    const retryAtAttempt = (attempt: number, seq: number) =>
      usageEvent(
        {
          usageMode: "cumulative",
          usage: { retries: attempt - 1 },
          usageRaw: { attempt }
        },
        seq
      );

    const total = aggregateUsageEvents([retryAtAttempt(2, 1), retryAtAttempt(3, 2)]);
    expect(total).toEqual({ retries: 2 });
  });

  it("ignores absent metrics without coercing to zero", () => {
    const total = aggregateUsageEvents([
      usageEvent({ usageMode: "delta", usage: { outputTokens: 5 } }, 1),
      usageEvent({ usageMode: "delta", usage: { inputTokens: 4 } }, 2)
    ]);
    expect(total).toEqual({ inputTokens: 4, outputTokens: 5 });
  });

  it("treats duplicated identical cumulative snapshots as one contribution", () => {
    const event = usageEvent(
      { usageMode: "cumulative", usage: { inputTokens: 50, outputTokens: 10 } },
      1
    );
    expect(aggregateUsageEvents([event, event])).toEqual({ inputTokens: 50, outputTokens: 10 });
  });

  it("skips malformed usage events during aggregation", () => {
    const total = aggregateUsageEvents([
      usageEvent({ usageMode: "delta", usage: { inputTokens: 5 } }, 1),
      { seq: 2, at: "t", type: "usage", usage: { inputTokens: Number.NaN } },
      usageEvent({ usageMode: "delta", usage: { outputTokens: 2 } }, 3)
    ]);
    expect(total).toEqual({ inputTokens: 5, outputTokens: 2 });
  });
});

describe("mergeUsageTotals", () => {
  it("adds only present fields", () => {
    expect(mergeUsageTotals({ inputTokens: 1 }, { outputTokens: 2 })).toEqual({
      inputTokens: 1,
      outputTokens: 2
    });
  });
});

describe("stream normalizer integration", () => {
  it("emits usage events alongside transcript events", () => {
    const events = runEventsFromStreamEvent("codex", {
      type: "turn.completed",
      usage: { input_tokens: 1, output_tokens: 2 }
    });
    expect(events.some((event) => event.type === "usage")).toBe(true);
  });
});

describe("usage event persistence", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "harness-run-usage-"));
    await ensureHarnessRepository(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips usage events through events.ndjson", async () => {
    await appendRunEvent(root, "run-1", {
      type: "usage",
      usageMode: "cumulative",
      usage: { inputTokens: 9, outputTokens: 3 },
      usageRaw: { input_tokens: 9, output_tokens: 3 }
    });
    const events = await readRunEvents(root, "run-1");
    expect(events[0]).toMatchObject({
      type: "usage",
      usage: { inputTokens: 9, outputTokens: 3 }
    });
  });
});
