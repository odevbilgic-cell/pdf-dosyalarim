require("dotenv").config();
const express = require("express");
const cors = require("cors");
const imaps = require("imap-simple");
const simpleParser = require("mailparser").simpleParser;

const { initializeApp, cert } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");

const app = express();
const PORT = process.env.PORT || 10000;

// İzinler (Frontend sitenin bu arka kapıya erişebilmesi için)
app.use(cors({ origin: "*" }));
app.use(express.json());

// --- 1. FIREBASE ADMIN KURULUMU (GÜVENLİ KASA YÖNTEMİ) ---
// Dosya kullanmayı bıraktık! Doğrudan Render'ın ortam değişkenlerinden (kasa) çekiyoruz.
if (!process.env.FIREBASE_CREDENTIALS) {
  console.error("HATA: FIREBASE_CREDENTIALS Render'a eklenmemiş!");
}

// Render'a yapıştırdığımız o metni, Node.js kodla JSON objesine çeviriyor
const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);

const firebaseApp = initializeApp({
  credential: cert(serviceAccount),
  databaseURL:
    "https://olimpiyatkokorecmenu-default-rtdb.europe-west1.firebasedatabase.app",
});

const database = getDatabase(firebaseApp);

// --- 2. GMAIL IMAP BAĞLANTI AYARLARI ---

// --- 2. GMAIL IMAP BAĞLANTI AYARLARI ---
const imapConfig = {
  imap: {
    user: process.env.EMAIL_USER, // Render'a girilecek (uguraydin1640@gmail.com)
    password: process.env.EMAIL_PASSWORD, // Render'a girilecek (Google Uygulama Şifresi)
    host: "imap.gmail.com",
    port: 993,
    tls: true,
    authTimeout: 3000,
    tlsOptions: { rejectUnauthorized: false },
  },
};

// --- ANA ROTA: MAİLİ ÇEK, ÇEVİRMENDEN GEÇİR, PDF'İ OKU VE KAYDET ---
app.post("/api/fetch-latest-ekstreler", async (req, res) => {
  try {
    console.log("Çekim emri alındı...");
    const connection = await imaps.connect(imapConfig);
    await connection.openBox("INBOX");

    // 1. MAİLİ BUL (Subject kısmını daha geniş tutalım ki Hesap Özeti'ni de yakalasın)
    const searchCriteria = ["ALL", ["FROM", "enpara@enpara.com"]];
    const messages = await connection.search(searchCriteria, { bodies: [""], markSeen: false });
    
    if (messages.length === 0) {
      connection.end();
      return res.json({ success: false, error: "Mail bulunamadı." });
    }

    const processedItems = {};
    let itemIndex = 0;
    let ekstreID = null;
    let ayAdi = "";

    // 2. TÜM MAİLLERİ TARA
    for (let i = messages.length - 1; i >= 0; i--) {
        const rawEmail = messages[i].parts.find(p => p.which === "").body;
        const mail = await simpleParser(rawEmail);
        const pdfAtt = mail.attachments.find(a => a.filename.endsWith('.pdf'));
        if (!pdfAtt) continue;

        const pdfData = await pdfParse(pdfAtt.content);
        const text = pdfData.text;

        // Tarih/Ay tespiti (Sadece Ekstre mailinden)
        if (mail.subject.includes("ekstreniz") && !ekstreID) {
            const dateMatch = text.match(/Ekstre tarihi[\s\S]*?(\d{2}\/\d{2}\/\d{4})/i);
            if (dateMatch) {
                const [, m, y] = dateMatch[1].split("/");
                ekstreID = `${y}-${m}`;
                const ayIsimleri = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
                ayAdi = ayIsimleri[parseInt(m) - 1];
            }
        }

        // SGK / Hesap Özeti Motoru
        if (text.includes("SGK Ödemesi") || text.includes("Hesap Özeti")) {
            text.split('\n').forEach(line => {
                if (line.toLowerCase().includes("sgk") || line.toLowerCase().includes("prim")) {
                    const sgkMatch = line.match(/(.*SGK.*?)[\s]+([\d\.,]+)\s*TL/i);
                    if (sgkMatch) {
                        processedItems[`item_${itemIndex++}`] = {
                            date: new Date().toLocaleDateString("tr-TR"),
                            time: "Manuel",
                            desc: sgkMatch[1].trim(),
                            amount: parseFloat(sgkMatch[2].replace(/\./g, "").replace(",", ".")),
                            category: "dukkan"
                        };
                    }
                }
            });
        }

        // Kredi Kartı Ekstresi Motoru
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

            processedItems[`item_${itemIndex++}`] = {
                date: dateMatch[1],
                time: "--:--",
                desc: desc,
                amount: parseFloat(rawAmount),
                category: (desc.toLowerCase().includes("is net") || desc.toLowerCase().includes("umraniye")) ? "dukkan" : "ev",
            };
        });
    }
    connection.end();

    if (itemIndex === 0) return res.json({ success: false, error: "Veri bulunamadı." });

    await database.ref(`ekstreler/${ekstreID}`).set({
        title: `${ayAdi} Enpara İşlemleri`,
        createdAt: Date.now(),
        items: processedItems,
    });

    res.json({ success: true, message: "Tüm veriler birleştirildi!" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
