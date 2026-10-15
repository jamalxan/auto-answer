# SOCIALAUTO.UZ — MASTER TECHNICAL SPECIFICATION

## Instagram Automation + AI Sales Platform

**Document type:** Product + Technical Specification  
**Project:** SocialAuto.uz  
**Target market:** Uzbekistan first, then international expansion  
**Primary platforms:** Instagram + Telegram  
**Main languages:** O‘zbek lotin, O‘zbek kirill, Русский  
**Document purpose:** Development team / Claude Code uchun yagona, izchil va bajarishga tayyor texnik yo‘nalish

---

# 0. HUJJATNING ASOSIY MAQSADI

SocialAuto oddiy **“Comment → DM”** servisida qolmasligi kerak.

Platformaning asosiy maqsadi:

> **Instagram’dan keladigan foydalanuvchini avtomatik qabul qilish → suhbatlashish → ehtiyojini aniqlash → leadga aylantirish → CRM’da saqlash → kerak bo‘lsa operatorga topshirish → sotuvga olib borish.**

Asosiy biznes oqimi:

```text
Instagram
   ↓
Trigger
   ↓
Automation
   ↓
AI suhbat
   ↓
Lead Qualification
   ↓
CRM
   ↓
Operator
   ↓
Sale
```

Kengaytirilgan oqim:

```text
Comment / Direct / Story / Live / Ads
                ↓
        Automation Engine
                ↓
          JavobAI
                ↓
       Business Knowledge Base
                ↓
       Lead Qualification
                ↓
       CRM / Lead Pipeline
          ↙            ↘
   Operator Handoff     Telegram
          ↓
         Sale
```

## 0.1. Yakuniy mahsulot pozitsiyasi

SocialAuto:

> **O‘zbekiston bozori uchun Instagram Automation + AI Sales Platform.**

Uni quyidagicha pozitsiyalash kerak:

> “Instagram’dagi avtomatik DM bot”

emas.

Balki:

> **“Instagram’dan keladigan mijozlarni AI yordamida qabul qiladigan, suhbatlashadigan, saralaydigan va sotuvga olib boradigan platforma.”**

---

# 1. ENG MUHIM DEVELOPMENT QOIDALARI

Development tasodifiy tarzda olib borilmasligi kerak.

## 1.1. Mavjud ishlaydigan funksiyalarni buzmaslik

Hozir ishlayotgan funksiyalar yangi modullar uchun o‘chirib tashlanmaydi.

Audit materialiga ko‘ra hozirgi SocialAuto’da quyidagi asosiy funksiyalar mavjud:

- Comment → DM
- Follow talabi
- Link yuborish
- Rahmat xabari
- Diagnostika paneli
- Team / jamoa
- Mijozga hisobot
- Kontaktlar

Bu funksiyalar keyingi development uchun **base layer** bo‘lib qoladi.

## 1.2. Development tartibi

Har bir bosqich tugamasdan keyingi bosqichga o‘tilmaydi.

```text
1. Foundation / Stability
2. Comment Automation 2.0
3. Instagram Automation
4. JavobAI
5. CRM / Lead Management
6. Flow Builder
7. AI Flow Builder
8. Integrations
9. Engagement
10. Content + Analytics
11. Migration
12. MCP / AI Control
```

## 1.3. Har bir bosqichda majburiy jarayon

Har bir modul uchun:

```text
Analysis
↓
Architecture
↓
Implementation
↓
Unit tests
↓
Integration tests
↓
E2E tests
↓
Regression tests
↓
Security check
↓
Production readiness
```

---

# 2. HOZIRGI SOCIALAUTO — NIMALAR BOR?

Developmentni boshlashdan oldin existing code audit qilinadi.

### Hozirgi asosiy imkoniyatlar

| Funksiya | Holat |
|---|---|
| Comment → DM | Mavjud |
| Follow requirement | Mavjud |
| Link yuborish | Mavjud |
| Thank-you message | Mavjud |
| Diagnostika | Mavjud |
| Team | Mavjud |
| Client report | Mavjud |
| Contacts | Mavjud |
| Advanced CRM | Rivojlantiriladi |
| Story automation | Qo‘shiladi |
| Direct automation | Qo‘shiladi |
| AI Agent | Qo‘shiladi |
| Flow Builder | Qo‘shiladi |
| Integrations | Qo‘shiladi |

**Muhim:** mavjud kodning qaysi qismi qayta ishlatilishi, qaysi qismi refactor qilinishi va qaysi qismi qayta yozilishi auditdan keyin aniq belgilanadi.

---

# 3. ETAP 1 — FOUNDATION / BARQARORLIK

## Maqsad

Yangi feature qo‘shishdan oldin SocialAuto’ni production-grade holatga olib kelish.

## 3.1. Existing code audit

Tekshiriladi:

- backend architecture;
- database schema;
- Instagram API integration;
- webhook processing;
- background jobs;
- queue;
- retry;
- authentication;
- authorization;
- tenant isolation;
- logging;
- error handling;
- frontend state;
- billing;
- existing diagnostics.

### Natija

Architecture diagram va muammolar ro‘yxati tayyor bo‘lishi kerak.

---

# 4. INSTAGRAM CONNECTION MANAGEMENT

Instagram connection tizimi eng ishonchli modullardan biri bo‘lishi kerak.

## 4.1. Token monitoring

Tizim:

- token holatini tekshiradi;
- expiry / invalid holatni aniqlaydi;
- connection status’ni real holatga moslaydi;
- expired tokenni “Connected” deb ko‘rsatmaydi;
- reconnect imkonini beradi.

