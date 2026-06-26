require("dotenv").config();
const express = require("express");
const cors = require("cors");
const imaps = require("imap-simple");
const simpleParser = require("mailparser").simpleParser;
const pdfParse = require("pdf-parse"); // 🚀 EKSİKTİ, EKLENDİ! Yoksa sunucu çökerdi.

const { initializeApp, cert } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");

const app = express();
const PORT = process.env.PORT || 10000;

// İzinler
app.use(cors({ origin: "*" }));
app.use(express.json());

// --- 1. FIREBASE ADMIN KURULUMU ---
if (!process.env.FIREBASE_CREDENTIALS) {
  console.error("HATA: FIREBASE_CREDENTIALS Render'a eklenmemiş!");
}

const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
const firebaseApp = initializeApp({
  credential: cert(serviceAccount),
  databaseURL: "https://olimpiyatkokorecmenu-default-rtdb.europe-west1.firebasedatabase.app",
});
const database = getDatabase(firebaseApp);

// --- 2. GMAIL IMAP BAĞLANTI AYARLARI ---
const imapConfig = {
  imap: {
    user: process.env.EMAIL_USER, 
    password: process.env.EMAIL_PASSWORD, 
    host: "imap.gmail.com",
    port: 993,
    tls: true,
    authTimeout: 5000,
    tlsOptions: { rejectUnauthorized: false },
  },
};

