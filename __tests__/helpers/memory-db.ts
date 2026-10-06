/**
 * A small in-memory stand-in for the Prisma client, enough for the lead /
 * assistant / delivery logic under test. It understands equality, `in`, `not`,
 * range operators, `contains`, AND/OR/NOT, compound-unique keys, relation
 * filters (`some` / nested object), `include` and a few write helpers.
 *
 * It is NOT a general Prisma emulator — only what the code under test uses.
 */

type Row = Record<string, unknown> & { id?: string };

type Relation = { model: string; fk: string; kind: "one" | "many"; local?: string };

const RELATIONS: Record<string, Record<string, Relation>> = {
  leadDelivery: {
    integration: { model: "integration", fk: "integrationId", kind: "one" },
    lead: { model: "lead", fk: "leadId", kind: "one" },
  },
  lead: {
    instagramAccount: { model: "instagramAccount", fk: "instagramAccountId", kind: "one" },
    conversation: { model: "conversation", fk: "conversationId", kind: "one" },
    deliveries: { model: "leadDelivery", fk: "leadId", kind: "many" },
  },
  conversation: {
    instagramAccount: { model: "instagramAccount", fk: "instagramAccountId", kind: "one" },
    workspace: { model: "workspace", fk: "workspaceId", kind: "one" },
    messages: { model: "conversationMessage", fk: "conversationId", kind: "many" },
  },
  conversationMessage: {
    conversation: { model: "conversation", fk: "conversationId", kind: "one" },
  },
  integration: {
    telegramChats: { model: "telegramChat", fk: "integrationId", kind: "many" },
  },
  telegramChat: {
    integration: { model: "integration", fk: "integrationId", kind: "one" },
  },
  assistantProfile: {
    products: { model: "assistantProduct", fk: "profileId", kind: "many" },
    faqs: { model: "assistantFaq", fk: "profileId", kind: "many" },
  },
  dmLog: {
    automation: { model: "automation", fk: "automationId", kind: "one" },
  },
  onboardingSession: {},
};

const DEFAULTS: Record<string, () => Row> = {
  lead: () => ({
    status: "NEW", source: "INBOUND_DM", isTest: false, isRepeat: false, repeatCount: 0,
    trackedLinkClicked: false, contactedAt: null, repeatOfId: null, flag: null,
  }),
  leadDelivery: () => ({ status: "PENDING", attempts: 0, nextAttemptAt: null, lastError: null, externalId: null, externalUrl: null, kind: "new", sentAt: null }),
  integration: () => ({ status: "ACTIVE", config: {}, igAccountFilter: [], credentialsEncrypted: null, tokenExpiresAt: null, tokenWarnedAt: null, lastError: null }),
  telegramChat: () => ({ active: true, type: "private", title: null }),
  conversation: () => ({
    assistantState: "NEW", botMessageCount: 0, phoneAskCount: 0, spamStreak: 0, leadCycle: 0,
    operatorActiveUntil: null, botPaused: false, campaignId: null, source: "INBOUND_DM", collected: {},
    lastCustomerMessageAt: null, lastBotMessageAt: null, lastNotifiedAt: null, igUsername: null, igName: null,
  }),
  assistantProfile: () => ({
    enabled: false, approvedAt: null, companyName: "", description: "", pricePolicy: "NEVER", tone: "FRIENDLY",
    personaName: null, extraFieldLabel: null, finalMessageTemplate: null, handleCampaignReplies: true,
    handleInboundDm: false, operatorPauseHours: 24, maxBotMessages: 6, fallbackLeadWithoutPhone: true,
    postHandoffReply: false, workingHours: null, offHoursMessage: null, address: null, delivery: null,
    paymentMethods: [], categories: [], instagramAccountId: null, priceReminderEnabled: true,
  }),
  assistantProduct: () => ({ note: null, price: null, priceIsFrom: false, currency: "UZS", unit: null, priceUpdatedAt: new Date(), sort: 0 }),
  assistantFaq: () => ({ source: "OWNER", sort: 0 }),
  workspace: () => ({ aiConversationsThisPeriod: 0, aiConversationsLimit: null, assistantTemplateOnlyUntil: null }),
  instagramAccount: () => ({ tokenStatus: "ACTIVE", accessToken: "" }),
  knowledgeGap: () => ({ status: "OPEN", hits: 1, examples: [] }),
  onboardingSession: () => ({ step: 0, answers: {}, fsm: {}, status: "ACTIVE", language: "uz", igAccountId: null, reminderSentAt: null }),
  telegramUser: () => ({ language: "uz" }),
  telegramLinkCode: () => ({ usedAt: null, purpose: "link" }),
  workspaceMember: () => ({ role: "OWNER" }),
  automation: () => ({ keywords: [], isActive: true, dmTriggerEnabled: false, handoffToAssistant: false }),
  dmLog: () => ({ status: "SENT", matchedKeyword: null }),
};

let seq = 0;
let tick = 0;
const nextId = (model: string) => `${model}_${++seq}`;

function isOperatorObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !(value instanceof Date) && !Array.isArray(value);
}

