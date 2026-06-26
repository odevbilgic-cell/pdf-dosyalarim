require("dotenv").config();
const express = require("express");
const cors = require("cors");
const imaps = require("imap-simple");
const simpleParser = require("mailparser").simpleParser;
const pdfParse = require("pdf-parse"); // PDF okuyucu en üste eklendi

const { initializeApp, cert } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");

const app = express();
const PORT = process.env.PORT || 10000;

// İzinler (Frontend sitenin bu arka kapıya erişebilmesi için)
app.use(cors({ origin: "*" }));
app.use(express.json());

// --- 1. FIREBASE ADMIN KURULUMU (GÜVENLİ KASA YÖNTEMİ) ---
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
    authTimeout: 3000,
    tlsOptions: { rejectUnauthorized: false },
  },
};

// --- ANA ROTA: MAİLLERİ ÇEK, ÇEVİRMENDEN GEÇİR, PDF'LERİ OKU VE KAYDET ---
app.post("/api/fetch-latest-ekstreler", async (req, res) => {
  try {
    console.log("Ekstre çekim emri alındı. Gmail'e bağlanılıyor...");
    const connection = await imaps.connect(imapConfig);
    await connection.openBox("INBOX");

    // ================================================================
    // 1. KREDİ KARTI EKSTRESİ MAİLİNİ BUL (Senin Orijinal Kodun)
    // ================================================================
    const searchCriteria = ["ALL", ["FROM", "enpara@enpara.com"], ["SUBJECT", "ekstreniz"]];
    const messages = await connection.search(searchCriteria, { bodies: [""], markSeen: false });
    
    if (messages.length === 0) {
      connection.end();
      return res.json({ success: false, error: "Gelen kutusunda hiç Enpara ekstresi bulunamadı." });
    }

    const latestMessage = messages[messages.length - 1];
    const rawEmailData = latestMessage.parts.find((part) => part.which === "").body;

    // ================================================================
    // 2. HESAP ÖZETİ MAİLİNİ BUL (YENİ EKLENEN KISIM)
    // ================================================================
    const ozetSearchCriteria = ["ALL", ["FROM", "enpara@enpara.com"], ["SUBJECT", "Hesap Özeti"]];
    const ozetMessages = await connection.search(ozetSearchCriteria, { bodies: [""], markSeen: false });
    
    let rawOzetData = null;
    if (ozetMessages.length > 0) {
        // En son gelen hesap özeti mailini al
        rawOzetData = ozetMessages[ozetMessages.length - 1].parts.find((part) => part.which === "").body;
    }

    connection.end(); // Bağlantıyı kapatabiliriz

    console.log("Mailler bulundu. Çevirmen (Mailparser) PDF'i ayıklıyor...");

    // ================================================================
    // 3. KREDİ KARTI PDF'İNİ OKU VE FIREBASE KONTROLÜ YAP (Senin Orijinal Kodun)
    // ================================================================
    const parsedEmail = await simpleParser(rawEmailData);
    const pdfAttachment = parsedEmail.attachments.find((att) => att.contentType === "application/pdf" || att.filename.endsWith(".pdf"));

    if (!pdfAttachment) {
      return res.json({ success: false, error: "Ekstre maili bulundu ama içinde PDF eki tespit edilemedi!" });
    }

    const pdfBuffer = pdfAttachment.content;
    const pdfData = await pdfParse(pdfBuffer);
    const text = pdfData.text;

    const dateMatch = text.match(/Ekstre tarihi[\s\S]*?(\d{2}\/\d{2}\/\d{4})/i);
    if (!dateMatch) {
      return res.json({ success: false, error: "PDF formatı anlaşılamadı, ekstre tarihi bulunamıyor." });
    }

    const ekstreTarihiStr = dateMatch[1];
    const [, month, year] = ekstreTarihiStr.split("/");
    const ekstreID = `${year}-${month}`; // "2026-06" (Firebase için benzersiz ID)

    const dbRef = database.ref(`ekstreler/${ekstreID}`);
    const snapshot = await dbRef.once("value");
    if (snapshot.exists()) {
      return res.json({ success: true, message: `⚠️ ${month}. Ay ${year} ekstresi zaten sistemde kayıtlı. Es geçildi!` });
    }

    const processedItems = {};
    let itemIndex = 0;

    // ================================================================
    // 4. KREDİ KARTI İŞLEME MOTORU (SENİN KUSURSUZ KODUN - HİÇ DOKUNULMADI)
    // ================================================================
    const cleanText = text.replace(/["\n\r]/g, " ").replace(/\s{2,}/g, " ");
    const parts = cleanText.split(/(?=\d{2}\/\d{2}\/\d{4})/);

    parts.forEach((part) => {
      const partDateMatch = part.match(/^(\d{2}\/\d{2}\/\d{4})/);
      if (!partDateMatch) return;

      const date = partDateMatch[1];
      const amountMatches = [...part.matchAll(/(-?\s*\d{1,3}(?:[.,]\d{3})*[.,]\d{2})\s*TL/gi)];
      if (amountMatches.length === 0) return;

      const lastAmountMatch = amountMatches[amountMatches.length - 1];
      const amountStr = lastAmountMatch[1];

      const desc = part.substring(date.length, lastAmountMatch.index).trim();

      if (desc.toLowerCase().includes("ödeme") || desc.toLowerCase().includes("önceki ekstre")) return;

      let rawAmount = amountStr.replace(/\s/g, "");
      const kurusIndex = rawAmount.length - 3;
      if (rawAmount[kurusIndex] === "." || rawAmount[kurusIndex] === ",") {
        rawAmount = rawAmount.substring(0, kurusIndex).replace(/[.,]/g, "") + "." + rawAmount.substring(kurusIndex + 1);
      }

      const amount = parseFloat(rawAmount);
      if (isNaN(amount)) return;

      const descLower = desc.toLowerCase();
      let assignedCategory = "ev";

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

      processedItems[`item_${itemIndex}`] = {
        date: date,
        time: "--:--",
        desc: desc,
        amount: amount,
        category: assignedCategory,
      };
      itemIndex++;
    });

    // ================================================================
    // 5. HESAP ÖZETİ MOTORU (YENİ EKLENDİ - SADECE SGK ÇEKER)
    // ================================================================
    if (rawOzetData) {
        console.log("Hesap özeti maili işleniyor, sadece SGK aranacak...");
        const parsedOzetEmail = await simpleParser(rawOzetData);
        const ozetPdfAtt = parsedOzetEmail.attachments.find((att) => att.contentType === "application/pdf" || att.filename.endsWith(".pdf"));
        
        if (ozetPdfAtt) {
            const ozetPdfData = await pdfParse(ozetPdfAtt.content);
            const cleanOzetText = ozetPdfData.text.replace(/["\n\r]/g, " ").replace(/\s{2,}/g, " ");
            
            // Hesap özetinde tarihler (05/05/26) formatında kısa gelebilir
            const ozetParts = cleanOzetText.split(/(?=\d{2}\/\d{2}\/\d{2,4})/);

            ozetParts.forEach((part) => {
                // KURAL: EĞER BU PARÇADA "SGK" KELİMESİ YOKSA HİÇ İŞLEME SOKMA!
                if (!part.toLowerCase().includes("sgk")) return;

                const ozetDateMatch = part.match(/^(\d{2}\/\d{2}\/\d{2,4})/);
                if (!ozetDateMatch) return;

                const date = ozetDateMatch[1];
                
                // Hesap özetinde satırda birden fazla TL olabilir, bize her zaman ilki (işlem tutarı) lazım
                const amountMatches = [...part.matchAll(/([\d]{1,3}(?:[.,]\d{3})*[.,]\d{2})\s*TL/gi)];
                if (amountMatches.length === 0) return;

                const firstAmountMatch = amountMatches[0];
                const amountStr = firstAmountMatch[1];

                // Açıklama kısmı
                let desc = part.substring(date.length, firstAmountMatch.index).trim();
                desc = desc.replace(/^,?\s*Ödeme,?\s*/i, '').replace(/,\s*$/g, '').trim();

                let rawAmount = amountStr.replace(/\s/g, "");
                const kurusIndex = rawAmount.length - 3;
                if (rawAmount[kurusIndex] === "." || rawAmount[kurusIndex] === ",") {
                    rawAmount = rawAmount.substring(0, kurusIndex).replace(/[.,]/g, "") + "." + rawAmount.substring(kurusIndex + 1);
                }

                const amount = parseFloat(rawAmount);
                if (!isNaN(amount)) {
                    // Bulunan SGK bilgisini ANA LİSTEYE dahil ediyoruz
                    processedItems[`item_${itemIndex}`] = {
                        date: date,
                        time: "Hesap Özeti", // Nereden çekildiğini görmek için
                        desc: desc,
                        amount: amount,
                        category: "dukkan", // KURAL: ZORUNLU DÜKKAN
                    };
                    itemIndex++;
                }
            });
        }
    }

    // Eğer hiçbir satır bulunamazsa
    if (itemIndex === 0) {
      return res.json({ success: false, error: "Node.js Hatası: PDF okundu ama harcama bulunamadı." });
    }

    // ================================================================
    // 6. FIREBASE'E KAYDETME (HER İKİSİNİN TOPLAMI)
    // ================================================================
    const ayIsimleri = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
    const ayAdi = ayIsimleri[parseInt(month) - 1];

    await dbRef.set({
      title: `${ayAdi} ${year} Ekstre ve Özet`, // İkisinin birleştiği belli olsun
      createdAt: Date.now(),
      items: processedItems,
    });

    console.log(`Bitti! ${ayAdi} verileri Firebase'e başarıyla yazıldı.`);
    return res.json({
      success: true,
      message: `✅ ${ayAdi} ${year} verileri başarıyla çekildi. Kredi Kartı ve SGK Harcamaları toplam ${itemIndex} kalem olarak sisteme işlendi!`,
    });
  } catch (error) {
    console.error("Beklenmeyen Hata:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Olimpiyat Arka Uç (Backend) İşçisi ${PORT} portunda çalışıyor!`);
});