### Majburiy statuslar

```text
CONNECTED
EXPIRING
EXPIRED
INVALID
RECONNECT_REQUIRED
ERROR
DISCONNECTED
```

## 4.2. Reconnect

Foydalanuvchi:

```text
Settings
→ Instagram
→ Reconnect
```

orqali imkon qadar kam qadam bilan qayta ulanishi kerak.

## 4.3. Notification

Connection uzilsa:

- dashboard alert;
- Telegram notification;
- email notification (keyinchalik);

orqali xabar berish imkoniyati bo‘lsin.

---

# 5. ERROR SYSTEM

Texnik Meta errorlari foydalanuvchiga tushunarsiz kod sifatida ko‘rsatilmasin.

### Yomon

```text
OAuthException #190
```

### Yaxshi

```text
Instagram ulanishi tugagan.
Instagram akkauntingizni qayta ulang.
[Qayta ulash]
```

## 5.1. Error model

Har bir error:

```text
Internal error code
User-friendly message
Severity
Retryable / non-retryable
Action
Timestamp
Related object
```

ga ega bo‘lishi kerak.

---

# 6. QUEUE ENGINE

Instagram interactionlari ko‘payganda ham tizim yiqilmasligi kerak.

Masalan:

```text
312 messages waiting
Estimated completion: 1h 30m
```

## 6.1. Queue vazifalari

- message queue;
- priority;
- retry;
- exponential backoff;
- duplicate protection;
- failed job handling;
- status tracking;
- rate-limit handling;
- worker monitoring.

## 6.2. User-visible queue

Foydalanuvchi quyidagilarni ko‘rishi mumkin:

```text
Queued: 312
Processing: 18
Completed: 924
Failed: 4
Estimated time: 12 min
```

---

# 7. RATE LIMIT VA SPAM PROTECTION

Bu modul barcha automation modullariga umumiy ishlaydi.

Majburiy mexanizmlar:

- rate limit;
- queue;
- retry;
- exponential backoff;
- duplicate protection;
- message variation;
- failed message handling;
- per-account throttling;
- campaign throttling.

## Muhim qoida

Rate-limit xatosida tizim darhol qayta yuborishga urinmasin.

```text
Error
↓
Backoff
↓
Retry
↓
If failed → queue / manual review
```

Auditda rate-limit holatlari uchun kutish/backoff mexanizmi tavsiya qilingan.

---

# 8. ETAP 2 — COMMENT AUTOMATION 2.0

Comment automation SocialAuto’ning eng kuchli va silliq ishlaydigan modullaridan biri bo‘lishi kerak.

---

## 8.1. Keyword trigger

Qo‘llab-quvvatlanadi:

- exact match;
- contains;
- multiple keywords;
- case-insensitive;
- Uzbek Latin;
- Uzbek Cyrillic;
- Russian variants.

Masalan:

```text
narx
narxi
цена
цени
```

bitta intentga bog‘lanishi mumkin.

## 8.2. Trigger priority

Agar bir nechta campaign mos tushsa:

```text
Exact keyword
↓
Specific rule
↓
General rule
↓
AI intent
```

priority bilan tanlanadi.

---

# 9. MULTIPLE REPLY VARIANTS

Bir xil matnni ko‘p foydalanuvchiga aynan takrorlamaslik uchun:

```text
3–10 reply variant
```

qo‘shiladi.

### Rejimlar

```text
Random
Sequential
Weighted Random
AI-generated
```

### Misol

```text
1. Assalomu alaykum! Narx haqida ma’lumot yuboraman.
2. Salom! 😊 Mahsulot narxi haqida hozir yuboraman.
3. Albatta, narxini yuboraman. Batafsil ma’lumot ham kerakmi?
```

---

# 10. AI REPLY GENERATOR

Foydalanuvchi:

> “3 ta tabiiy Uzbekcha javob yarat.”

desa, AI variantlar yaratadi.

AI quyidagilarni hisobga oladi:

- biznes tili;
- brend tone of voice;
- qisqalik;
- emoji darajasi;
- til;
- kampaniya maqsadi.

### Muhim

AI yaratgan matn publish qilinishidan oldin:

```text
Generate
↓
Preview
↓
Edit
↓
Approve
↓
Publish
```

jarayonidan o‘tishi mumkin.

---

# 11. OLD COMMENTS / BACKTRACK

Foydalanuvchi:

> “Oldingi kommentlarga ham yuborish”

opsiyasini tanlaydi.

Tizim:

- oxirgi ruxsat etilgan davrdagi mos kommentlarni;
- duplicate bo‘lmaganlarini;
- allaqachon processed bo‘lganlarini ajratib;

campaign queue’ga qo‘shadi.

Auditda 7 kunlik backtrack modeli benchmark sifatida qayd etilgan.

**Muhim:** real production limitlar Meta API va amaldagi siyosatlarga mos qilib konfiguratsiya qilinadi.

---

# 12. QUICK REPLIES

DM ichida:

```text
[ Narx ]
[ Manzil ]
[ Katalog ]
[ Buyurtma berish ]
```

kabi tugmalar.

Har bir tugma:

- message;
- flow;
- AI action;
- operator handoff;
- lead capture

ishga tushirishi mumkin.

---

# 13. FOLLOW-UP ENGINE

Misol:

```text
User → link oldi
↓
24 soat ichida mos event / permission mavjud bo‘lsa
↓
Follow-up
```

