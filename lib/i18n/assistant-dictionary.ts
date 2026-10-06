/**
 * Strings for the lead assistant, leads and integrations area. Kept in its own
 * module (and spread into each locale dictionary as `assistant`) so the three
 * large locale files stay manageable. Both uz (Latin) and ru are first-class;
 * en mirrors them.
 */

export interface AssistantDictionary {
  nav: {
    assistant: string;
    leads: string;
    integrations: string;
  };
  tokenBanner: {
    title: string;
    body: (usernames: string) => string;
    cta: string;
  };
  tokenStatus: {
    active: string;
    broken: string;
    brokenHelp: string;
  };
}

export const assistantUz: AssistantDictionary = {
  nav: {
    assistant: "Assistent",
    leads: "Lidlar",
    integrations: "Integratsiyalar",
  },
  tokenBanner: {
    title: "Instagram ulanishi uzilgan",
    body: (usernames) =>
      `${usernames} uchun Meta tokenni rad etdi — kampaniyalar va assistent ishlamayapti. Akkauntni qayta ulang.`,
    cta: "Qayta ulash",
  },
  tokenStatus: {
    active: "Ulangan",
    broken: "Uzilgan",
    brokenHelp: "Meta tokenni rad etdi. Akkauntni qayta ulang.",
  },
};

export const assistantRu: AssistantDictionary = {
  nav: {
    assistant: "Ассистент",
    leads: "Лиды",
    integrations: "Интеграции",
  },
  tokenBanner: {
    title: "Подключение Instagram потеряно",
    body: (usernames) =>
      `Meta отклонила токен для ${usernames} — кампании и ассистент не работают. Подключите аккаунт заново.`,
    cta: "Подключить заново",
  },
  tokenStatus: {
    active: "Подключено",
    broken: "Отключено",
    brokenHelp: "Meta отклонила токен. Подключите аккаунт заново.",
  },
};

export const assistantEn: AssistantDictionary = {
  nav: {
    assistant: "Assistant",
    leads: "Leads",
    integrations: "Integrations",
  },
  tokenBanner: {
    title: "Instagram connection lost",
    body: (usernames) =>
      `Meta rejected the token for ${usernames} — campaigns and the assistant are not working. Reconnect the account.`,
    cta: "Reconnect",
  },
  tokenStatus: {
    active: "Connected",
    broken: "Disconnected",
    brokenHelp: "Meta rejected the token. Reconnect the account.",
  },
};
