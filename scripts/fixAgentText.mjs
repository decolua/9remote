// One-shot: replace "agent" (host program) with "9Remote host" in non-en web locales.
// Keeps existing translations, only swaps the agent-word for the untranslated brand.
// Keys: updateAvailableTitle, approvalDescription, rejectedDescription.
// Run: node scripts/fixAgentText.mjs
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCALES_DIR = join(ROOT, "web", "shared", "i18n", "locales");

// Brand "9Remote host" stays untranslated in every locale.
const UPDATES = {
  ar: {
    updateAvailableTitle: "9Remote host update available",
    approvalDescription: "يحتاج 9Remote host إلى الموافقة على هذا الجهاز قبل أن تتمكن من الاتصال.",
    rejectedDescription: "لم يتم اعتماد هذا الجهاز من قبل 9Remote host.",
  },
  de: {
    updateAvailableTitle: "9Remote host update available",
    approvalDescription: "Der 9Remote host muss dieses Gerät genehmigen, bevor Sie sich verbinden können.",
    rejectedDescription: "Dieses Gerät wurde vom 9Remote host nicht genehmigt.",
  },
  es: {
    updateAvailableTitle: "9Remote host update available",
    approvalDescription: "El 9Remote host debe aprobar este dispositivo antes de poder conectarte.",
    rejectedDescription: "Este dispositivo no fue aprobado por el 9Remote host.",
  },
  fa: {
    updateAvailableTitle: "9Remote host update available",
    approvalDescription: "9Remote host باید این دستگاه را قبل از اتصال شما تأیید کند.",
    rejectedDescription: "این دستگاه توسط 9Remote host تأیید نشد.",
  },
  fr: {
    updateAvailableTitle: "9Remote host update available",
    approvalDescription: "Le 9Remote host doit approuver cet appareil avant que vous puissiez vous connecter.",
    rejectedDescription: "Cet appareil n'a pas été approuvé par le 9Remote host.",
  },
  he: {
    updateAvailableTitle: "9Remote host update available",
    approvalDescription: "9Remote host צריך לאשר מכשיר זה לפני שתוכל להתחבר.",
    rejectedDescription: "מכשיר זה לא אושר על ידי 9Remote host.",
  },
  hi: {
    updateAvailableTitle: "9Remote host update available",
    approvalDescription: "आप कनेक्ट करने से पहले 9Remote host को इस डिवाइस को अनुमोदित करना होगा।",
    rejectedDescription: "इस डिवाइस को 9Remote host द्वारा अनुमोदित नहीं किया गया।",
  },
  id: {
    updateAvailableTitle: "9Remote host update available",
    approvalDescription: "9Remote host perlu menyetujui perangkat ini sebelum Anda dapat terhubung.",
    rejectedDescription: "Perangkat ini tidak disetujui oleh 9Remote host.",
  },
  it: {
    updateAvailableTitle: "9Remote host update available",
    approvalDescription: "Il 9Remote host deve approvare questo dispositivo prima che tu possa connetterti.",
    rejectedDescription: "Questo dispositivo non è stato approvato dal 9Remote host.",
  },
  ja: {
    updateAvailableTitle: "9Remote host update available",
    approvalDescription: "接続する前に 9Remote host がこのデバイスを承認する必要があります。",
    rejectedDescription: "このデバイスは 9Remote host によって承認されませんでした。",
  },
  ko: {
    updateAvailableTitle: "9Remote host update available",
    approvalDescription: "연결하기 전에 9Remote host가 이 기기를 승인해야 합니다.",
    rejectedDescription: "이 기기는 9Remote host에 의해 승인되지 않았습니다.",
  },
  ms: {
    updateAvailableTitle: "9Remote host update available",
    approvalDescription: "9Remote host perlu meluluskan peranti ini sebelum anda boleh menyambung.",
    rejectedDescription: "Peranti ini tidak diluluskan oleh 9Remote host.",
  },
  nl: {
    updateAvailableTitle: "9Remote host update available",
    approvalDescription: "De 9Remote host moet dit apparaat goedkeuren voordat u verbinding kunt maken.",
    rejectedDescription: "Dit apparaat is niet goedgekeurd door de 9Remote host.",
  },
  pl: {
    updateAvailableTitle: "9Remote host update available",
    approvalDescription: "9Remote host musi zatwierdzić to urządzenie, zanim się połączysz.",
    rejectedDescription: "To urządzenie nie zostało zatwierdzone przez 9Remote host.",
  },
  pt: {
    updateAvailableTitle: "9Remote host update available",
    approvalDescription: "O 9Remote host precisa aprovar este dispositivo antes que você possa se conectar.",
    rejectedDescription: "Este dispositivo não foi aprovado pelo 9Remote host.",
  },
  ru: {
    updateAvailableTitle: "9Remote host update available",
    approvalDescription: "9Remote host должен подтвердить это устройство, прежде чем вы сможете подключиться.",
    rejectedDescription: "Это устройство не было подтверждено 9Remote host.",
  },
  sv: {
    updateAvailableTitle: "9Remote host update available",
    approvalDescription: "9Remote host måste godkänna den här enheten innan du kan ansluta.",
    rejectedDescription: "Den här enheten godkändes inte av 9Remote host.",
  },
  th: {
    updateAvailableTitle: "9Remote host update available",
    approvalDescription: "9Remote host ต้องอนุมัติอุปกรณ์นี้ก่อนคุณจึงจะเชื่อมต่อได้",
    rejectedDescription: "อุปกรณ์นี้ไม่ได้รับการอนุมัติจาก 9Remote host",
  },
  tr: {
    updateAvailableTitle: "9Remote host update available",
    approvalDescription: "Bağlanmadan önce 9Remote host'in bu cihazı onaylaması gerekiyor.",
    rejectedDescription: "Bu cihaz 9Remote host tarafından onaylanmadı.",
  },
  uk: {
    updateAvailableTitle: "9Remote host update available",
    approvalDescription: "9Remote host повинен схвалити цей пристрій, перш ніж ви зможете підключитися.",
    rejectedDescription: "Цей пристрій не був схвалений 9Remote host.",
  },
  vi: {
    updateAvailableTitle: "Có bản cập nhật 9Remote host",
    approvalDescription: "9Remote host cần phê duyệt thiết bị này trước khi bạn có thể kết nối.",
    rejectedDescription: "Thiết bị này không được 9Remote host phê duyệt.",
  },
  zh: {
    updateAvailableTitle: "9Remote host update available",
    approvalDescription: "在您连接之前，9Remote host 需要批准此设备。",
    rejectedDescription: "此设备未被 9Remote host 批准。",
  },
};

const files = readdirSync(LOCALES_DIR).filter(
  (f) => f.endsWith(".js") && f !== "index.js" && f !== "en.js"
);

let total = 0;
for (const file of files) {
  const code = file.replace(".js", "");
  const updates = UPDATES[code];
  if (!updates) {
    console.warn(`⚠ ${file}: no updates defined, skipped`);
    continue;
  }
  const path = join(LOCALES_DIR, file);
  let content = readFileSync(path, "utf8");
  let changed = 0;
  for (const [key, value] of Object.entries(updates)) {
    const re = new RegExp(`(${key}:\\s*")[^"]*(")`);
    if (!re.test(content)) {
      console.warn(`⚠ ${file}: key "${key}" not found`);
      continue;
    }
    content = content.replace(re, (_m, p1, p2) => `${p1}${value}${p2}`);
    changed++;
  }
  writeFileSync(path, content);
  console.log(`✓ ${file}: ${changed} key(s)`);
  total += changed;
}
console.log(`Done. ${total} keys across ${files.length} locales.`);