Follow-up parametrlari:

- delay;
- condition;
- maximum attempts;
- cancel;
- stop on reply;
- stop on purchase;
- stop on operator handoff.

### Muhim

Messaging window va Meta’ning amaldagi qoidalari **global policy layer** orqali nazorat qilinadi.

---

# 14. ETAP 3 — FULL INSTAGRAM AUTOMATION

SocialAuto faqat comment triggeriga bog‘lanib qolmasligi kerak.

---

# 15. DIRECT AUTOMATION

Triggerlar:

- new DM;
- keyword;
- message contains;
- first-time user;
- returning user;
- button click;
- AI intent;
- operator assignment;
- conversation reopen.

### Misol

```text
Customer:
Salom, kurs narxi qancha?

AI:
Assalomu alaykum!
IELTS kursimiz oyiga 450 000 so‘m.
Sizning hozirgi darajangiz qanday?
```

Keyingi flow javobga qarab o‘zgaradi.

---

# 16. STORY AUTOMATION

Qo‘shiladi:

### Story Reply

Storyga javob → automation.

### Story Mention

Akkaunt mention qilinsa → automation.

### Story Reaction

Reaction → automation.

Har bir trigger flow, AI yoki lead action bilan ulanadi.

---

# 17. LIVE AUTOMATION

Instagram Live interactionlari:

- keyword;
- comment;
- CTA;
- lead capture

bilan automation’ga ulanadi.

Misol:

```text
LIVE comment: “narx”
↓
DM
↓
AI
↓
Lead
```

---

# 18. ADS AUTOMATION

Instagram advertising interactionlari automation tizimiga ulanadi.

```text
Ad
↓
DM
↓
AI
↓
Qualification
↓
CRM
↓
Operator
```

Campaign analytics bilan birga ishlashi kerak.

---

# 19. ETAP 4 — JAVOBAI

## 19.1. JavobAI nima?

JavobAI oddiy FAQ bot emas.

U:

> **AI Sales Agent**

sifatida ishlab chiqiladi.

---

# 20. BUSINESS KNOWLEDGE BASE

Har bir biznes o‘z ma’lumotlarini kiritadi:

- kompaniya;
- mahsulot;
- xizmat;
- narx;
- manzil;
- ish vaqti;
- yetkazib berish;
- FAQ;
- chegirmalar;
- kontaktlar;
- xizmat shartlari.

## 20.1. AI javob qoidasi

AI tasdiqlanmagan ma’lumotni o‘zi o‘ylab topmasligi kerak.

```text
Verified business data
        ↓
      AI
        ↓
    Answer
```

Agar ma’lumot topilmasa:

```text
AI → “Bu ma’lumot menda yo‘q.”
          ↓
      Operator handoff
```

---

# 21. MULTILINGUAL AI

JavobAI quyidagilarni bitta suhbatda tushunishi kerak:

```text
O‘zbek lotin
O‘zbek kirill
Rus tili
```

Misollar:

```text
Narxi qancha?
Нархи канча?
Сколько стоит?
```

Bular bir xil intent sifatida tushunilishi mumkin.

---

# 22. CONVERSATION MEMORY

AI suhbat kontekstini saqlaydi.

Misol:

```text
User: Kurs narxi qancha?
AI: 450 000 so‘m.

User: Online bormi?
AI:
Ha, online format ham mavjud.

User: Qachon boshlanadi?
AI:
Keyingi guruh 15-oktabrda...
```

AI oldingi kontekstni yo‘qotmasligi kerak.

## 22.1. Memory darajalari

```text
Conversation memory
Contact memory
Business memory
```

---

# 23. AI LEAD QUALIFICATION

AI suhbatdan kerakli ma’lumotlarni chiqaradi:

```text
Name
Phone
Email
Product
Interest
Budget
Location
Language
Lead Score
Status
Source
```

## Lead status

```text
COLD
WARM
HOT
CUSTOMER
LOST
```

---

# 24. LEAD SCORE

Misol:

```text
+10 — product selected
+15 — price asked
+20 — phone provided
+25 — purchase intent
+30 — payment intent
```

Score konfiguratsiyalanadigan bo‘lishi kerak.

### Masalan

```text
0–29   → Cold
30–59  → Warm
60–79  → Hot
80–100 → Very Hot
```

Bu faqat boshlang‘ich model; biznesga qarab sozlanadi.

---

# 25. HUMAN HANDOFF

AI kerak bo‘lsa operatorga topshiradi.

### Triggerlar

- user requests human;
- AI confidence past;
- complaint;
- sensitive situation;
- purchase ready;
- custom request;
- business rule.

### Operatorga o‘tganda

```text
AI = paused
Operator = active
```

Operator suhbatni yopsa:

```text
Operator = closed
AI = resumable
```

---

# 26. VOICE VA IMAGE

Keyingi maturity bosqichida AI:

- text;
- voice;
- image

qabul qilishi mumkin.

Misol:

```text
User uploads product image
↓
Vision AI
↓
Business catalog match
↓
Answer
```

Bu modul JavobAI core barqarorlashgandan keyin qilinadi.

---

# 27. ETAP 5 — CRM / LEAD MANAGEMENT

SocialAuto ichidagi CRM oddiy contact list emas, sales workflow bo‘lishi kerak.

## 27.1. Contact model

Har bir contact:

```text
Instagram username
Name
Phone
Email
Language
Tags
Lead score
Source
Last interaction
Conversation
Assigned operator
Status
Created at
Updated at
```

---

# 28. TAG SYSTEM

