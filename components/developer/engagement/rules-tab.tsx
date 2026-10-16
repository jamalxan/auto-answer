"use client";

/**
 * "Qoidalar (Meta)": the nine things the platform cannot do or does only
 * partly, phrased for the owner. Static on purpose: no hidden state.
 */

const CAVEATS: Array<{ title: string; body: string; tone: "no" | "partly" | "info" }> = [
  {
    title: "1. Yoqtirish, saqlash, ulashish tekshirilmaydi",
    body: "Instagram bunday ma'lumotni bermaydi. Bu shartlarni post matniga yozishingiz mumkin, lekin g'olib tanlashda hisobga olinmaydi — va biz ularni tekshirgandek ko'rsatmaymiz.",
    tone: "no",
  },
  {
    title: "2. Boshqa akkauntga obunani tekshirib bo'lmaydi",
    body: "Faqat o'zingizning akkauntingizga obuna bo'lishni tekshirish mumkin. Hamkor akkauntga obuna sharti ishlamaydi.",
    tone: "no",
  },
  {
    title: "3. Do'stlarni belgilash — faqat matn",
    body: "Izohdagi @username matni sanaladi. Belgilangan odamlar haqiqiy yoki boshqa odamligi tekshirilmaydi; bir xil odamlarni qayta belgilash «farqli do'stlar» hisobida bitta bo'ladi.",
    tone: "partly",
  },
  {
    title: "4. Story'da belgilash — faqat bizga yetib kelgani",
    body: "Story-mention faqat ochiq akkauntlardan yoki sizning obunachilaringizdan keladi. Yopiq akkaunt egasi belgilasa ham bizga xabar kelmasligi mumkin.",
    tone: "partly",
  },
  {
    title: "5. Obunani tekshirish — imkon qadar",
    body: "Instagram ba'zan «obuna emas» yoki «ha» deb ham, hech narsa demasdan ham javob beradi (ayniqsa faqat izoh yozganlar uchun). Bunday ishtirokchilar «Tasdiqlab bo'lmadi» bo'ladi: siz «Menga ko'rsating», «Qabul qilish» yoki «Chetlatish»ni tanlaysiz. Tavsiya — ko'rsatish va ro'yxatni bir tugma bilan qabul qilish.",
    tone: "partly",
  },
  {
    title: "6. Eski izohlarni yuklash chegarasi",
    body: "Giveaway faollashganda postdagi eski izohlar Instagram'dan yuklanadi, lekin bir postdan ko'pi bilan 5 000 ta izoh olinadi, obuna tekshiruvi soniyasiga 2 ta so'rov bilan boradi — katta postda bir necha daqiqa ketadi. Yangi izohlar jonli yig'iladi.",
    tone: "info",
  },
  {
    title: "7. Bir izohga bitta shaxsiy javob",
    body: "Instagram bitta izohga faqat bitta shaxsiy javob (DM) ruxsat beradi. Shuning uchun «Qatnashishingiz qabul qilindi» xabarini faqat tanlangan Comment 2.0 kampaniyasi yuboradi; giveaway o'zi bunday DM yubormaydi.",
    tone: "info",
  },
  {
    title: "8. G'olibga xabar — 24 soatlik oyna qoidasi",
    body: "Direct faqat odam oxirgi 24 soat ichida yozgan bo'lsa ketadi. Oyna yopiq bo'lsa izoh ostida bitta ochiq javob («@username tabriklaymiz! Direct'ga yozing») qoldiriladi. G'oliblar ro'yxati har doim sizga Telegram'ga ham keladi.",
    tone: "info",
  },
  {
    title: "9. Referral havolasi: Icebreakers va telefon ilovasi",
    body: "ig.me havolasi yangi suhbatni faqat Icebreakers sozlangan bo'lsa va telefon ilovasida ochadi; Instagram Web'da ishlamaydi. Taklif birinchi xabarda hisoblanadi; birinchi havola g'olib; o'zini o'zi taklif qilish, bir telefon, kuniga limitdan ko'p va allaqachon tanish kontakt — shubhali deb belgilanib, sizning tasdig'ingizni kutadi. Izoh uchun ball sukut bo'yicha o'chiq.",
    tone: "info",
  },
];

const TONE_CLASS = { no: "text-error", partly: "text-warning", info: "text-muted" } as const;
const TONE_LABEL = { no: "Tekshirib bo'lmaydi", partly: "Qisman", info: "Bilib qo'ying" } as const;

export default function RulesTab() {
  return (
    <section className="space-y-3" aria-label="Meta qoidalari">
      <p className="text-sm text-muted">
        Instagram (Meta) platformasining cheklovlari — giveaway va referral shularga mos tuzilgan. Ular qoidalar tanlashda ham ko&apos;rsatib turiladi.
      </p>
      <ul className="space-y-3">
        {CAVEATS.map((c) => (
          <li key={c.title} className="panel space-y-1 rounded-xl p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-foreground">{c.title}</h2>
              <span className={`label-mono text-[10px] font-semibold ${TONE_CLASS[c.tone]}`}>{TONE_LABEL[c.tone]}</span>
            </div>
            <p className="text-sm text-muted">{c.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