export class MemoryDb {
  tables: Record<string, Row[]> = {};
  /** Every row-level write, for assertions. */
  log: Array<{ model: string; op: string }> = [];

  rows(model: string): Row[] {
    return (this.tables[model] ??= []);
  }

  seed(model: string, row: Row): Row {
    const full: Row = { ...(DEFAULTS[model]?.() ?? {}), id: row.id ?? nextId(model), createdAt: new Date(Date.now() + ++tick), updatedAt: new Date(), ...row };
    this.rows(model).push(full);
    return full;
  }

  private related(model: string, row: Row, key: string): unknown {
    const rel = RELATIONS[model]?.[key];
    if (!rel) return undefined;
    if (rel.kind === "one") return this.rows(rel.model).find((r) => r.id === row[rel.fk]) ?? null;
    return this.rows(rel.model).filter((r) => r[rel.fk] === row.id);
  }

  private matchValue(model: string, row: Row, key: string, cond: unknown): boolean {
    // Compound unique: { a_b: { a, b } }
    if (key.includes("_") && isOperatorObject(cond) && !RELATIONS[model]?.[key]) {
      return Object.entries(cond).every(([k, v]) => this.matchValue(model, row, k, v));
    }

    const rel = RELATIONS[model]?.[key];
    if (rel) {
      const value = this.related(model, row, key);
      if (rel.kind === "one") {
        if (cond === null) return value === null;
        return value !== null && this.matches(rel.model, value as Row, cond as Row);
      }
      const list = value as Row[];
      const c = cond as { some?: Row; none?: Row; every?: Row };
      if (c.some) return list.some((r) => this.matches(rel.model, r, c.some!));
      if (c.none) return !list.some((r) => this.matches(rel.model, r, c.none!));
      return true;
    }

    const actual = row[key];
    if (cond === null) return actual === null || actual === undefined;
    if (cond instanceof Date) return actual instanceof Date && actual.getTime() === cond.getTime();
    if (!isOperatorObject(cond)) return actual === cond;

    return Object.entries(cond).every(([op, expected]) => {
      switch (op) {
        case "in": return (expected as unknown[]).includes(actual);
        case "notIn": return !(expected as unknown[]).includes(actual);
        case "not": return expected === null ? actual !== null && actual !== undefined : actual !== expected;
        case "lt": return (actual as Date | number) < (expected as Date | number);
        case "lte": return (actual as Date | number) <= (expected as Date | number);
        case "gt": return (actual as Date | number) > (expected as Date | number);
        case "gte": return (actual as Date | number) >= (expected as Date | number);
        case "contains": return String(actual ?? "").toLowerCase().includes(String(expected).toLowerCase());
        case "has": return Array.isArray(actual) && actual.includes(expected);
        case "mode": return true;
        default: return true;
      }
    });
  }