Misollar:

```text
HOT
VIP
NEW
REPEAT
INSTAGRAM
COURSE
PRODUCT-A
PAYMENT-PENDING
```

Taglar:

- manual;
- AI-generated;
- automation-generated

bo‘lishi mumkin.

---

# 29. SEGMENTATION

Misol:

```text
Toshkent
+
HOT
+
IELTS
+
Phone collected
```

→ target audience.

Filterlar dynamic ishlashi kerak.

---

# 30. CRM PIPELINE

Minimal pipeline:

```text
New Lead
↓
Contacted
↓
Qualified
↓
Hot
↓
Negotiation
↓
Won / Lost
```

Har bir biznes pipeline bosqichlarini o‘zgartira olishi kerak.

---

# 31. OPERATOR ASSIGNMENT

Lead:

```text
HOT
```

bo‘lsa:

```text
Round robin
OR
Specific team
OR
Product specialist
```

bo‘yicha operatorga beriladi.

---

# 32. CONVERSATION HISTORY

Har bir contact uchun:

- barcha conversation;
- automation event;
- AI response;
- operator response;
- tags;
- status changes;
- lead score changes

ko‘rinishi kerak.

---

# 33. BROADCAST

Broadcast alohida policy-aware engine bilan ishlaydi.

Parametrlar:

```text
Audience
Segment
Campaign
Message
Schedule
Delivery
Reply
Conversion
```

### Muhim

Broadcast faqat amaldagi platforma qoidalari va messaging eligibility asosida yuboriladi.

---

# 34. ETAP 6 — FLOW BUILDER

Visual Flow Builder SocialAuto’ni professional automation platformaga aylantiradi.

---

# 35. FLOW NODELARI

Majburiy node turlari:

```text
Trigger
Message
AI
Condition
Delay
Button
Tag
Lead
Webhook
CRM
Operator
Action
End
```

---

# 36. FLOW NAMUNASI

```text
TRIGGER
   ↓
MESSAGE
   ↓
CONDITION
  ↙      ↘
YES      NO
 ↓        ↓
AI     FOLLOW-UP
 ↓
LEAD
 ↓
CRM
 ↓
OPERATOR
```

---

# 37. SIMPLE MODE

Oddiy foydalanuvchi:

> “Narx deb komment yozganlarga narxni yubor, keyin katalogni taklif qil va qiziqsa telefonini ol.”

AI:

```text
Trigger
→ Comment contains “narx”
→ Send price
→ Send catalog
→ Ask phone
→ Save lead
```

flow yaratadi.

---

# 38. ADVANCED MODE

Professional foydalanuvchi:

- node-by-node;
- conditions;
- branches;
- actions;
- variables;
- delays

orqali qo‘lda flow quradi.

## Asosiy UX printsipi

```text
Simple Mode = maksimal osonlik
Advanced Mode = maksimal nazorat
```

---

# 39. ETAP 7 — AI FLOW BUILDER

Natural language → flow.

### Input

> “Kommentga narx deb yozganlarga mahsulot narxini yubor. Keyin katalogni taklif qil. Qiziqsa telefonini ol. Hot lead bo‘lsa Telegram orqali menejerga yubor.”

### Output

```text
[Comment Trigger]
        ↓
[Send Price]
        ↓
[Send Catalog]
        ↓
[Ask Phone]
        ↓
[Save Lead]
        ↓
[Lead Score]
        ↓
[IF HOT]
     ↙     ↘
   YES      NO
   ↓        ↓
Telegram   End
```

### Publish workflow

```text
Generate
↓
Preview
↓
Validate
↓
Test
↓
Approve
↓
Publish
```

AI flow hech qachon tasdiqsiz ishlab turgan campaignni yashirincha almashtirmasligi kerak.

---

# 40. AI FLOW AUDITOR

AI flowni publishdan oldin tekshiradi.

Tekshiruvlar:

- unreachable node;
- dead-end;
- duplicate action;
- conflicting conditions;
- missing delay;
- spam risk;
- policy risk;
- forbidden content;
- incorrect variable;
- broken integration;
- missing handoff;
- endless loop.

### Output

```text
Errors
Warnings
Optimization suggestions
```

---

# 41. ETAP 8 — INTEGRATIONS

Prioritet tartibi:

## 41.1. Telegram

HOT lead:

```text
🔥 HOT LEAD

Name: Ali
Phone: +998...
Product: IELTS
Score: 87
Source: Instagram Comment
```

operator yoki sales channelga yuboriladi.

## 41.2. Google Sheets

```text
Lead → Google Sheets
```

## 41.3. Webhook

Universal integration layer.

## 41.4. amoCRM

## 41.5. Bitrix24

## 41.6. Make

## 41.7. Zapier

Keyinchalik boshqa CRM va servislar qo‘shiladi.

---

# 42. LOCAL MARKET INTEGRATIONS

O‘zbekiston uchun alohida ustunlik sifatida:

- Telegram;
- Click;
- Payme;
- local CRM workflows;
- Uzbek templates

ko‘rib chiqiladi.

Payment integration development boshlanishidan oldin API va merchant talablari alohida tekshiriladi.

---

# 43. ETAP 9 — GIVEAWAY

Giveaway engine:

```text
Campaign
↓
Rules
↓
Eligibility
↓
Participant list
↓
Randomization
↓
Winner
↓
Verification
```

Qo‘llab-quvvatlanadi:

- follow check;
- comment check;
- mention check;
- conditions;
- participant list;
- winner selection;
- verification.

