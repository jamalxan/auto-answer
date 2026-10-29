/**
 * A small in-memory stand-in for the Prisma client, enough for the lead /
 * assistant / delivery logic under test. It understands equality, `in`, `not`,
 * range operators, `contains`, AND/OR/NOT, compound-unique keys, relation
 * filters (`some` / nested object), `include` and a few write helpers.
 *
 * It is NOT a general Prisma emulator — only what the code under test uses.
 */

type Row = Record<string, unknown> & { id?: string };

/** `inverse`: a 1:1 whose foreign key sits on the other model (conversation.aiState → aiConversationState.conversationId). */
type Relation = { model: string; fk: string; kind: "one" | "many"; local?: string; inverse?: boolean };

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
    aiState: { model: "aiConversationState", fk: "conversationId", kind: "one", inverse: true },
    aiHandoffs: { model: "aiHandoff", fk: "conversationId", kind: "many" },
  },
  conversationMessage: {
    conversation: { model: "conversation", fk: "conversationId", kind: "one" },
  },
  workspace: {
    owner: { model: "user", fk: "ownerId", kind: "one" },
    members: { model: "workspaceMember", fk: "workspaceId", kind: "many" },
  },
  workspaceMember: {
    user: { model: "user", fk: "userId", kind: "one" },
    workspace: { model: "workspace", fk: "workspaceId", kind: "one" },
  },
  telegramUser: {
    user: { model: "user", fk: "userId", kind: "one" },
  },
  integration: {
    telegramChats: { model: "telegramChat", fk: "integrationId", kind: "many" },
    subscriptions: { model: "integrationSubscription", fk: "integrationId", kind: "many" },
    outboundDeliveries: { model: "outboundDelivery", fk: "integrationId", kind: "many" },
  },
  // Integrations 2.0 (ETAP 8)
  outboundEvent: {
    deliveries: { model: "outboundDelivery", fk: "eventId", kind: "many" },
  },
  outboundDelivery: {
    event: { model: "outboundEvent", fk: "eventId", kind: "one" },
    integration: { model: "integration", fk: "integrationId", kind: "one" },
  },
  integrationSubscription: {
    integration: { model: "integration", fk: "integrationId", kind: "one" },
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
  automation: {
    trackedLinks: { model: "trackedLink", fk: "automationId", kind: "many" },
    instagramAccount: { model: "instagramAccount", fk: "instagramAccountId", kind: "one" },
  },
  // Legacy → Comment 2.0 migration (audit 2026-10-26)
  legacyCampaignMigration: {
    automation: { model: "automation", fk: "automationId", kind: "one" },
  },
  onboardingSession: {},
  instagramAccount: {
    triggerCampaigns: { model: "triggerCampaign", fk: "instagramAccountId", kind: "many" },
    scheduledPosts: { model: "scheduledPost", fk: "instagramAccountId", kind: "many" },
  },
  // Content Scheduler (ETAP 13)
  scheduledPost: {
    media: { model: "scheduledPostMedia", fk: "postId", kind: "many" },
    instagramAccount: { model: "instagramAccount", fk: "instagramAccountId", kind: "one" },
    workspace: { model: "workspace", fk: "workspaceId", kind: "one" },
    attemptsLog: { model: "publishAttempt", fk: "postId", kind: "many" },
    automations: { model: "automation", fk: "scheduledPostId", kind: "many" },
    triggerCampaigns: { model: "triggerCampaign", fk: "scheduledPostId", kind: "many" },
    reviews: { model: "postReview", fk: "postId", kind: "many" },
    notes: { model: "postNote", fk: "postId", kind: "many" },
    channelTargets: { model: "channelPostTarget", fk: "postId", kind: "many" },
  },
  // Telegram channel (audit T3)
  channelPostTarget: {
    post: { model: "scheduledPost", fk: "postId", kind: "one" },
  },
  // Content approval (ETAP 13 Faza 2)
  postReview: {
    post: { model: "scheduledPost", fk: "postId", kind: "one" },
  },
  postNote: {
    post: { model: "scheduledPost", fk: "postId", kind: "one" },
  },
  scheduledPostMedia: {
    media: { model: "mediaAsset", fk: "mediaId", kind: "one" },
    post: { model: "scheduledPost", fk: "postId", kind: "one" },
  },
  mediaAsset: {
    usages: { model: "scheduledPostMedia", fk: "mediaId", kind: "many" },
    workspace: { model: "workspace", fk: "workspaceId", kind: "one" },
  },
  publishAttempt: {
    post: { model: "scheduledPost", fk: "postId", kind: "one" },
  },
  instagramEvent: {
    instagramAccount: { model: "instagramAccount", fk: "instagramAccountId", kind: "one" },
    contact: { model: "instagramContact", fk: "contactId", kind: "one" },
    executions: { model: "triggerExecution", fk: "eventId", kind: "many" },
  },
  triggerCampaign: {
    instagramAccount: { model: "instagramAccount", fk: "instagramAccountId", kind: "one" },
    flow: { model: "flow", fk: "proxyCampaignId", kind: "one", inverse: true },
    replyVariants: { model: "triggerReplyVariant", fk: "campaignId", kind: "many" },
    quickReplies: { model: "triggerQuickReply", fk: "campaignId", kind: "many" },
    followUpSteps: { model: "triggerFollowUpStep", fk: "campaignId", kind: "many" },
  },
  triggerExecution: {
    campaign: { model: "triggerCampaign", fk: "campaignId", kind: "one" },
    event: { model: "instagramEvent", fk: "eventId", kind: "one" },
    followUps: { model: "triggerFollowUpRun", fk: "executionId", kind: "many" },
  },
  instagramContact: {
    instagramAccount: { model: "instagramAccount", fk: "instagramAccountId", kind: "one" },
  },
  triggerConversation: {
    contact: { model: "instagramContact", fk: "contactId", kind: "one" },
    messages: { model: "triggerMessage", fk: "conversationId", kind: "many" },
  },
  triggerFollowUpRun: {
    execution: { model: "triggerExecution", fk: "executionId", kind: "one" },
  },
  aiConversationState: {
    conversation: { model: "conversation", fk: "conversationId", kind: "one" },
    scoreEvents: { model: "aiScoreEvent", fk: "stateId", kind: "many" },
  },
  aiHandoff: {
    conversation: { model: "conversation", fk: "conversationId", kind: "one" },
  },
  aiLeadInsight: {
    lead: { model: "lead", fk: "leadId", kind: "one" },
  },
  // CRM (ETAP 5)
  crmContact: {
    workspace: { model: "workspace", fk: "workspaceId", kind: "one" },
    tags: { model: "crmContactTag", fk: "contactId", kind: "many" },
    deals: { model: "crmDeal", fk: "contactId", kind: "many" },
    activities: { model: "crmActivity", fk: "contactId", kind: "many" },
    assignments: { model: "crmAssignment", fk: "contactId", kind: "many" },
    recipients: { model: "crmBroadcastRecipient", fk: "contactId", kind: "many" },
  },
  crmTag: {
    contacts: { model: "crmContactTag", fk: "tagId", kind: "many" },
  },
  crmContactTag: {
    contact: { model: "crmContact", fk: "contactId", kind: "one" },
    tag: { model: "crmTag", fk: "tagId", kind: "one" },
  },
  crmSegment: {
    broadcasts: { model: "crmBroadcast", fk: "segmentId", kind: "many" },
  },
  crmPipeline: {
    stages: { model: "crmStage", fk: "pipelineId", kind: "many" },
    deals: { model: "crmDeal", fk: "pipelineId", kind: "many" },
  },
  crmStage: {
    pipeline: { model: "crmPipeline", fk: "pipelineId", kind: "one" },
    deals: { model: "crmDeal", fk: "stageId", kind: "many" },
  },
  crmDeal: {
    contact: { model: "crmContact", fk: "contactId", kind: "one" },
    pipeline: { model: "crmPipeline", fk: "pipelineId", kind: "one" },
    stage: { model: "crmStage", fk: "stageId", kind: "one" },
  },
  crmAssignmentRule: {
    assignments: { model: "crmAssignment", fk: "ruleId", kind: "many" },
  },
  crmAssignment: {
    contact: { model: "crmContact", fk: "contactId", kind: "one" },
    rule: { model: "crmAssignmentRule", fk: "ruleId", kind: "one" },
  },
  crmActivity: {
    contact: { model: "crmContact", fk: "contactId", kind: "one" },
  },
  crmBroadcast: {
    segment: { model: "crmSegment", fk: "segmentId", kind: "one" },
    recipients: { model: "crmBroadcastRecipient", fk: "broadcastId", kind: "many" },
  },
  crmBroadcastRecipient: {
    broadcast: { model: "crmBroadcast", fk: "broadcastId", kind: "one" },
    contact: { model: "crmContact", fk: "contactId", kind: "one" },
  },
  // Flow Builder (ETAP 6)
  flow: {
    versions: { model: "flowVersion", fk: "flowId", kind: "many" },
    runs: { model: "flowRun", fk: "flowId", kind: "many" },
    proxyCampaign: { model: "triggerCampaign", fk: "proxyCampaignId", kind: "one" },
    instagramAccount: { model: "instagramAccount", fk: "instagramAccountId", kind: "one" },
  },
  flowVersion: {
    flow: { model: "flow", fk: "flowId", kind: "one" },
    runs: { model: "flowRun", fk: "versionId", kind: "many" },
  },
  flowRun: {
    flow: { model: "flow", fk: "flowId", kind: "one" },
    version: { model: "flowVersion", fk: "versionId", kind: "one" },
    steps: { model: "flowRunStep", fk: "runId", kind: "many" },
  },
  flowRunStep: {
    run: { model: "flowRun", fk: "runId", kind: "one" },
  },
  // Engagement (ETAP 9)
  giveaway: {
    instagramAccount: { model: "instagramAccount", fk: "instagramAccountId", kind: "one" },
    workspace: { model: "workspace", fk: "workspaceId", kind: "one" },
    entries: { model: "giveawayEntry", fk: "giveawayId", kind: "many" },
    draws: { model: "giveawayDraw", fk: "giveawayId", kind: "many" },
    notifications: { model: "giveawayNotification", fk: "giveawayId", kind: "many" },
  },
  giveawayEntry: {
    giveaway: { model: "giveaway", fk: "giveawayId", kind: "one" },
  },
  giveawayDraw: {
    giveaway: { model: "giveaway", fk: "giveawayId", kind: "one" },
  },
  giveawayNotification: {
    giveaway: { model: "giveaway", fk: "giveawayId", kind: "one" },
  },
  referralProgram: {
    instagramAccount: { model: "instagramAccount", fk: "instagramAccountId", kind: "one" },
    workspace: { model: "workspace", fk: "workspaceId", kind: "one" },
    codes: { model: "referralCode", fk: "programId", kind: "many" },
    events: { model: "referralEvent", fk: "programId", kind: "many" },
  },
  referralCode: {
    program: { model: "referralProgram", fk: "programId", kind: "one" },
    events: { model: "referralEvent", fk: "codeId", kind: "many" },
  },
  referralEvent: {
    program: { model: "referralProgram", fk: "programId", kind: "one" },
    code: { model: "referralCode", fk: "codeId", kind: "one" },
  },
  engagementSettings: {
    workspace: { model: "workspace", fk: "workspaceId", kind: "one" },
  },
  engagementPoint: {
    workspace: { model: "workspace", fk: "workspaceId", kind: "one" },
  },
  engagementBadge: {
    workspace: { model: "workspace", fk: "workspaceId", kind: "one" },
  },
  // Migration (ETAP 11)
  migrationProject: {
    workspace: { model: "workspace", fk: "workspaceId", kind: "one" },
    items: { model: "migrationItem", fk: "projectId", kind: "many" },
  },
  migrationItem: {
    project: { model: "migrationProject", fk: "projectId", kind: "one" },
  },
  // MCP (ETAP 12)
  mcpToken: {
    workspace: { model: "workspace", fk: "workspaceId", kind: "one" },
    actions: { model: "mcpAction", fk: "tokenId", kind: "many" },
  },
  mcpAction: {
    workspace: { model: "workspace", fk: "workspaceId", kind: "one" },
    token: { model: "mcpToken", fk: "tokenId", kind: "one" },
  },
};

