import type { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

// A git install builds without devDependencies, so only the app entry, which bb provides, resolves at runtime.
const defineContract = ((contract: unknown) => contract) as typeof defineRpcContract;

const summarySchema = z.object({ running: z.number(), stalled: z.number(), total: z.number() });
export type Summary = z.infer<typeof summarySchema>;

const messageSchema = z.object({ sentAt: z.string().nullable(), text: z.string() });

const cardSchema = z.object({
  id: z.string(),
  title: z.string(),
  state: z.enum(["running", "finished", "stalled"]),
  source: z.enum(["transcript", "delegation"]),
  launchedAt: z.number().nullable(),
  lastStepAt: z.number().nullable(),
  prompt: messageSchema.nullable(),
  followUps: z.array(messageSchema),
  lastSteps: z.array(z.string()),
  report: z.string().nullable(),
});
export type Card = z.infer<typeof cardSchema>;

export const contract = defineContract({
  summaries: {
    input: z.object({ keys: z.array(z.string()).max(500) }),
    output: z.record(z.string(), summarySchema),
  },
  detail: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ cards: z.array(cardSchema), transcripts: z.boolean() }),
  },
});