---

# 44. REFERRAL

Flow:

```text
User
↓
Referral link
↓
Friend joins
↓
Condition met
↓
Reward
```

Referral fraud prevention keyin qo‘shiladi.

---

# 45. GAMIFICATION

Keyingi bosqichda:

- points;
- leaderboard;
- rewards;
- badges.

**Muhim:** gamification core automation va sales modullaridan ustun qo‘yilmaydi.

---

# 46. ETAP 10 — CONTENT SCHEDULER

Keyingi bosqich:

- post scheduling;
- reels scheduling;
- content calendar;
- publish status;
- failed publish retry;
- campaign linkage.

Scheduler automation platformaning asosiy qiymatini kamaytirmasligi kerak; u auxiliary module sifatida qoladi.

---

# 47. ANALYTICS

Analytics faqat “nechta xabar yuborildi” bilan cheklanmasligi kerak.

---

## 47.1. Campaign Analytics

```text
Sent
Delivered
Failed
Replies
Clicks
Leads
Conversions
```

## 47.2. AI Analytics

```text
Conversations
Resolved
Human handoff
Qualified leads
Hot leads
AI success rate
```

## 47.3. Sales Analytics

```text
Leads
Qualified
Won
Lost
Conversion rate
Average lead score
```

---

# 48. FUNNEL ANALYTICS

Misol:

```text
1,000 Comments
      ↓
   720 DMs
      ↓
   410 Replies
      ↓
   180 Leads
      ↓
    72 Hot
      ↓
    26 Sales
```

Platforma qaysi bosqichda conversion yo‘qolayotganini ko‘rsatishi kerak.

---

# 49. DATE FILTER VA COMPARISON

Analytics:

- today;
- 7 days;
- 30 days;
- custom date;

bo‘yicha ishlashi kerak.

Kelajakda:

```text
This month vs last month
Campaign A vs Campaign B
AI vs Human
```

comparison ham bo‘lishi mumkin.

---

# 50. ADMIN PANEL

Admin quyidagilarni ko‘rishi kerak:

- users;
- companies;
- subscriptions;
- campaigns;
- messages;
- AI usage;
- errors;
- Instagram connections;
- queue;
- system health;
- billing;
- support issues.

---

# 51. DIAGNOSTICS

Professional diagnostics:

```text
Instagram connection       ✓
Token                      ✓
Messaging API              ✓
Webhook                    ✓
Last event                 2 min ago
Rate limit                 Normal
Queue                      0
AI                         Healthy
CRM                        Healthy
Telegram                   Connected
```

Har bir item ustiga bosilganda:

```text
Status
What it means
Last check
Possible issue
Recommended action
```

ko‘rsatilishi kerak.

---

# 52. SECURITY

Majburiy:

- encrypted credentials;
- secure token storage;
- role-based access;
- audit logs;
- rate limiting;
- API authentication;
- webhook signature validation;
- sensitive data protection;
- tenant isolation;
- secret management;
- secure session handling.

## 52.1. Tenant isolation

Bir kompaniyaning:

- contactlari;
- conversations;
- tokens;
- AI knowledge;
- analytics;
- files;

boshqa kompaniyaga ko‘rinmasligi shart.

---

# 53. ROLE SYSTEM

Minimal:

```text
Owner
Admin
Manager
Operator
Viewer
```

Permissionlar:

- manage Instagram;
- manage campaigns;
- view contacts;
- assign leads;
- manage billing;
- manage AI;
- export data;
- view analytics.

---

# 54. AI SECURITY

AI quyidagilarni qilmasligi kerak:

- business data bo‘lmagan narsani fakt sifatida aytish;
- token yoki secretni ko‘rsatish;
- boshqa tenant ma’lumotini chiqarish;
- operator permissionlarini chetlab o‘tish;
- tasdiqsiz destructive action bajarish.

---

# 55. META / PLATFORM POLICY GUARDRAIL

SocialAuto “bloklanmaydigan servis” sifatida reklama qilinmasligi kerak.

Platforma:

- messaging window;
- rate limits;
- automation eligibility;
- duplicate message risk;
- unsupported action;

kabi holatlarni iloji boricha oldindan aniqlasin.

## Policy engine

Flow publish vaqtida:

```text
Policy Check
↓
Pass
OR
Warning
OR
Blocked
```

ko‘rinishi mumkin.

---

# 56. PRICING MODEL

Asosiy prinsip:

> **Kontakt soniga asoslangan agressiv pricing bo‘lmasin.**

Boshlang‘ich model:

## FREE

- cheklangan automation;
- cheklangan DM;
- asosiy Comment → DM;
- limited analytics.

## STANDARD

- kengroq automation;
- AI;
- ko‘proq limits;
- CRM basics;
- integrations basics.

## PREMIUM

- yuqori limits;
- advanced AI;
- CRM;
- advanced analytics;
- advanced integrations;
- team capabilities.

Aniq narxlar:

```text
Server cost
AI cost
Meta/API cost
Support cost
Margin
```

hisoblangandan keyin belgilanadi.

### Local payment

- Click;
- Payme.

---

# 57. LOCALIZATION — O‘ZBEKISTON UCHUN

## Language

```text
O‘zbek lotin
O‘zbek kirill
Rus
```

## Support

> O‘zbek tilida tezkor support.

## Local ecosystem

```text
Instagram
Telegram
Click
Payme
amoCRM
Bitrix24
```

## Local UX

Errorlar ham lokal tilda tushuntiriladi.

---