// --- ANA ROTA: ÇİFT MOTORLU MAİL OKUYUCU ---
app.post("/api/fetch-latest-ekstreler", async (req, res) => {
  try {
    console.log("Çekim emri alındı. Gmail aranıyor...");
    const connection = await imaps.connect(imapConfig);
    await connection.openBox("INBOX");

    // 1. Enpara'dan gelen tüm mailleri bul
    const searchCriteria = ["ALL", ["FROM", "enpara@enpara.com"]];
    const messages = await connection.search(searchCriteria, { bodies: [""], markSeen: false });
    
    if (messages.length === 0) {
      connection.end();
      return res.json({ success: false, error: "Gelen kutusunda Enpara maili bulunamadı." });
    }

    const processedItems = {};
    let itemIndex = 0;
    let ekstreID = null;
    let ayAdi = "";

    // 2. TÜM MAİLLERİ TARA (Yeniden Eskiye Doğru)
    for (let i = messages.length - 1; i >= 0; i--) {
        const rawEmail = messages[i].parts.find(p => p.which === "").body;
        const mail = await simpleParser(rawEmail);
        
        // Sadece Ekstre ve Hesap Özeti maillerini işleme sok, diğerlerini (reklam vb) atla
        if (!mail.subject.includes("ekstreniz") && !mail.subject.includes("Hesap Özeti")) continue;

        const pdfAtt = mail.attachments.find(a => a.filename.endsWith('.pdf'));
        if (!pdfAtt) continue;

        const pdfData = await pdfParse(pdfAtt.content);
        const text = pdfData.text;

        // --- TARİH TESPİTİ (Ekstre mailinden ay/yıl bilgisini koparır) ---
        if (mail.subject.includes("ekstreniz") && !ekstreID) {
            const dateMatch = text.match(/Ekstre tarihi[\s\S]*?(\d{2}\/\d{2}\/\d{4})/i);
            if (dateMatch) {
                const [, m, y] = dateMatch[1].split("/");
                ekstreID = `${y}-${m}`;
                const ayIsimleri = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
                ayAdi = ayIsimleri[parseInt(m) - 1];
            }
        }

        // --- MOTOR 1: SGK VE HESAP ÖZETİ ---
        if (text.includes("SGK Ödemesi") || text.includes("Hesap Özeti")) {
            text.split('\n').forEach(line => {
                if (line.toLowerCase().includes("sgk") || line.toLowerCase().includes("prim")) {
                    const sgkMatch = line.match(/(.*SGK.*?)[\s]+([\d\.,]+)\s*TL/i);
                    if (sgkMatch) {
                        processedItems[`item_${itemIndex++}`] = {
                            date: new Date().toLocaleDateString("tr-TR"), // Eklendiği günün tarihi
                            time: "Otomatik SGK",
                            desc: sgkMatch[1].trim(),
                            amount: parseFloat(sgkMatch[2].replace(/\./g, "").replace(",", ".")),
                            category: "dukkan" // 🚀 Doğrudan dükkana
                        };
                    }
                }
            });
        }

        // --- MOTOR 2: KREDİ KARTI EKSTRESİ ---
        if (mail.subject.includes("ekstreniz")) {
            const cleanText = text.replace(/["\n\r]/g, " ").replace(/\s{2,}/g, " ");
            const parts = cleanText.split(/(?=\d{2}\/\d{2}\/\d{4})/);
            
            parts.forEach((part) => {
                const dateMatch = part.match(/^(\d{2}\/\d{2}\/\d{4})/);
                if (!dateMatch) return;

                const amountMatches = [...part.matchAll(/(-?\s*\d{1,3}(?:[.,]\d{3})*[.,]\d{2})\s*TL/gi)];
                if (amountMatches.length === 0) return;

                const lastAmountMatch = amountMatches[amountMatches.length - 1];
                const amountStr = lastAmountMatch[1];
                const desc = part.substring(dateMatch[1].length, lastAmountMatch.index).trim();

                if (desc.toLowerCase().includes("ödeme") || desc.toLowerCase().includes("önceki ekstre")) return;

                let rawAmount = amountStr.replace(/\s/g, "");
                const kurusIndex = rawAmount.length - 3;
                if (rawAmount[kurusIndex] === "." || rawAmount[kurusIndex] === ",") {
                    rawAmount = rawAmount.substring(0, kurusIndex).replace(/[.,]/g, "") + "." + rawAmount.substring(kurusIndex + 1);
                }

                const descLower = desc.toLowerCase();
                let assignedCategory = "ev";

                // 🚀 EKSİKSİZ DÜKKAN FİLTREN BURADA
                if (
                    descLower.includes("is net elektron") ||
                    descLower.includes("umraniye v.d") ||
                    descLower.includes("2163357920") ||
                    descLower.includes("7040551588") ||
                    descLower.includes("faiz") ||
                    descLower.includes("bsmv") ||
                    descLower.includes("kkdf")
                ) {
                    assignedCategory = "dukkan";
                }

                processedItems[`item_${itemIndex++}`] = {
                    date: dateMatch[1],
                    time: "--:--",
                    desc: desc,
                    amount: parseFloat(rawAmount),
                    category: assignedCategory,
                };
            });
        }
    }
    connection.end(); // İş bitti, Gmail kapısını kapat

    // Eğer sistem Kredi Kartı Ekstresi bulamadıysa (sadece Hesap Özeti varsa) yılı ve ayı bugünden al
    if (!ekstreID) {
        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        ekstreID = `${y}-${m}`;
        const ayIsimleri = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
        ayAdi = ayIsimleri[now.getMonth()];
    }

    if (itemIndex === 0) {
        return res.json({ success: false, error: "Ekstreler okundu ama harcama bulunamadı." });
    }

    // FİREBASE'E TEK SEFERDE BİRLEŞİK YAZ
    await database.ref(`ekstreler/${ekstreID}`).set({
        title: `${ayAdi} Enpara İşlemleri`,
        createdAt: Date.now(),
        items: processedItems,
    });

    console.log("Firebase yazma işlemi başarılı!");
    res.json({ success: true, message: `✅ ${ayAdi} ayına ait Kredi Kartı ve Hesap Özeti başarıyla çekilip birleştirildi!` });
  } catch (error) {
    console.error("Beklenmeyen Hata:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Olimpiyat Arka Uç (Backend) İşçisi ${PORT} portunda çalışıyor!`);
});