/**
 * Compound unique keys of the trigger-engine models. A clash throws an error
 * with Prisma's P2002 code, which is what that code checks for.
 */
const UNIQUE_KEYS: Record<string, string[][]> = {
  legacyCampaignMigration: [["automationId"]],
  legacyMigrationSample: [["migrationId", "commentId"]],
  instagramEvent: [["instagramAccountId", "messageId"]],
  triggerExecution: [["eventId", "campaignId"]],
  instagramContact: [["instagramAccountId", "igUserId"]],
  triggerConversation: [["contactId"]],
  triggerMessage: [["conversationId", "mid"]],
  // JavobAI (ETAP 4)
  javobAiAccount: [["instagramAccountId"]],
  aiConversationState: [["conversationId"]],
  aiScoreEvent: [["stateId", "leadCycle", "signal"]],
  aiContactMemory: [["instagramAccountId", "igUserId"]],
  aiLeadInsight: [["leadId"]],
  // Trust ladder (audit 2026-10-26)
  aiIntentPolicy: [["instagramAccountId", "intent"]],
  aiDraft: [["shadowTurnId"]],
  commentModeration: [["commentId"]],
  channelCredential: [["workspaceId", "channel", "externalAccountId"]],
  telegramChannel: [["chatId"], ["dmChatId"]],
  telegramBusinessConnection: [["connectionId"]],
  channelMessage: [["channel", "chatId", "externalId"]],
  channelPostTarget: [["postId", "channel", "accountRef"]],
  channelPrivateReply: [["channel", "commentId"]],
  channelAutoReplyLog: [["messageId"]],
  // Ads (audit phase 7)
  adAccount: [["workspaceId", "adAccountId"]],
  adProposal: [["accountId", "kind", "igMediaId"]],
  adSpendDay: [["proposalId", "date"]],
  adReferral: [["instagramAccountId", "igUserId", "adId"]],
  capiEvent: [["dealId", "eventName"]],
  payment: [["provider", "providerTransId"]],
  // Content intelligence (audit phase 5)
  contentPostStat: [["instagramAccountId", "igMediaId"]],
  contentAnalysis: [["statId"]],
  contentReport: [["instagramAccountId", "weekStart"]],
  // CRM (ETAP 5)
  crmContact: [["instagramAccountId", "igUserId"], ["conversationId"], ["instagramContactId"]],
  crmTag: [["workspaceId", "slug"]],
  crmContactTag: [["contactId", "tagId"]],
  crmPipeline: [["workspaceId", "name"]],
  crmStage: [["pipelineId", "name"]],
  crmDeal: [["leadId"]],
  crmActivity: [["sourceTable", "sourceId", "type"]],
  crmSyncCursor: [["source"]],
  crmBroadcastRecipient: [["broadcastId", "contactId"]],
  // Integrations 2.0 (ETAP 8)
  outboundEvent: [["workspaceId", "dedupeKey"]],
  outboundDelivery: [["eventId", "integrationId"]],
  integrationSubscription: [["integrationId", "eventType"]],
  // Flow Builder (ETAP 6)
  flowVersion: [["flowId", "version"]],
  // Content Scheduler (ETAP 13)
  scheduledPost: [["igMediaId"]],
  scheduledPostMedia: [["postId", "position"]],
  flowRun: [["executionId"]],
  flowRunStep: [["runId", "seq"]],
  flow: [["proxyCampaignId"], ["publishedVersionId"], ["draftVersionId"]],
  // Analytics (ETAP 10)
  analyticsDaily: [["workspaceId", "instagramAccountId", "day", "metric", "dimKind", "dimId"]],
  analyticsAlertState: [["workspaceId", "rule"]],
  // Engagement (ETAP 9)
  giveawayEntry: [["giveawayId", "igUserId"]],
  giveawayDraw: [["giveawayId", "sequence"]],
  referralProgram: [["instagramAccountId"]],
  referralCode: [["instagramAccountId", "code"], ["programId", "igUserId"]],
  referralEvent: [["programId", "refereeIgUserId"]],
  engagementSettings: [["workspaceId"]],
  engagementPoint: [["sourceTable", "sourceId", "reason"]],
  giveawayNotification: [["giveawayId", "entryId", "channel"]],
  engagementBadge: [["contactId", "badgeKey"]],
  // Migration (ETAP 11)
  migrationItem: [["projectId", "kind", "sourceId"]],
  // MCP (ETAP 12)
  mcpToken: [["tokenHash"]],
};