# 58. MANYCHAT MIGRATION

Maqsad:

> ManyChat foydalanuvchisini imkon qadar kam qo‘lda qayta sozlash bilan SocialAuto’ga olib kelish.

Import qilinadigan obyektlar:

- flows;
- triggers;
- keywords;
- messages;
- tags.

Migration jarayoni:

```text
Upload / Connect
↓
Analyze
↓
Mapping
↓
Preview
↓
Warnings
↓
Import
↓
Test
↓
Activate
```

Unsupported elementlar aniq ko‘rsatilishi shart.

---

# 59. MCP / AI CONTROL LAYER

Eng oxirgi bosqich.

Foydalanuvchi:

> “SocialAuto’da ‘narx’ keyword uchun campaign yarat.”

deydi.

AI:

```text
Understand request
↓
Check workspace
↓
Generate flow
↓
Validate
↓
Preview
↓
Ask confirmation
↓
Publish
```

AI orqali:

- campaign yaratish;
- flow o‘zgartirish;
- analytics ko‘rish;
- leadlarni filtrlash;
- diagnostics tekshirish;
- report tayyorlash

mumkin bo‘ladi.

**Muhim:** write actions uchun permission + confirmation layer kerak.

---

# 60. SUPPORT / DIAGNOSTICS

User:

```text
Settings
→ Instagram
→ Diagnostics
```

ochganda tizim o‘zi muammoni tushuntirishi kerak.

Masalan:

```text
❌ Token expired

Muammo:
Instagram access token amal qilish muddatini tugatgan.

Yechim:
Instagram akkauntingizni qayta ulang.

[Reconnect Instagram]
```

---

# 61. UX PRINCIPLES

SocialAuto UX:

### 1. Simple first

Birinchi qarashda foydalanuvchi:

> “Buni tushunaman.”

deyishi kerak.

### 2. Progressive disclosure

Murakkab sozlamalar Advanced Mode ichida bo‘ladi.

### 3. No hidden state

Agar:

- campaign paused;
- token expired;
- queue delayed;
- AI unavailable;

bo‘lsa foydalanuvchi buni ko‘rishi kerak.

### 4. Every error has a solution

Faqat:

```text
Error 500
```

emas.

Balki:

```text
Muammo
Sabab
Yechim
Action
```

---

# 62. PRODUCT PRIORITY — P0 / P1 / P2

## P0 — Foundation

- connection reliability;
- token monitoring;
- reconnect;
- queue;
- rate limit;
- error system;
- security;
- diagnostics.

## P0 — Core Automation

- comment automation 2.0;
- multiple replies;
- AI replies;
- backtrack;
- quick replies;
- follow-up;
- Direct.

## P1 — AI & CRM

- Story;
- Live;
- Ads;
- JavobAI;
- Knowledge Base;
- lead qualification;
- human handoff;
- CRM;
- tags;
- segmentation;
- pipeline;
- Telegram.

## P2 — Advanced Growth

- Flow Builder;
- AI Flow Builder;
- AI Auditor;
- Google Sheets;
- Webhook;
- amoCRM;
- Bitrix24;
- Giveaway;
- Referral;
- Scheduler;
- advanced analytics;
- Migration.

## P3 — Platform Intelligence

- Make;
- Zapier;
- Voice;
- Image;
- MCP;
- advanced AI optimization.

---

# 63. DEVELOPMENT ETAPLARI — YAKUNIY TARTIB

## ETAP 1 — FOUNDATION

### Vazifalar

1. Existing code audit
2. Instagram connection audit
3. Token monitoring
4. Reconnect
5. Error system
6. Queue engine
7. Retry/backoff
8. Rate limit
9. Logging
10. Security
11. Diagnostics

### Done criteria

- Existing features broken emas.
- Token status to‘g‘ri.
- Queue ishlaydi.
- Rate limit holatlari xavfsiz qayta ishlanadi.
- Asosiy xatolar user-friendly.
- Regression testlar o‘tadi.

---

## ETAP 2 — COMMENT AUTOMATION 2.0

### Vazifalar

1. Better keywords
2. Multiple replies
3. AI reply generation
4. Backtrack
5. Quick replies
6. Follow-up
7. Queue visibility

### Done criteria

Real Instagram test scenario’larida:

```text
Comment
→ Trigger
→ DM
→ Follow-up
```

barqaror ishlashi kerak.

---

## ETAP 3 — INSTAGRAM AUTOMATION

### Vazifalar

1. Direct
2. Story Reply
3. Story Mention
4. Story Reaction
5. Live
6. Ads

### Done criteria

Har bir trigger alohida test campaignga ega.

---

## ETAP 4 — JAVOBAI

### Vazifalar

1. Knowledge Base
2. AI Agent
3. Multilingual
4. Conversation memory
5. Lead extraction
6. Lead scoring
7. Human handoff
8. Voice
9. Image

### Done criteria

AI:

- verified data asosida javob beradi;
- contextni saqlaydi;
- leadni ajratadi;
- operatorga to‘g‘ri topshiradi;
- unknown informationni uydirmaydi.

---

## ETAP 5 — CRM

### Vazifalar

1. Contacts
2. Tags
3. Segments
4. Lead Score
5. Pipeline
6. Conversation history
7. Operator assignment
8. Broadcast

### Done criteria

Instagram interaction → Contact → Lead → Pipeline oqimi to‘liq ishlaydi.

---

## ETAP 6 — FLOW BUILDER

### Vazifalar