  matches(model: string, row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([key, cond]) => {
      if (cond === undefined) return true;
      if (key === "AND") return (cond as Row[]).every((w) => this.matches(model, row, w));
      if (key === "OR") return (cond as Row[]).some((w) => this.matches(model, row, w));
      if (key === "NOT") return !(Array.isArray(cond) ? cond : [cond]).some((w) => this.matches(model, row, w as Row));
      return this.matchValue(model, row, key, cond);
    });
  }

  private withInclude(model: string, row: Row, include?: Record<string, unknown>): Row {
    if (!include) return { ...row };
    const out: Row = { ...row };
    for (const [key, spec] of Object.entries(include)) {
      if (!spec) continue;
      if (key === "_count") {
        const select = (spec as { select: Record<string, boolean> }).select;
        out._count = Object.fromEntries(Object.keys(select).map((k) => [k, (this.related(model, row, k) as Row[]).length]));
        continue;
      }
      let value = this.related(model, row, key);
      const nested = isOperatorObject(spec) ? (spec as { where?: Row; orderBy?: unknown; take?: number; include?: Record<string, unknown> }) : null;
      if (Array.isArray(value)) {
        const rel = RELATIONS[model][key];
        if (nested?.where) value = (value as Row[]).filter((r) => this.matches(rel.model, r, nested.where));
        if (nested?.orderBy) value = this.sort(value as Row[], nested.orderBy);
        if (nested?.take !== undefined) value = (value as Row[]).slice(0, nested.take);
        if (nested?.include) value = (value as Row[]).map((r) => this.withInclude(rel.model, r, nested.include));
      } else if (value && nested?.include) {
        value = this.withInclude(RELATIONS[model][key].model, value as Row, nested.include);
      }
      out[key] = value;
    }
    return out;
  }

  private sort(list: Row[], orderBy: unknown): Row[] {
    const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, "asc" | "desc">>;
    return [...list].sort((a, b) => {
      for (const spec of specs) {
        const [field, dir] = Object.entries(spec)[0];
        const x = a[field] as number | Date | string;
        const y = b[field] as number | Date | string;
        if (x === y) continue;
        const cmp = x < y ? -1 : 1;
        return dir === "desc" ? -cmp : cmp;
      }
      return 0;
    });
  }

  /** Relations requested through `select` behave like `include`. */
  private selectAsInclude(model: string, select?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!select) return undefined;
    const entries = Object.entries(select).filter(([key, value]) => RELATIONS[model]?.[key] && value);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }

  model(name: string) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const db = this;
    const find = (args: { where?: Row; orderBy?: unknown; skip?: number; take?: number } = {}) => {
      let list = db.rows(name).filter((r) => db.matches(name, r, args.where));
      if (args.orderBy) list = db.sort(list, args.orderBy);
      if (args.skip) list = list.slice(args.skip);
      if (args.take !== undefined) list = list.slice(0, args.take);
      return list;
    };
    const applyData = (row: Row, data: Row) => {
      for (const [key, value] of Object.entries(data)) {
        if (value === undefined) continue;
        if (isOperatorObject(value) && ("increment" in value || "decrement" in value)) {
          row[key] = (Number(row[key]) || 0) + (Number(value.increment) || 0) - (Number(value.decrement) || 0);
        } else {
          row[key] = value;
        }
      }
      row.updatedAt = new Date();
    };

    return {
      async create({ data, include }: { data: Row; include?: Record<string, unknown> }) {
        db.log.push({ model: name, op: "create" });
        const flat: Row = {};
        for (const [k, v] of Object.entries(data)) if (!RELATIONS[name]?.[k]) flat[k] = v;
        // enforce unique keys the real schema has
        if (name === "lead" && db.rows("lead").some((l) => l.idempotencyKey === flat.idempotencyKey)) throw new Error("Unique constraint failed: idempotencyKey");
        if (name === "conversationMessage" && flat.mid && db.rows(name).some((m) => m.conversationId === flat.conversationId && m.mid === flat.mid)) throw new Error("Unique constraint failed: mid");
        if (name === "leadDelivery" && db.rows(name).some((d) => d.leadId === flat.leadId && d.integrationId === flat.integrationId && (d.kind ?? "new") === (flat.kind ?? "new"))) throw new Error("Unique constraint failed: delivery");
        return db.withInclude(name, db.seed(name, flat), include);
      },
      async createMany({ data }: { data: Row[] }) {
        for (const row of data) db.seed(name, row);
        return { count: data.length };
      },
      async findUnique({ where, include, select }: { where: Row; include?: Record<string, unknown>; select?: Record<string, unknown> }) {
        const row = find({ where })[0];
        return row ? db.withInclude(name, row, include ?? db.selectAsInclude(name, select)) : null;
      },
      async findUniqueOrThrow(args: { where: Row; include?: Record<string, unknown> }) {
        const row = await this.findUnique(args);
        if (!row) throw new Error(`${name} not found`);
        return row;
      },
      async findFirst(args: { where?: Row; orderBy?: unknown; include?: Record<string, unknown>; select?: Record<string, unknown> } = {}) {
        const row = find(args)[0];
        return row ? db.withInclude(name, row, args.include ?? db.selectAsInclude(name, args.select)) : null;
      },
      async findMany(args: { where?: Row; orderBy?: unknown; skip?: number; take?: number; include?: Record<string, unknown>; select?: Record<string, unknown> } = {}) {
        return find(args).map((r) => db.withInclude(name, r, args.include ?? db.selectAsInclude(name, args.select)));
      },
      async count(args: { where?: Row } = {}) {
        return find(args).length;
      },
      async update({ where, data, include }: { where: Row; data: Row; include?: Record<string, unknown> }) {
        db.log.push({ model: name, op: "update" });
        const row = find({ where })[0];
        if (!row) throw new Error(`${name} not found for update`);
        applyData(row, data);
        return db.withInclude(name, row, include);
      },
      async updateMany({ where, data }: { where?: Row; data: Row }) {
        const rows = find({ where });
        rows.forEach((row) => applyData(row, data));
        return { count: rows.length };
      },
      async upsert({ where, create, update }: { where: Row; create: Row; update: Row }) {
        const row = find({ where })[0];
        if (row) {
          applyData(row, update);
          return { ...row };
        }
        return { ...db.seed(name, create) };
      },
      async delete({ where }: { where: Row }) {
        const row = find({ where })[0];
        db.tables[name] = db.rows(name).filter((r) => r !== row);
        return row;
      },
      async deleteMany({ where }: { where?: Row } = {}) {
        const victims = new Set(find({ where }));
        db.tables[name] = db.rows(name).filter((r) => !victims.has(r));
        return { count: victims.size };
      },
      async groupBy({ by, where }: { by: string[]; where?: Row }) {
        const seen = new Map<string, Row>();
        for (const r of find({ where })) seen.set(by.map((k) => r[k]).join("|"), Object.fromEntries(by.map((k) => [k, r[k]])));
        return [...seen.values()];
      },
    };
  }

  client() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const db = this;
    return new Proxy(
      {},
      {
        get(_target, prop: string) {
          if (prop === "$transaction") return async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[]);
          return db.model(prop);
        },
      }
    ) as never;
  }
}

export function resetIds() {
  seq = 0;
}
