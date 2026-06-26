require("dotenv").config();
const express = require("express");
const cors = require("cors");
const imaps = require("imap-simple");
const simpleParser = require("mailparser").simpleParser;
const pdfParse = require("pdf-parse"); // PDF okuyucuyu en üste taşıdık!

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

    // =======================================================================
    // AŞAMA 1: KREDİ KARTI EKSTRESİNİ BUL VE İŞLE (Senin Orijinal Kodun)
    // =======================================================================
    const searchCriteria = ["ALL", ["FROM", "enpara@enpara.com"], ["SUBJECT", "ekstreniz"]];
    const fetchOptions = { bodies: [""], markSeen: false };

    const messages = await connection.search(searchCriteria, fetchOptions);
    if (messages.length === 0) {
      connection.end();
      return res.json({ success: false, error: "Gelen kutusunda hiç Enpara ekstresi bulunamadı." });
    }

    const latestMessage = messages[messages.length - 1];
    const rawEmailData = latestMessage.parts.find((part) => part.which === "").body;

    const parsedEmail = await simpleParser(rawEmailData);
    const pdfAttachment = parsedEmail.attachments.find(
      (att) => att.contentType === "application/pdf" || att.filename.endsWith(".pdf"),
    );

    if (!pdfAttachment) {
      connection.end();
      return res.json({ success: false, error: "Mail bulundu ama içinde PDF eki tespit edilemedi!" });
    }

    const pdfBuffer = pdfAttachment.content;
    const pdfData = await pdfParse(pdfBuffer);
    const text = pdfData.text;

    const dateMatch = text.match(/Ekstre tarihi[\s\S]*?(\d{2}\/\d{2}\/\d{4})/i);
    if (!dateMatch) {
      connection.end();
      return res.json({ success: false, error: "PDF formatı anlaşılamadı, ekstre tarihi bulunamıyor." });
    }

    const ekstreTarihiStr = dateMatch[1];
    const [, month, year] = ekstreTarihiStr.split("/");
    const ekstreID = `${year}-${month}`; // "2026-06" (Firebase için benzersiz ID)

    const dbRef = database.ref(`ekstreler/${ekstreID}`);
    const snapshot = await dbRef.once("value");
    if (snapshot.exists()) {
      connection.end();
      return res.json({ success: true, message: `⚠️ ${month}. Ay ${year} ekstresi zaten sistemde kayıtlı. Es geçildi!` });
    }

    const cleanText = text.replace(/["\n\r]/g, " ").replace(/\s{2,}/g, " ");
    const parts = cleanText.split(/(?=\d{2}\/\d{2}\/\d{4})/);

    const processedItems = {};
    let itemIndex = 0;

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

      // SENİN DÜKKAN FİLTREN - DOKUNULMADI
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

    // =======================================================================
    // AŞAMA 2: HESAP ÖZETİ MAİLİNİ BUL VE SADECE SGK'YI ÇEK (YENİ SİSTEM)
    // =======================================================================
    console.log("Kredi Kartı Ekstresi işlendi. Şimdi Hesap Özeti maili aranıyor...");
    
    // Konusunda "hesap özetiniz" geçen mailleri ara
    const ozetSearchCriteria = ["ALL", ["FROM", "enpara@enpara.com"], ["SUBJECT", "hesap özetiniz"]];
    const ozetMessages = await connection.search(ozetSearchCriteria, fetchOptions);

    if (ozetMessages.length > 0) {
        const latestOzetMsg = ozetMessages[ozetMessages.length - 1];
        const rawOzetData = latestOzetMsg.parts.find((part) => part.which === "").body;
        const parsedOzetEmail = await simpleParser(rawOzetData);
        
        const ozetPdfAtt = parsedOzetEmail.attachments.find((att) => att.contentType === "application/pdf" || att.filename.endsWith(".pdf"));

        if (ozetPdfAtt) {
            const ozetPdfData = await pdfParse(ozetPdfAtt.content);
            // Kart ekstresindeki aynı kusursuz boşluk silme yöntemini kullanıyoruz
            const cleanOzetText = ozetPdfData.text.replace(/["\n\r]/g, " ").replace(/\s{2,}/g, " ");
            
            // Hesap özetinde tarihler (31/05/26) şeklinde kısa olabilir, o yüzden \d{2,4} kullanıyoruz
            const ozetParts = cleanOzetText.split(/(?=\d{2}\/\d{2}\/\d{2,4})/);

            ozetParts.forEach((part) => {
                // KURAL: Eğer satırda SGK yazmıyorsa hiç işleme sokma, atla!
                if (!part.toLowerCase().includes("4A Prim Borcu SGK Ödemesi")) return;

                const ozetDateMatch = part.match(/^(\d{2}\/\d{2}\/\d{2,4})/);
                if (!ozetDateMatch) return;

                const date = ozetDateMatch[1];
                
                // Hesap özeti PDF'inde 2 tane TL tutarı yazar (Biri çekilen tutar, diğeri kalan bakiye)
                // Biz her zaman ILK parayı alıyoruz (Yani Çekilen Tutarı)
                const amountMatches = [...part.matchAll(/(-?\s*\d{1,3}(?:[.,]\d{3})*[.,]\d{2})\s*TL/gi)];
                if (amountMatches.length === 0) return;

                const firstAmountMatch = amountMatches[0];
                const amountStr = firstAmountMatch[1];
                
                // Açıklama Metni (Örn: "Ödeme, 4A Prim Borcu SGK Ödemesi...")
                let desc = part.substring(date.length, firstAmountMatch.index).trim();
                // Başındaki gereksiz virgülü silelim
                desc = desc.replace(/^,\s*/, '').trim();

                let rawAmount = amountStr.replace(/\s/g, "");
                const kurusIndex = rawAmount.length - 3;
                if (rawAmount[kurusIndex] === "." || rawAmount[kurusIndex] === ",") {
                    rawAmount = rawAmount.substring(0, kurusIndex).replace(/[.,]/g, "") + "." + rawAmount.substring(kurusIndex + 1);
                }

                // Tutar eksi (-) geldiği için Math.abs ile pozitife çevirip sisteme işliyoruz
                const amount = Math.abs(parseFloat(rawAmount));
                
                if (!isNaN(amount)) {
                    processedItems[`item_${itemIndex}`] = {
                        date: date,
                        time: "--:--",
                        desc: desc,
                        amount: amount,
                        category: "dukkan", // 🚀 SADECE DÜKKAN GİDERİNE EKLENİR
                    };
                    itemIndex++;
                }
            });
        }
    } else {
        console.log("Hesap özeti maili bulunamadı. Sadece kredi kartı ekstresi kaydedilecek.");
    }

    // ARAMALAR BİTTİ, GMAIL KAPISINI KAPAT
    connection.end();

    if (itemIndex === 0) {
      console.log("HATA AYIKLAMA İÇİN METİN ÖRNEĞİ:", cleanText.substring(0, 800));
      return res.json({ success: false, error: "Node.js Hatası: PDF okundu ama harcama bulunamadı. Lütfen Render loglarına bakın." });
    }

    // =======================================================================
    // AŞAMA 3: FIREBASE'E KAYDETME
    // =======================================================================
    const ayIsimleri = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
    const ayAdi = ayIsimleri[parseInt(month) - 1];

    await dbRef.set({
      title: `${ayAdi} ${year} Enpara Ekstresi`,
      createdAt: Date.now(),
      items: processedItems,
    });

    console.log(`Bitti! ${ayAdi} ekstresi Firebase'e başarıyla yazıldı.`);
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