1. Visual builder
2. Conditions
3. Actions
4. Delay
5. Branches
6. Templates
7. Simple Mode
8. Advanced Mode

---

## ETAP 7 — AI FLOW BUILDER

### Vazifalar

1. Natural language → Flow
2. Preview
3. AI Audit
4. Policy check
5. Spam check
6. Optimization

---

## ETAP 8 — INTEGRATIONS

### Vazifalar

1. Telegram
2. Google Sheets
3. Webhook
4. amoCRM
5. Bitrix24
6. Make
7. Zapier

---

## ETAP 9 — ENGAGEMENT

### Vazifalar

1. Giveaway
2. Referral
3. Gamification
4. Rewards
5. Leaderboard

---

## ETAP 10 — CONTENT + ANALYTICS

### Vazifalar

1. Post scheduler
2. Reels scheduler
3. Content calendar
4. Campaign analytics
5. AI analytics
6. Sales analytics
7. Conversion analytics

---

## ETAP 11 — MIGRATION

```text
ManyChat
↓
Mapping
↓
Preview
↓
Import
↓
Test
↓
Activate
```

---

## ETAP 12 — MCP

```text
Claude / ChatGPT
↓
SocialAuto MCP
↓
Read / Analyze / Create / Modify
```

---

# 64. TESTING STRATEGY

Har bir major module uchun:

## Unit Tests

Business logic.

## Integration Tests

Meta/API/DB/Queue interactions.

## E2E Tests

Real user scenarios.

### Asosiy E2E

#### Scenario A — Comment

```text
User comments “narx”
→ Comment trigger
→ DM
→ Reply
→ Lead
```

#### Scenario B — AI

```text
User asks price
→ AI answers
→ asks qualification question
→ receives phone
→ saves lead
```

#### Scenario C — Handoff

```text
User asks for manager
→ AI handoff
→ operator notified
→ AI paused
```

#### Scenario D — Token

```text
Token expires
→ system detects
→ connection status changes
→ user notified
→ reconnect
```

#### Scenario E — Rate limit

```text
Rate limit
→ queue
→ backoff
→ retry
→ success
```

---

# 65. OBSERVABILITY

Production uchun:

- logs;
- metrics;
- traces;
- queue health;
- API latency;
- Meta error rate;
- AI latency;
- AI token/cost usage;
- message success rate;
- webhook delay.

### Dashboard KPI

```text
Instagram Connections
Active Campaigns
Messages/min
Queue
Errors
AI Conversations
Leads
Hot Leads
Conversions
```

---

# 66. AI COST CONTROL

AI juda ko‘p ishlatilganda xarajat oshadi.

Shuning uchun:

- model routing;
- token limits;
- conversation summarization;
- caching;
- fallback models;
- max context;
- per-tenant AI usage;
- usage alerts

qo‘shilishi kerak.

---

# 67. DATA MODEL — MINIMAL ENTITYLAR

Tizim konseptual ravishda quyidagi entitylarga ega bo‘ladi:

```text
User
Workspace / Company
InstagramAccount
InstagramToken
Campaign
Trigger
Flow
FlowNode
Contact
Conversation
Message
Lead
LeadScore
Tag
Segment
Operator
Assignment
KnowledgeBase
KnowledgeDocument
AIConversation
Webhook
Integration
Subscription
Usage
QueueJob
AuditLog
Notification
```

Aniq schema existing architecture auditidan keyin belgilanadi.

---

# 68. MULTI-TENANCY

SocialAuto SaaS bo‘lgani uchun:

```text
Platform
 ├── Company A
 │    ├── Instagram
 │    ├── Contacts
 │    ├── Campaigns
 │    └── AI Data
 │
 └── Company B
      ├── Instagram
      ├── Contacts
      ├── Campaigns
      └── AI Data
```

ma’lumotlari qat’iy ajratiladi.

---

# 69. “NIMALARNI QO‘SHMAYMIZ?”

Platformani keraksiz funksiyalar bilan og‘irlashtirmaymiz.

Har bir yangi feature quyidagi savollardan o‘tadi:

1. Instagram automation qiymatini oshiradimi?
2. AI interactionni yaxshilaydimi?
3. Lead generationga yordam beradimi?
4. Sales conversionni yaxshilaydimi?
5. Local market uchun muhimmi?

Agar barchasiga javob yo‘q bo‘lsa:

> Feature keyinga qoldiriladi yoki umuman qo‘shilmaydi.

---

# 70. MUHIM PRODUCT DIFFERENTIATION

SocialAuto raqobatchilarni shunchaki nusxalamasligi kerak.

## ManyChat’dan farqi

- soddaroq UI;
- Uzbek;
- Uzbek Cyrillic;
- Russian;
- local support;
- local pricing;
- Telegram-centric workflow;
- Click/Payme direction;
- AI sales agent;
- transparent UX;
- diagnostics;
- local templates.

## ChatPlace / AI tools’dan farqi

- deep Instagram automation;
- CRM;
- human handoff;
- local language;
- local sales workflow;
- flow builder;
- integrations;
- analytics.

---

# 71. YAKUNIY BUSINESS FLOW

```text
                    INSTAGRAM
                        │
        ┌───────────────┼────────────────┐
        │               │                │
     Comment          Direct           Story
        │               │                │
        └───────────────┼────────────────┘
                        ↓
               AUTOMATION ENGINE
                        ↓
                     JAVOBAI
                        ↓
            BUSINESS KNOWLEDGE BASE
                        ↓
                 LEAD QUALIFICATION
                        ↓
                    LEAD SCORE
                        ↓
                 ┌──────┴──────┐
                 │             │
              CRM/Lead      Operator
                 │             │
                 └──────┬──────┘
                        ↓
                     TELEGRAM
                        ↓
                       SALE
```

