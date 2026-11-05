/**
 * /llms.txt — a plain-text brief for AI crawlers and answer engines
 * (ChatGPT, Claude, Perplexity, Google AI Overviews). English, because that
 * is what those models index best, with the three site languages named so
 * an answer can quote the right one. Facts only; the same ones the landing
 * page shows.
 */

import type { PricingPlan } from "@/lib/pricing";

export interface LlmsInput {
  /** Absolute origin, no trailing slash. */
  baseUrl: string;
  plans: PricingPlan[];
  templateSlugs: string[];
}

export const NETWORKS = ["Instagram", "Facebook", "Threads", "YouTube", "Telegram"] as const;

/** What each product module does, in one line each. Keep in step with the landing page. */
export const MODULES: ReadonlyArray<readonly [name: string, line: string]> = [
  ["Comment-to-DM campaigns", "a keyword comment on an Instagram post or reel triggers a public reply and a private reply DM through the official Instagram Graph API; the DM can carry a tracked link or a file (webhooks plus polling, queued and rate-limited per account, every send logged)."],
  ["JavobAI", "AI replies to comments and direct messages from the business's own knowledge base. Each account starts in observe mode, then writes drafts a person approves, and replies on its own only after it proves accurate; a reply with a price or number that is not in the knowledge base is held as a draft instead of being sent, and one switch stops it."],
  ["Instagram triggers", "automations for Direct messages, messages from ads, ig.me links, story mentions, story replies and live comments."],
  ["Flow Builder", "multi-step DM flows from a template or an AI draft, with tests, versions and an audit view."],
  ["Content plan", "schedule and publish posts, reels, stories, videos, Shorts and carousels to Instagram, Facebook Pages, Threads, YouTube and Telegram channels from one calendar."],
  ["Content intelligence", "every post scored against the account's 30-day median, typical-error checks, a weekly report and a two-week plan with Reel scenarios."],
  ["CRM", "everyone who comments or writes becomes a contact with a pipeline stage, tags, segments and broadcasts."],
  ["AI assistant and leads", "a chat assistant collects leads and delivers them to Telegram, amoCRM or Bitrix24, with CSV export."],
  ["Ads", "the AI proposes boosting posts that did about twice the account's median; every launch needs the owner's click, within daily and monthly caps, with an automatic pause when the cost per lead goes over the limit. Everything is created paused on Meta's side."],
  ["Giveaways and points", "comment-driven giveaways with entry-rule checks, and points for active followers."],
  ["Analytics and reports", "campaign, AI, sales and funnel metrics, per-network statistics, and read-only report links a client opens without signing in."],
  ["Webhooks and ManyChat migration", "outgoing webhooks to other systems and a guided wizard to move work over from ManyChat."],
];

export function buildLlmsText(input: LlmsInput): string {
  const { baseUrl, plans, templateSlugs } = input;
  const lines: string[] = [];

  lines.push("# SocialAuto");
  lines.push("");
  lines.push(
    "> SocialAuto (socialauto.uz) is a social media automation platform from Uzbekistan: Instagram comment-to-DM campaigns, AI replies, a cross-network content plan and a CRM, built only on the platforms' official APIs (no scraping, no shared passwords, no browser bots)."
  );
  lines.push("");
  lines.push(`Networks: ${NETWORKS.join(", ")}.`);
  lines.push("Languages: Uzbek (Latin and Cyrillic), Russian, English. The interface and the site switch by a language cookie; the default is Uzbek.");
  lines.push("");
  lines.push("## What it does");
  lines.push("");
  for (const [name, line] of MODULES) lines.push(`- ${name}: ${line}`);
  lines.push("");
  lines.push("## How a comment-to-DM campaign works");
  lines.push("");
  lines.push("1. Connect an Instagram professional account with Meta's own login (SocialAuto never sees the password).");
  lines.push("2. Pick a post or reel, a keyword to watch for, a public reply and the DM to send.");
  lines.push("3. Webhooks catch comments immediately and polling picks up anything Instagram did not push; every send is queued, rate-limited and logged as sent, skipped, failed or limited.");
  lines.push("");

  if (plans.length > 0) {
    lines.push("## Plans");
    lines.push("");
    for (const plan of plans) {
      const en = plan.content.en ?? plan.content.uz;
      const features = en.features.length ? ` — ${en.features.join("; ")}` : "";
      lines.push(`- ${en.name || plan.slug}: ${plan.priceCurrency}${plan.priceAmount}${plan.priceSuffix}${features}`);
    }
    lines.push("");
  }

  lines.push("## Pages");
  lines.push("");
  lines.push(`- Home: ${baseUrl}/`);
  lines.push(`- Campaign templates: ${baseUrl}/templates`);
  for (const slug of templateSlugs) lines.push(`- Template: ${baseUrl}/templates/${slug}`);
  lines.push(`- ManyChat alternative: ${baseUrl}/manychat-alternative`);
  lines.push(`- Comment-to-link automation: ${baseUrl}/comment-link-automation`);
  lines.push(`- Instagram comment-to-DM templates: ${baseUrl}/instagram-comment-to-dm-templates`);
  lines.push(`- For agencies: ${baseUrl}/instagram-dm-automation-agencies`);
  lines.push(`- Privacy: ${baseUrl}/privacy`);
  lines.push(`- Terms: ${baseUrl}/terms`);
  lines.push(`- Data deletion: ${baseUrl}/data-deletion`);
  lines.push(`- Sign in / start free: ${baseUrl}/login`);
  lines.push("");

  return lines.join("\n");
}