const DEFAULTS: Record<string, () => Row> = {
  lead: () => ({
    status: "NEW", source: "INBOUND_DM", isTest: false, kind: "LEAD", isRepeat: false, repeatCount: 0,
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
  workspace: () => ({ aiConversationsThisPeriod: 0, aiConversationsLimit: null, assistantTemplateOnlyUntil: null, timezone: "Asia/Tashkent", mediaStorageBytes: BigInt(0), planSlug: "start", planExpiresAt: null }),
  instagramAccount: () => ({ tokenStatus: "ACTIVE", accessToken: "", canPublish: false, grantedScopes: [], publishQuotaUsed: null, publishQuotaCheckedAt: null }),
  // Content Scheduler (ETAP 13)
  scheduledPost: () => ({
    status: "DRAFT", version: 1, attempts: 0, collaborators: [], labels: [], shareToFeed: true, autoPublish: true,
    isAiGenerated: false, timezone: "Asia/Tashkent", deletedAt: null, caption: null, firstComment: null,
    coverMediaId: null, thumbOffsetMs: null, trialStrategy: null, audioName: null, locationId: null,
    manualReason: null, scheduledAt: null, seriesId: null, seriesIndex: null, containerId: null,
    containerStatus: null, containerCreatedAt: null, igMediaId: null, permalink: null, publishedAt: null,
    firstCommentId: null, firstCommentStatus: null, lastErrorCode: null, lastErrorMessage: null,
    reviewRule: null, reviewSubmittedAt: null, createdById: null,
  }),
  scheduledPostMedia: () => ({ altText: null, userTags: [], cropRect: null, containerId: null }),
  mediaAsset: () => ({
    status: "UPLOADING", tags: [], preparedKey: null, thumbKey: null, width: null, height: null,
    durationMs: null, codec: null, fps: null, error: null, uploadedById: null,
  }),
  postReview: () => ({ reviewerUserId: null, externalEmail: null, tokenHash: null, decision: null, comment: null, decidedAt: null }),
  publishAttempt: () => ({ metaCode: null, metaSubcode: null, fbTraceId: null, message: null, durationMs: null }),
  knowledgeGap: () => ({ status: "OPEN", hits: 1, examples: [] }),
  onboardingSession: () => ({ step: 0, answers: {}, fsm: {}, status: "ACTIVE", language: "uz", igAccountId: null, reminderSentAt: null }),
  telegramUser: () => ({ language: "uz" }),
  telegramLinkCode: () => ({ usedAt: null, purpose: "link" }),
  workspaceMember: () => ({ role: "OWNER" }),
  automation: () => ({ keywords: [], isActive: true, dmTriggerEnabled: false, handoffToAssistant: false }),
  dmLog: () => ({ status: "SENT", matchedKeyword: null }),
  instagramEvent: () => ({
    processingStatus: "PENDING", attempts: 0, error: null, errorDetail: null, processingStartedAt: null,
    processedAt: null, contactId: null, conversationId: null, storyId: null, storyUrl: null, mediaId: null,
    senderUsername: null, text: "", claimedCampaignId: null,
  }),
  triggerCampaign: () => ({ storyScope: "ALL", storyIds: [], keywords: [], matchingMode: "EVERY", responseType: "SEND_MESSAGE", active: true, kind: "CAMPAIGN", stopOnPurchase: true }),
  triggerExecution: () => ({
    status: "PENDING", matchedKeyword: null, sentMessageId: null, attempts: 0, error: null, errorDetail: null,
    nextRetryAt: null, sentAt: null,
  }),
  instagramContact: () => ({ username: null, name: null, interactionCount: 0 }),
  triggerBacktrackRun: () => ({ startedAt: new Date(), error: null, finishedAt: null }),
  // JavobAI (ETAP 4)
  javobAiAccount: () => ({ mode: "OFF", config: {}, enabledBy: null }),
  aiConversationState: () => ({
    handoffState: "AI_ACTIVE", score: 0, temperature: "COLD", summary: "", summaryUpToMessageId: null,
    extracted: {}, context: {}, unknownStreak: 0, turns: 0, leadCycle: 0,
  }),
  aiScoreEvent: () => ({ messageId: null }),
  aiHandoff: () => ({ status: "OPEN", openedAt: new Date(), acceptedAt: null, acceptedBy: null, closedAt: null, closedBy: null, resumeAi: true, escalatedAt: null }),
  aiHandoffRule: () => ({ active: true }),
  aiContactMemory: () => ({ facts: {}, lastSummary: "", leadIds: [] }),
  aiKnowledgeEntry: () => ({ verifiedAt: null, expiresAt: null, source: "owner", active: true, sort: 0 }),
  aiLeadInsight: () => ({ email: null, budget: null, location: null, signals: [], isTest: false }),
  aiShadowTurn: () => ({
    conversationId: null, productionReply: null, aiReply: null, intent: null, confidence: null, score: null, handoff: null, costUsd: 0, error: null,
    instagramAccountId: null, source: "shadow", customerMessageId: null, operatorReply: null, operatorRepliedAt: null,
    judgeMatch: null, judgeScore: null, critical: null, judgeNotes: null, judgedAt: null, factsExtractedAt: null,
  }),
  aiIntentPolicy: () => ({ mode: "OBSERVE", changedBy: null, changedAt: null, demotedAt: null, demoteReason: null }),
  aiDraft: () => ({ shadowTurnId: null, intent: null, confidence: null, status: "PENDING", finalText: null, decidedBy: null, decidedAt: null, error: null }),
  aiFactCandidate: () => ({ source: "observed", shadowTurnId: null, evidence: null, confidence: null, status: "PENDING", validUntil: null, knowledgeEntryId: null, decidedBy: null, decidedAt: null }),
  aiEvalCase: () => ({ expectedIntent: null, mustContain: [], mustNotContain: [], referenceAnswer: null, source: "manual", active: true }),
  aiEvalRun: () => ({ status: "RUNNING", total: 0, passed: 0, failed: 0, results: [], triggeredBy: null, startedAt: new Date(), finishedAt: null }),
  commentModeration: () => ({ mediaId: null, error: null }),
  contentPostStat: () => ({ scheduledPostId: null, productType: null, permalink: null, caption: null, views: null, reach: null, likes: null, comments: null, saves: null, shares: null, follows: null, totalInteractions: null, avgWatchMs: null, skipRate: null, bizComments: 0, bizDms: 0, bizLeads: 0, bizSales: 0, score: null }),
  contentAnalysis: () => ({ status: "PENDING", tags: {}, transcript: null, issues: [], model: null, costUsd: null, error: null, analyzedAt: null }),
  contentReport: () => ({ sentAt: null }),
  contentPlan: () => ({ status: "DRAFT", items: [], model: null, createdById: null }),
  hookExperiment: () => ({ variants: [], status: "RUNNING", winnerIndex: null, decidedAt: null }),
  telegramChannel: () => ({ title: null, username: null, linkedChatId: null, discussionReady: false, dmChatId: null, status: "ACTIVE", rights: {}, missingRights: [] }),
  telegramBusinessConnection: () => ({ canReply: false, isEnabled: true, rights: {} }),
  channelMessage: () => ({ direction: "IN", authorRef: null, authorName: null, text: "", replyToExternalId: null, sentByUserId: null, editedAt: null, deletedAt: null }),
  channelPostTarget: () => ({ status: "PENDING", externalIds: [], attempts: 0, lastError: null, nextAttemptAt: null, pollToken: null, pollStartedAt: null, publishedAt: null }),
  channelPrivateReply: () => ({ status: "SENDING", externalId: null, error: null }),
  channelAutoReply: () => ({ enabled: true, appliesTo: "comment", keywords: [], wholeWord: true, doPublic: true, doPrivate: false, publicReplies: [], privateReplies: [], useAi: false, aiInstruction: null, priority: 0, sentCount: 0, lastFiredAt: null, credentialId: null }),
  channelAutoReplyLog: () => ({ ruleId: null, actions: [], usedAi: false, error: null }),
  adAccount: () => ({ name: null, currency: "USD", pageId: null, igUserId: null, datasetId: null, dailyCapMinor: null, monthlyCapMinor: null, cplMaxMinor: null, defaultDailyBudgetMinor: null, saleValueMinor: null, status: "ACTIVE", lastError: null }),
  adProposal: () => ({ kind: "BOOST", objective: "MESSAGES", statId: null, permalink: null, status: "PROPOSED", approvedById: null, approvedAt: null, startAt: null, endAt: null, campaignId: null, adSetId: null, creativeId: null, adId: null, pauseReason: null, spendMinor: 0, results: 0, insightsAt: null, error: null, expiresAt: null }),
  adSpendDay: () => ({ spendMinor: 0, results: 0 }),
  adReferral: () => ({ adTitle: null, postId: null, productId: null, source: null }),
  capiEvent: () => ({ eventName: "Purchase", status: "PENDING", attempts: 0, error: null, sentAt: null }),
  payment: () => ({ status: "CREATED", providerTransId: null, state: 0, providerTime: null, performedAt: null, canceledAt: null, cancelReason: null, createdById: null }),
  channelCredential: () => ({ label: null, scopes: [], expiresAt: null, refreshedAt: null, checkedAt: null, status: "ACTIVE", lastErrorCode: null, lastErrorAt: null, alertedAt: null, pollCursor: null }),
  llmUsage: () => ({ kind: "reply", conversationId: null, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0, ok: true }),
  triggerFollowUpRun: () => ({ status: "SCHEDULED", sentAt: null, reason: null }),
  // Analytics (ETAP 10)
  analyticsDaily: () => ({ instagramAccountId: "", dimKind: "", dimId: "", value: 0 }),
  analyticsAlertState: () => ({}),
  assistantEvent: () => ({ conversationId: null, payload: null }),
  linkClick: () => ({}),
  // CRM (ETAP 5)
  crmContact: () => ({
    username: null, name: null, phoneE164: null, email: null, language: null, source: "UNKNOWN", status: "NEW",
    score: 0, temperature: "COLD", hasAiState: false, firstInteractionAt: null, lastInteractionAt: null,
    lastInboundAt: null, lastOutboundAt: null, interactionCount: 0, assignedMemberId: null, assignedAt: null,
    conversationId: null, instagramContactId: null, optedOutAt: null, optOutReason: null, mergedIntoId: null, customFields: {},
  }),
  crmTag: () => ({ color: null }),
  crmContactTag: () => ({ sourceRef: null }),
  crmSegment: () => ({ description: null, lastCount: null, lastCountedAt: null, createdByUserId: null }),
  crmPipeline: () => ({ isDefault: false }),
  crmStage: () => ({ kind: "OPEN", color: null, isEntry: false }),
  crmDeal: () => ({ leadId: null, stageEnteredAt: new Date(), wonAt: null, lostAt: null, lostReason: null, assignedMemberId: null }),
  crmAssignmentRule: () => ({ active: true, priority: 0, stageId: null, memberIds: [], productKeywords: [], rrCursor: 0, onlyUnassigned: true }),
  crmAssignment: () => ({ dealId: null, ruleId: null, assignedByUserId: null, assignedAt: new Date(), unassignedAt: null, active: true }),
  crmActivity: () => ({ dealId: null, actorMemberId: null, body: null, payload: null, sourceTable: null, sourceId: null }),
  crmSyncCursor: () => ({ cursorId: null }),
  crmBroadcast: () => ({
    segmentId: null, quickReplies: null, status: "DRAFT", scheduledAt: null, startedAt: null, completedAt: null,
    throttlePerHour: 100, frequencyCapHours: 24, replyWindowHours: 48, conversionWindowDays: 7, totalCount: 0,
    eligibleCount: 0, sentCount: 0, skippedCount: 0, failedCount: 0, repliedCount: 0, convertedCount: 0, lastError: null, tickSeq: 0, nextTickAt: null, createdByUserId: null,
  }),
  // Flow Builder (ETAP 6)
  flow: () => ({ mode: "SIMPLE", status: "DRAFT", draftVersionId: null, publishedVersionId: null, proxyCampaignId: null, createdByUserId: null, archivedAt: null }),
  flowVersion: () => ({
    schemaVersion: 1, source: "MANUAL", prompt: null, changeNote: null, auditResult: null, policyResult: null, testedAt: null,
    approvedAt: null, approvedByUserId: null, publishedAt: null, publishedByUserId: null, retiredAt: null,
  }),
  flowRun: () => ({
    contactId: null, conversationId: null, executionId: null, status: "ACTIVE", currentNodeId: null, seq: 0, variables: {},
    waitNodeId: null, waitUntil: null, waitKind: null, sendsSinceInbound: 0, isTest: false, endReason: null, lastError: null,
    startedAt: new Date(), finishedAt: null,
  }),
  flowRunStep: () => ({ input: null, output: null, reason: null, startedAt: new Date(), finishedAt: null }),
  // Integrations 2.0 (ETAP 8)
  outboundEvent: () => ({ version: 1, isTest: false, payload: null, materializedAt: null, instagramAccountId: null }),
  outboundDelivery: () => ({
    status: "PENDING", attempts: 0, nextAttemptAt: null, lastError: null, responseCode: null, responseSnippet: null,
    signature: null, externalId: null, externalUrl: null, durationMs: null, sentAt: null, subscriptionId: null,
  }),
  integrationSubscription: () => ({ filter: {}, active: true }),
  // Engagement (ETAP 9)
  giveaway: () => ({
    description: null, mediaMeta: null, status: "DRAFT", winnersCount: 1, backupCount: 0, seedCommitment: null, seedEncrypted: null,
    committedAt: null, confirmCampaignId: null, collectCursorAt: null, collectCursorId: null, backfillStatus: null,
    backfillScanned: 0, backfillError: null, entriesCount: 0, eligibleCount: 0, createdByUserId: null,
  }),
  giveawayEntry: () => ({
    username: null, contactId: null, commentCount: 1, sourceEventIds: [], mentionEventId: null, mentionedAt: null,
    taggedUsernames: [], followResult: "NOT_CHECKED", followCheckedAt: null, checks: {}, status: "PENDING_CHECK",
    ineligibleReason: null, disqualifiedAt: null, disqualifiedBy: null, disqualifyReason: null,
  }),
  giveawayDraw: () => ({
    winnerEntryIds: [], backupEntryIds: [], status: "DRAWN", drawnAt: new Date(), confirmedAt: null, confirmedByUserId: null,
    voidedAt: null, voidReason: null,
  }),
  giveawayNotification: () => ({ reason: null, sentMessageId: null, snapshot: null }),
  referralProgram: () => ({ active: false, qualifier: "FIRST_MESSAGE", rewardRules: {}, burstLimitPerDay: 10 }),
  referralCode: () => ({ contactId: null, lastSharedAt: null }),
  referralEvent: () => ({
    referrerContactId: null, refereeContactId: null, status: "PENDING", qualifiedAt: null, qualifiedBy: null, rewardedAt: null,
    rewardSnapshot: null, fraudFlags: [], reviewedAt: null, reviewedByUserId: null, rejectReason: null,
  }),
  engagementSettings: () => ({ pointsRules: {}, badgeRules: [] }),
  engagementPoint: () => ({}),
  engagementBadge: () => ({ awardedAt: new Date() }),
  // Migration (ETAP 11)
  migrationProject: () => ({
    source: "MANYCHAT", status: "CONNECTED", instagramAccountId: null, apiKeyEncrypted: null, apiKeyHint: null, pageSnapshot: null,
    lastAnalyzedAt: null, lastError: null, createdByUserId: null,
  }),
  migrationItem: () => ({ sourceId: null, folder: null, status: "PENDING", mapping: {}, sourceText: null, warnings: [], flowId: null, note: null, importClaimedAt: null }),
  // MCP (ETAP 12)
  mcpToken: () => ({ scope: "READ", requireHumanApproval: true, createdByUserId: null, lastUsedAt: null, revokedAt: null, expiresAt: null }),
  mcpAction: () => ({ status: "PROPOSED", failedAttempts: 0, approvedBy: null, confirmCodeHash: null, result: null, error: null, resolvedAt: null }),
  crmBroadcastRecipient: () => ({
    ineligibleReason: null, status: "PENDING", attempts: 0, sentMessageId: null, sentAt: null, error: null,
    repliedAt: null, replyMessageId: null, convertedAt: null, conversionDealId: null,
  }),
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
  /** Raw SQL run through $executeRaw / $executeRawUnsafe (text with "?" for parameters, and the values). */
  raw: Array<{ sql: string; values: unknown[] }> = [];
  /**
   * Interactive transactions ($transaction(fn)) run one at a time, like
   * callers serialised by a Postgres lock. Not isolated: writes are visible at
   * once and are not rolled back on error.
   */
  private txChain: Promise<unknown> = Promise.resolve();
  /** When set, every interactive transaction fails with it (a lost connection, a lock timeout). */
  transactionError: Error | null = null;

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
    if (rel.kind === "one" && rel.inverse) return this.rows(rel.model).find((r) => r[rel.fk] === row.id) ?? null;
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
        case "startsWith":
          return (cond as { mode?: string }).mode === "insensitive"
            ? String(actual ?? "").toLowerCase().startsWith(String(expected).toLowerCase())
            : String(actual ?? "").startsWith(String(expected));
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
    const specs = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<Record<string, "asc" | "desc" | { sort: "asc" | "desc"; nulls?: "first" | "last" }>>;
    return [...list].sort((a, b) => {
      for (const spec of specs) {
        const [field, raw] = Object.entries(spec)[0];
        const dir = typeof raw === "string" ? raw : raw.sort;
        // Postgres default: NULLS FIRST for desc, NULLS LAST for asc; `nulls` overrides.
        const nullsFirst = typeof raw === "string" ? dir === "desc" : raw.nulls ? raw.nulls === "first" : dir === "desc";
        const x = a[field] as number | Date | string | null | undefined;
        const y = b[field] as number | Date | string | null | undefined;
        const xNull = x === null || x === undefined;
        const yNull = y === null || y === undefined;
        if (xNull && yNull) continue;
        if (xNull) return nullsFirst ? -1 : 1;
        if (yNull) return nullsFirst ? 1 : -1;
        if (x === y || (x instanceof Date && y instanceof Date && x.getTime() === y.getTime())) continue;
        const cmp = x < y ? -1 : 1;
        return dir === "desc" ? -cmp : cmp;
      }
      return 0;
    });
  }

  /** Relations requested through `select` behave like `include`. */
  private selectAsInclude(model: string, select?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!select) return undefined;
    const entries = Object.entries(select).filter(([key, value]) => (RELATIONS[model]?.[key] || key === "_count") && value);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }

  model(name: string) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const db = this;
    const find = (args: { where?: Row; orderBy?: unknown; cursor?: Row; skip?: number; take?: number } = {}) => {
      let list = db.rows(name).filter((r) => db.matches(name, r, args.where));
      if (args.orderBy) list = db.sort(list, args.orderBy);
      // Prisma cursor paging: start at the row matching `cursor` (the caller skips it with skip: 1).
      if (args.cursor) {
        const index = list.findIndex((r) => db.matches(name, r, args.cursor));
        list = index === -1 ? [] : list.slice(index);
      }
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
        for (const key of UNIQUE_KEYS[name] ?? []) {
          // Postgres lets NULLs repeat in a unique index.
          if (key.some((k) => flat[k] === null || flat[k] === undefined)) continue;
          if (db.rows(name).some((r) => key.every((k) => r[k] === flat[k]))) {
            throw Object.assign(new Error(`Unique constraint failed: ${name}(${key.join(",")})`), { code: "P2002" });
          }
        }
        const created = db.seed(name, flat);
        // nested `{ relation: { create: [...] } }` on a one-to-many relation
        for (const [k, v] of Object.entries(data)) {
          const rel = RELATIONS[name]?.[k];
          const nested = v && typeof v === "object" ? (v as { create?: Row | Row[] }).create : undefined;
          if (rel?.kind === "many" && nested) for (const child of Array.isArray(nested) ? nested : [nested]) db.seed(rel.model, { ...child, [rel.fk]: created.id });
        }
        return db.withInclude(name, created, include);
      },
      async createMany({ data, skipDuplicates }: { data: Row[]; skipDuplicates?: boolean }) {
        let count = 0;
        for (const row of data) {
          const clash = (UNIQUE_KEYS[name] ?? []).some(
            (key) => !key.some((k) => row[k] === null || row[k] === undefined) && db.rows(name).some((r) => key.every((k) => r[k] === row[k]))
          );
          if (clash && skipDuplicates) continue;
          if (clash) throw Object.assign(new Error(`Unique constraint failed: ${name}`), { code: "P2002" });
          db.seed(name, row);
          count++;
        }
        return { count };
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
      async findFirstOrThrow(args: { where?: Row; orderBy?: unknown; include?: Record<string, unknown>; select?: Record<string, unknown> } = {}) {
        const row = await this.findFirst(args);
        if (!row) throw new Error(`${name} not found`);
        return row;
      },
      async findMany(args: { where?: Row; orderBy?: unknown; cursor?: Row; skip?: number; take?: number; include?: Record<string, unknown>; select?: Record<string, unknown> } = {}) {
        return find(args).map((r) => db.withInclude(name, r, args.include ?? db.selectAsInclude(name, args.select)));
      },
      async count(args: { where?: Row } = {}) {
        return find(args).length;
      },
      async update({ where, data, include }: { where: Row; data: Row; include?: Record<string, unknown> }) {
        db.log.push({ model: name, op: "update" });
        const row = find({ where })[0];
        if (!row) throw new Error(`${name} not found for update`);
        // Unique keys hold on update too (Postgres raises P2002 for a taken value).
        for (const key of UNIQUE_KEYS[name] ?? []) {
          const next = { ...row, ...Object.fromEntries(Object.entries(data).filter(([k, v]) => key.includes(k) && v !== undefined)) };
          if (key.some((k) => next[k] === null || next[k] === undefined)) continue;
          if (db.rows(name).some((r) => r !== row && key.every((k) => r[k] === next[k]))) {
            throw Object.assign(new Error(`Unique constraint failed: ${name}(${key.join(",")})`), { code: "P2002" });
          }
        }
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
      /** Keys only, or with `_sum` / orderBy `_sum.<field>` / take (the engagement leaderboard). */
      async groupBy({ by, where, _sum, _count, orderBy, take }: { by: string[]; where?: Row; _sum?: Record<string, boolean>; _count?: unknown; orderBy?: unknown; take?: number }) {
        const seen = new Map<string, Row>();
        for (const r of find({ where })) {
          const key = by.map((k) => r[k]).join("|");
          const group = seen.get(key) ?? { ...Object.fromEntries(by.map((k) => [k, r[k]])), ...(_sum ? { _sum: Object.fromEntries(Object.keys(_sum).map((f) => [f, 0])) } : {}) };
          if (_sum) for (const f of Object.keys(_sum)) (group._sum as Row)[f] = Number((group._sum as Row)[f] ?? 0) + (Number(r[f]) || 0);
          if (_count) group._count = { _all: Number(((group._count as Row | undefined)?._all as number) ?? 0) + 1 };
          seen.set(key, group);
        }
        let list = [...seen.values()];
        const specs = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Array<Record<string, unknown>>;
        if (specs.length > 0) {
          list = list.sort((a, b) => {
            for (const spec of specs) {
              const [field, raw] = Object.entries(spec)[0];
              let x: unknown;
              let y: unknown;
              let dir: unknown = raw;
              if (field === "_sum") {
                const [f, d] = Object.entries(raw as Row)[0];
                x = (a._sum as Row)[f];
                y = (b._sum as Row)[f];
                dir = d;
              } else {
                x = a[field];
                y = b[field];
              }
              if (x === y) continue;
              const cmp = (x as number | string) < (y as number | string) ? -1 : 1;
              return dir === "desc" ? -cmp : cmp;
            }
            return 0;
          });
        }
        return take !== undefined ? list.slice(0, take) : list;
      },
      async aggregate({ where, _sum }: { where?: Row; _sum?: Record<string, boolean> }) {
        const rows = find({ where });
        return { _sum: Object.fromEntries(Object.keys(_sum ?? {}).map((f) => [f, rows.length ? rows.reduce((total, r) => total + (Number(r[f]) || 0), 0) : null])) };
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
          if (prop === "$transaction") {
            return async (ops: unknown[] | ((tx: unknown) => Promise<unknown>)) => {
              if (!Array.isArray(ops)) {
                if (db.transactionError) throw db.transactionError;
                const run = db.txChain.then(() => ops(db.client()));
                db.txChain = run.catch(() => {});
                return run;
              }
              return Promise.all(ops as Promise<unknown>[]);
            };
          }
          if (prop === "$executeRaw") {
            return async (strings: TemplateStringsArray, ...values: unknown[]) => {
              db.raw.push({ sql: strings.join("?"), values });
              return 0;
            };
          }
          if (prop === "$executeRawUnsafe") {
            return async (sql: string, ...values: unknown[]) => {
              db.raw.push({ sql, values });
              return 0;
            };
          }
          return db.model(prop);
        },
      }
    ) as never;
  }
}

export function resetIds() {
  seq = 0;
}