Qo‘shimcha triggerlar:

```text
LIVE
ADS
REFERRAL
GIVEAWAY
```

ham shu ecosystemga ulanadi.

---

# 72. SOCIALAUTO’NING ASOSIY QIYMAT TAKLIFI

### Eski model

```text
Comment
↓
DM
```

### Yangi model

```text
Comment / Direct / Story / Live / Ads
                    ↓
              AI Conversation
                    ↓
              Lead Qualification
                    ↓
                   CRM
                    ↓
                Operator
                    ↓
                  Sale
```

Shuning uchun SocialAuto:

> **Instagram Automation Tool**

emas, balki:

> **Instagram-to-Sale AI Platform**

sifatida rivojlantiriladi.

---

# 73. DEVELOPMENT TEAM UCHUN YAKUNIY QOIDA

Har bir yangi modulni ishlab chiqishda quyidagilar majburiy:

```text
1. Existing code'ni tushunish
2. Existing feature regression bermasligini tekshirish
3. Architecture plan
4. Database impact
5. API impact
6. Security impact
7. Queue impact
8. Error handling
9. Logging
10. Unit tests
11. Integration tests
12. E2E tests
13. Documentation
14. Production readiness
```

**Hech qaysi yangi feature mavjud ishlaydigan feature’ni buzish hisobiga qabul qilinmaydi.**

---

# 74. FINAL SUCCESS CRITERIA

SocialAuto ushbu bosqichga kelganda foydalanuvchi:

### 1.

Instagram akkauntini ulaydi.

### 2.

Comment / Direct / Story / Live / Ads triggerlarini yaratadi.

### 3.

AI yoki Flow Builder orqali avtomation quradi.

### 4.

JavobAI biznes ma’lumotlaridan foydalanib suhbatlashadi.

### 5.

AI foydalanuvchini lead sifatida baholaydi.

### 6.

Contact CRM’da paydo bo‘ladi.

### 7.

HOT lead operatorga beriladi.

### 8.

Operator suhbatni davom ettiradi.

### 9.

Analytics orqali conversion ko‘riladi.

### 10.

Kerak bo‘lsa Telegram / CRM / Sheets / webhook orqali boshqa tizimlarga uzatiladi.

---

# 75. ENG MUHIM 3 PRIORITET

Agar resurs cheklangan bo‘lsa, birinchi navbatda aynan quyidagilar:

## #1 — Reliability

Instagram connection + queue + rate limit + diagnostics.

## #2 — Conversation Automation

Comment 2.0 + Direct + Story + Follow-up + Quick Replies.

## #3 — JavobAI

Knowledge Base + AI Agent + Lead Qualification + Human Handoff.

Shundan keyin CRM, Flow Builder va qolgan growth modullari ketadi.

---

# 76. FINAL PRODUCT VISION

SocialAuto:

> **O‘zbekiston bizneslari uchun Instagram’dan keladigan mijozlarni avtomatik qabul qiladigan, AI bilan suhbatlashadigan, leadlarni saralaydigan, CRM’da boshqaradigan va sotuvga olib boradigan yagona platforma.**

Asosiy formula:

```text
Instagram
→ Automation
→ AI
→ Lead
→ CRM
→ Operator
→ Sale
```

Bu loyiha **ChatPlace yoki ManyChat’ning oddiy nusxasi bo‘lib qolmasligi** kerak.

Asosiy ustunlik:

```text
Simple UX
+
Local Language
+
Local Market
+
Instagram Automation
+
AI Sales Agent
+
CRM
+
Telegram
+
Reliable Infrastructure
```

---

# 77. MUHIM ESLATMA

Ushbu hujjatda keltirilgan platforma qoidalari, messaging window, API imkoniyatlari va limitlar development vaqtida amaldagi Meta hujjatlari bilan yana tekshirilishi kerak.

Texnik implementatsiyada:

> **“Official API ishlatilsa, bloklanish mutlaqo bo‘lmaydi”**

degan kafolat berilmaydi.

To‘g‘ri yondashuv:

```text
Official API
+
Policy-aware automation
+
Rate limiting
+
Queue
+
Backoff
+
Duplicate protection
+
Safe messaging
```

---

# 78. YAKUNIY XULOSA

SocialAuto development’ining eng to‘g‘ri yo‘li:

```text
STABILITY
   ↓
COMMENT AUTOMATION 2.0
   ↓
FULL INSTAGRAM AUTOMATION
   ↓
JAVOBAI
   ↓
CRM / LEAD MANAGEMENT
   ↓
FLOW BUILDER
   ↓
AI FLOW BUILDER
   ↓
INTEGRATIONS
   ↓
GROWTH FEATURES
   ↓
ANALYTICS / SCALE
   ↓
MIGRATION
   ↓
MCP / AI CONTROL
```

**Asosiy strategiya:** avval mavjud SocialAuto’ni buzmasdan professional foundation yaratish, keyin Instagram interactionlarini kengaytirish, undan keyin JavobAI va CRM’ni qurish, so‘ng advanced automation va AI boshqaruvni qo‘shish.

Shu tartib SocialAuto’ni oddiy Instagram DM avtomatizatsiyasidan:

> **O‘zbekiston bozori uchun to‘liq AI Sales Automation Platform**

darajasiga olib chiqadi.
