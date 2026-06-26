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
    console.log("Ekstre çekim emri alındı. Gmail'e bağlanılıyor...");
    const connection = await imaps.connect(imapConfig);
    await connection.openBox("INBOX");

    // 1. MAİLİ BUL
    const searchCriteria = [
      "ALL",
      ["FROM", "enpara@enpara.com"],
      ["SUBJECT", "ekstreniz"],
    ];
    const fetchOptions = { bodies: [""], markSeen: false };

    const messages = await connection.search(searchCriteria, fetchOptions);
    if (messages.length === 0) {
      connection.end();
      return res.json({
        success: false,
        error: "Gelen kutusunda hiç Enpara ekstresi bulunamadı.",
      });
    }

    // En son (en yeni) maili alıyoruz
    const latestMessage = messages[messages.length - 1];
    const rawEmailData = latestMessage.parts.find(
      (part) => part.which === "",
    ).body;
    connection.end(); // Bağlantıyı kapatabiliriz

    console.log("Mail bulundu. Çevirmen (Mailparser) PDF'i ayıklıyor...");

    // 2. ÇEVİRMEN İLE PDF'İ GERÇEK BUFFER'A ÇEVİR
    const parsedEmail = await simpleParser(rawEmailData);

    const pdfAttachment = parsedEmail.attachments.find(
      (att) =>
        att.contentType === "application/pdf" || att.filename.endsWith(".pdf"),
    );

    if (!pdfAttachment) {
      return res.json({
        success: false,
        error: "Mail bulundu ama içinde PDF eki tespit edilemedi!",
      });
    }

    const pdfBuffer = pdfAttachment.content;
    console.log("PDF %100 başarıyla ayıkladı. Yazılar okunuyor...");

    // --- 3. DÜNYANIN EN STABİL PDF OKUMA MOTORU (v1.1.1) ---
    // Artık eski usul, en güvenilir yöntemle çağırıyoruz!
    const pdfParse = require("pdf-parse");
    const pdfData = await pdfParse(pdfBuffer);
    const text = pdfData.text;

    // Ekstre Tarihini ve Ayını bulmak (Farklı boşluklara karşı zırhlandırıldı)
    const dateMatch = text.match(/Ekstre tarihi[\s\S]*?(\d{2}\/\d{2}\/\d{4})/i);
    if (!dateMatch) {
      return res.json({
        success: false,
        error: "PDF formatı anlaşılamadı, ekstre tarihi bulunamıyor.",
      });
    }

    const ekstreTarihiStr = dateMatch[1];
    const [, month, year] = ekstreTarihiStr.split("/");
    const ekstreID = `${year}-${month}`; // "2026-06" (Firebase için benzersiz ID)

    // --- 4. FIREBASE DUPLİKASYON KONTROLÜ (Aynı Ayı Bir Daha Çekmeme) ---
    const dbRef = database.ref(`ekstreler/${ekstreID}`);
    const snapshot = await dbRef.once("value");
    if (snapshot.exists()) {
      return res.json({
        success: true,
        message: `⚠️ ${month}. Ay ${year} ekstresi zaten sistemde kayıtlı. Es geçildi!`,
      });
    }

    // --- 5. YAPAY ZEKA GİBİ SATIR AYRIŞTIRMA VE "EV/DÜKKAN" KATEGORİZASYONU ---
    // 🎯 ÇÖZÜM: KENDİ YAZDIĞIM HATAYI SİLDİM! Virgülleri silen o hatalı kodu kaldırdım.
    // Sadece enter'ları ve çift tırnakları boşluğa çeviriyoruz. Virgüllere ASLA DOKUNMUYORUZ!
    const cleanText = text.replace(/["\n\r]/g, " ").replace(/\s{2,}/g, " ");

    // Tarih formatına göre (Örn: 18/05/2026) faturayı satır satır bloklara böl
    const parts = cleanText.split(/(?=\d{2}\/\d{2}\/\d{4})/);

    const processedItems = {};
    let itemIndex = 0;

    // ÖNCE SGK MOTORU (Eğer PDF Hesap Özeti ise)
    if (text.includes("Hesap Özeti") || text.includes("SGK Ödemesi")) {
      const lines = text.split("\n");
      lines.forEach((line) => {
        if (
          line.toLowerCase().includes("sgk") ||
          line.toLowerCase().includes("prim")
        ) {
          const sgkMatch = line.match(/(.*SGK.*?)[\s]+([\d\.,]+)\s*TL/i);
          if (sgkMatch) {
            const desc = sgkMatch[1].trim();
            const amount = parseFloat(
              sgkMatch[2].replace(/\./g, "").replace(",", "."),
            );

            processedItems[`item_${itemIndex}`] = {
              date: new Date().toLocaleDateString("tr-TR"),
              time: "Manuel/Otomatik",
              desc: desc,
              amount: amount,
              category: "dukkan",
            };
            itemIndex++;
          }
        }
      });
    }

    parts.forEach((part) => {
      // Bu blok gerçekten bir tarihle mi başlıyor?
      const dateMatch = part.match(/^(\d{2}\/\d{2}\/\d{4})/);
      if (!dateMatch) return;

      const date = dateMatch[1];

      // TL tutarını yakala (Örn: "1.240,50 TL", "3.207.35 TL", "- 158.064,58 TL")
      const amountMatches = [
        ...part.matchAll(/(-?\s*\d{1,3}(?:[.,]\d{3})*[.,]\d{2})\s*TL/gi),
      ];
      if (amountMatches.length === 0) return; // TL bulamazsa bu satırı atla

      // Aynı satırda taksit vs. varsa her zaman EN SONDAKİ TL asıl tutardır
      const lastAmountMatch = amountMatches[amountMatches.length - 1];
      const amountStr = lastAmountMatch[1];

      // Tarih ve Para arasındaki her şey Açıklamadır
      const desc = part.substring(date.length, lastAmountMatch.index).trim();

      // "Ödeme" veya "Bir önceki ekstre" ise harcama değildir, atla!
      if (
        desc.toLowerCase().includes("ödeme") ||
        desc.toLowerCase().includes("önceki ekstre")
      )
        return;

      // 🎯 KURUŞ KATLİAMINI DÜZELTME VE SAYIYA ÇEVİRME
      let rawAmount = amountStr.replace(/\s/g, ""); // "- 158.064,58" -> "-158.064,58"

      // Sondan 3. karaktere (kuruş ayracı) nokta/virgül işareti koyacağız
      const kurusIndex = rawAmount.length - 3;
      if (rawAmount[kurusIndex] === "." || rawAmount[kurusIndex] === ",") {
        // Tüm nokta/virgülleri sil, sadece kuruş kısmına gerçek İngilizce nokta (.) koy ki Node.js anlasın
        rawAmount =
          rawAmount.substring(0, kurusIndex).replace(/[.,]/g, "") +
          "." +
          rawAmount.substring(kurusIndex + 1);
      }

      const amount = parseFloat(rawAmount);
      if (isNaN(amount)) return;

      const descLower = desc.toLowerCase();
      let assignedCategory = "ev";

      // 🎯 DÜKKAN FİLTRESİ
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

    // Eğer hiçbir satır bulunamazsa Hata Ver ve loglara temiz metni bas
    if (itemIndex === 0) {
      console.log(
        "HATA AYIKLAMA İÇİN METİN ÖRNEĞİ:",
        cleanText.substring(0, 800),
      );
      return res.json({
        success: false,
        error:
          "Node.js Hatası: PDF okundu ama harcama bulunamadı. Lütfen Render loglarına bakın.",
      });
    }

    // --- 6. FIREBASE'E İLK KEZ KAYDETME ---
    const ayIsimleri = [
      "Ocak",
      "Şubat",
      "Mart",
      "Nisan",
      "Mayıs",
      "Haziran",
      "Temmuz",
      "Ağustos",
      "Eylül",
      "Ekim",
      "Kasım",
      "Aralık",
    ];
    const ayAdi = ayIsimleri[parseInt(month) - 1];

    await dbRef.set({
      title: `${ayAdi} ${year} Enpara Ekstresi`,
      createdAt: Date.now(),
      items: processedItems,
    });

    console.log(`Bitti! ${ayAdi} ekstresi Firebase'e başarıyla yazıldı.`);
    return res.json({
      success: true,
      message: `✅ ${ayAdi} ${year} ekstreniz başarıyla Gmail'den çekildi, ${itemIndex} harcama Ev/Dükkan olarak ayrıştırılıp sisteme işlendi!`,
    });
  } catch (error) {
    console.error("Beklenmeyen Hata:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});
app.listen(PORT, () => {
  console.log(
    `🚀 Olimpiyat Arka Uç (Backend) İşçisi ${PORT} portunda çalışıyor!`,
  );
});
