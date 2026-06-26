require("dotenv").config();
const express = require("express");
const cors = require("cors");
const imaps = require("imap-simple");
const simpleParser = require("mailparser").simpleParser;
const pdfParse = require("pdf-parse");
const crypto = require("crypto"); // Harcamaları benzersiz yapmak için şifreleme modülü (Node.js'de hazır gelir)

const { initializeApp, cert } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");

const app = express();
const PORT = process.env.PORT || 10000;

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

// Benzersiz Harcama ID'si Üretici (Aynı harcamanın 2 kere eklenmesini sonsuza dek engeller)
function generateItemId(date, desc, amount) {
    return "tx_" + crypto.createHash("md5").update(`${date}_${desc}_${amount}`).digest("hex");
}

// --- ANA ROTA: AKILLI EŞLEŞTİRME VE ÇEKİM MOTORU ---
app.post("/api/fetch-latest-ekstreler", async (req, res) => {
  try {
    console.log("Ekstre çekim emri alındı. Gmail'e bağlanılıyor...");
    const connection = await imaps.connect(imapConfig);
    await connection.openBox("INBOX");

    // =======================================================================
    // AŞAMA 1: EN SON KREDİ KARTI EKSTRESİNİ BUL VE TARİHİNİ ÇIKAR
    // =======================================================================
    const ekstreSearch = ["ALL", ["FROM", "enpara@enpara.com"], ["SUBJECT", "ekstreniz"]];
    const ekstreMessages = await connection.search(ekstreSearch, { bodies: [""], markSeen: false });
    
    if (ekstreMessages.length === 0) {
      connection.end();
      return res.json({ success: false, error: "Gelen kutusunda hiç Enpara ekstresi bulunamadı." });
    }

    const latestEkstreMsg = ekstreMessages[ekstreMessages.length - 1];
    const rawEkstreData = latestEkstreMsg.parts.find((part) => part.which === "").body;
    const parsedEkstreEmail = await simpleParser(rawEkstreData);
    const ekstrePdfAtt = parsedEkstreEmail.attachments.find((att) => att.contentType === "application/pdf" || att.filename.endsWith(".pdf"));

    if (!ekstrePdfAtt) {
      connection.end();
      return res.json({ success: false, error: "Ekstre bulundu ama içinde PDF eki yok!" });
    }

    const ekstrePdfData = await pdfParse(ekstrePdfAtt.content);
    const ekstreText = ekstrePdfData.text;

    const dateMatch = ekstreText.match(/Ekstre tarihi[\s\S]*?(\d{2}\/\d{2}\/\d{4})/i);
    if (!dateMatch) {
      connection.end();
      return res.json({ success: false, error: "Ekstre PDF formatı anlaşılamadı, tarih bulunamıyor." });
    }

    const ekstreTarihiStr = dateMatch[1]; // Örn: 03/06/2026
    const [, ekstreMonthStr, ekstreYearStr] = ekstreTarihiStr.split("/");
    const ekstreMonth = parseInt(ekstreMonthStr);
    const ekstreYear = parseInt(ekstreYearStr);
    const ekstreID = `${ekstreYear}-${ekstreMonthStr}`; // Örn: "2026-06"

    const ayIsimleri = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
    const ekstreAyAdi = ayIsimleri[ekstreMonth - 1];

    // =======================================================================
    // AŞAMA 2: GEÇMİŞ AYI HESAPLA VE EŞLEŞEN HESAP ÖZETİNİ BUL
    // =======================================================================
    let ozetMonth = ekstreMonth - 1;
    let ozetYear = ekstreYear;
    if (ozetMonth === 0) { // Eğer ekstre Ocak ayıysa, hesap özeti bir önceki yılın Aralık ayıdır.
        ozetMonth = 12;
        ozetYear -= 1;
    }
    const ozetAyAdi = ayIsimleri[ozetMonth - 1]; // Örn: "Mayıs"

    console.log(`Eşleştirme: ${ekstreAyAdi} ${ekstreYear} ekstresi bulundu. Aranacak Ozet: ${ozetAyAdi} ${ozetYear}`);

    // Tüm hesap özetlerini bul
    const ozetSearch = ["ALL", ["FROM", "enpara@enpara.com"], ["SUBJECT", "hesap"]];
    const ozetMessages = await connection.search(ozetSearch, { bodies: [""], markSeen: false });
    
    let targetOzetMailData = null;
    
    // Bütün "hesap özeti" maillerini geriden (yeniden eskiye) tara, doğru ay ve yılı bul!
    for (let i = ozetMessages.length - 1; i >= 0; i--) {
        const msg = ozetMessages[i];
        const rawBody = msg.parts.find(p => p.which === "").body;
        const mail = await simpleParser(rawBody);
        
        // Konu içinde "2026" ve "Mayıs" kelimeleri geçiyor mu kontrol et
        const subject = mail.subject.toLowerCase();
        if (subject.includes(ozetYear.toString()) && subject.includes(ozetAyAdi.toLowerCase())) {
            targetOzetMailData = mail;
            console.log(`Eşleşen Hesap Özeti Maili Bulundu: ${mail.subject}`);
            break; // Doğru maili bulduk, döngüden çık
        }
    }

    connection.end(); // İşimiz bitti, Gmail'i kapat

    // =======================================================================
    // AŞAMA 3: İKİ PDF'İ DE AYIKLA VE LİSTEYİ HAZIRLA
    // =======================================================================
    const newParsedItems = {}; // Firebase'e eklenecek taze liste

    // --- KREDİ KARTI EKSTRESİ MOTORU (Orijinal Kodun) ---
    const cleanEkstreText = ekstreText.replace(/["\n\r]/g, " ").replace(/\s{2,}/g, " ");
    const ekstreParts = cleanEkstreText.split(/(?=\d{2}\/\d{2}\/\d{4})/);

    ekstreParts.forEach((part) => {
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

      if (descLower.includes("is net elektron") || descLower.includes("umraniye v.d") || descLower.includes("2163357920") || descLower.includes("7040551588") || descLower.includes("faiz") || descLower.includes("bsmv") || descLower.includes("kkdf")) {
        assignedCategory = "dukkan";
      }

      // Benzersiz ID oluşturarak listeye ekle
      const itemId = generateItemId(date, desc, amount);
      newParsedItems[itemId] = { date: date, time: "--:--", desc: desc, amount: amount, category: assignedCategory };
    });

    // --- SGK / HESAP ÖZETİ MOTORU ---
    if (targetOzetMailData) {
        const ozetPdfAtt = targetOzetMailData.attachments.find((att) => att.contentType === "application/pdf" || att.filename.endsWith(".pdf"));
        if (ozetPdfAtt) {
            const ozetPdfData = await pdfParse(ozetPdfAtt.content);
            const cleanOzetText = ozetPdfData.text.replace(/["\n\r]/g, " ").replace(/\s{2,}/g, " ");
            const ozetParts = cleanOzetText.split(/(?=\d{2}\/\d{2}\/\d{2,4})/);

            ozetParts.forEach((part) => {
                if (!part.toLowerCase().includes("sgk")) return; // SADECE SGK ÖDEMELERİ GEÇER

                const ozetDateMatch = part.match(/^(\d{2}\/\d{2}\/\d{2,4})/);
                if (!ozetDateMatch) return;
                const date = ozetDateMatch[1];
                
                const amountMatches = [...part.matchAll(/(-?\s*\d{1,3}(?:[.,]\d{3})*[.,]\d{2})\s*TL/gi)];
                if (amountMatches.length === 0) return;

                const firstAmountMatch = amountMatches[0]; // Hesap özetinde ilk para işlemi asıl tutardır
                const amountStr = firstAmountMatch[1];
                
                let desc = part.substring(date.length, firstAmountMatch.index).trim();
                desc = desc.replace(/^,?\s*Ödeme,?\s*/i, '').replace(/,\s*$/g, '').trim();

                let rawAmount = amountStr.replace(/\s/g, "");
                const kurusIndex = rawAmount.length - 3;
                if (rawAmount[kurusIndex] === "." || rawAmount[kurusIndex] === ",") {
                    rawAmount = rawAmount.substring(0, kurusIndex).replace(/[.,]/g, "") + "." + rawAmount.substring(kurusIndex + 1);
                }

                const amount = Math.abs(parseFloat(rawAmount)); // Tutarı eksi değerden kurtar pozitif yap
                
                if (!isNaN(amount)) {
                    const itemId = generateItemId(date, desc, amount);
                    newParsedItems[itemId] = { date: date, time: "Hesap Özeti", desc: desc, amount: amount, category: "dukkan" };
                }
            });
        }
    }

    // =======================================================================
    // AŞAMA 4: FIREBASE'E AKILLI KAYIT (Mevcut Olanları Koruyarak Ekleme)
    // =======================================================================
    const dbRef = database.ref(`ekstreler/${ekstreID}`);
    const snapshot = await dbRef.once("value");
    
    let currentEkstre = snapshot.val() || {
        title: `${ekstreAyAdi} ${ekstreYear} Enpara İşlemleri`,
        createdAt: Date.now(),
        items: {}
    };

    if (!currentEkstre.items) currentEkstre.items = {};

    let addedCount = 0;
    
    // Bulunan yeni harcamaları Firebase'deki mevcut liste ile karşılaştır
    Object.keys(newParsedItems).forEach(key => {
        // Eğer bu ID'ye sahip harcama zaten veritabanında YOKSA ekle.
        // VARSA dokunma! (Böylece kullanıcının "ev/dükkan" manuel kategori değişiklikleri sıfırlanmaz)
        if (!currentEkstre.items[key]) {
            currentEkstre.items[key] = newParsedItems[key];
            addedCount++;
        }
    });

    if (addedCount === 0) {
        return res.json({ success: true, message: `⚠️ Postalar tarandı ancak eklenecek yeni bir SGK veya harcama bulunamadı. Hepsi zaten kayıtlı.` });
    }

    // Güncellenmiş listeyi kaydet
    await dbRef.set(currentEkstre);

    console.log(`Başarılı! Sisteme ${addedCount} yeni harcama eklendi.`);
    return res.json({
      success: true,
      message: `✅ Başarılı! Sisteme ${addedCount} adet yeni işlem (Kredi Kartı + SGK) dahil edildi.`,
    });

  } catch (error) {
    console.error("Beklenmeyen Hata:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// --- GEÇİCİ ROTA: OCAK 2026'DAN İTİBAREN GEÇMİŞİ ÇEKME MOTORU ---
// Bu kodu işin bitince silebilirsin ustam!
app.post("/api/fetch-gecmis", async (req, res) => {
  try {
    console.log("GEÇMİŞ TARAMA EMRİ ALINDI...");
    const connection = await imaps.connect(imapConfig);
    await connection.openBox("INBOX");

    // 1 Ocak 2026'dan bugüne kadar gelen Enpara maillerini bul
    const searchCriteria = [
      ["FROM", "enpara@enpara.com"],
      ["SINCE", "01-Jan-2026"]
    ];
    
    const messages = await connection.search(searchCriteria, { bodies: [""], markSeen: false });
    connection.end();

    if (messages.length === 0) {
      return res.json({ success: false, error: "Ocak 2026'dan bugüne Enpara maili bulunamadı." });
    }

    const allMonths = {};
    let totalItemsAdded = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
        const rawEmail = messages[i].parts.find(p => p.which === "").body;
        const mail = await simpleParser(rawEmail);
        
        if (!mail.subject) continue;
        const subject = mail.subject.toLowerCase();
        
        if (!subject.includes("ekstreniz") && !subject.includes("hesap özeti")) continue;

        const pdfAtt = mail.attachments.find(a => a.filename.endsWith('.pdf'));
        if (!pdfAtt) continue;

        const pdfData = await require("pdf-parse")(pdfAtt.content);
        const text = pdfData.text;
        const cleanText = text.replace(/["\n\r]/g, " ").replace(/\s{2,}/g, " ");

        // --- KREDİ KARTI EKSTRESİ GEÇMİŞİ ---
        if (subject.includes("ekstreniz")) {
            const dateMatch = text.match(/Ekstre tarihi[\s\S]*?(\d{2}\/\d{2}\/\d{4})/i);
            if (!dateMatch) continue;

            const [, m, y] = dateMatch[1].split("/");
            const ekstreID = `${y}-${m}`;
            
            if (!allMonths[ekstreID]) allMonths[ekstreID] = { items: {} };
            const ayIsimleri = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
            allMonths[ekstreID].title = `${ayIsimleri[parseInt(m) - 1]} ${y} Enpara İşlemleri`;

            const parts = cleanText.split(/(?=\d{2}\/\d{2}\/\d{4})/);
            parts.forEach((part) => {
                const partDateMatch = part.match(/^(\d{2}\/\d{2}\/\d{4})/);
                if (!partDateMatch) return;

                const amountMatches = [...part.matchAll(/(-?\s*\d{1,3}(?:[.,]\d{3})*[.,]\d{2})\s*TL/gi)];
                if (amountMatches.length === 0) return;

                const lastAmountMatch = amountMatches[amountMatches.length - 1];
                const amountStr = lastAmountMatch[1];
                const desc = part.substring(partDateMatch[1].length, lastAmountMatch.index).trim();

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
                if (descLower.includes("is net elektron") || descLower.includes("umraniye v.d") || descLower.includes("2163357920") || descLower.includes("7040551588") || descLower.includes("faiz") || descLower.includes("bsmv") || descLower.includes("kkdf")) {
                    assignedCategory = "dukkan";
                }

                const crypto = require("crypto");
                const itemId = "tx_" + crypto.createHash("md5").update(`${partDateMatch[1]}_${desc}_${amount}`).digest("hex");
                
                allMonths[ekstreID].items[itemId] = {
                    date: partDateMatch[1],
                    time: "--:--",
                    desc: desc,
                    amount: amount,
                    category: assignedCategory
                };
                totalItemsAdded++;
            });
        }

        // --- HESAP ÖZETİ (SGK) GEÇMİŞİ ---
        if (subject.includes("hesap özeti")) {
            const ozetParts = cleanText.split(/(?=\d{2}\/\d{2}\/\d{2,4})/);
            ozetParts.forEach((part) => {
                if (!part.toLowerCase().includes("sgk")) return;

                const ozetDateMatch = part.match(/^(\d{2}\/\d{2}\/\d{2,4})/);
                if (!ozetDateMatch) return;
                
                const date = ozetDateMatch[1];
                const amountMatches = [...part.matchAll(/(-?\s*\d{1,3}(?:[.,]\d{3})*[.,]\d{2})\s*TL/gi)];
                if (amountMatches.length === 0) return;

                const firstAmountMatch = amountMatches[0];
                const amountStr = firstAmountMatch[1];
                
                let desc = part.substring(date.length, firstAmountMatch.index).trim();
                desc = desc.replace(/^,?\s*Ödeme,?\s*/i, '').replace(/,\s*$/g, '').trim();

                let rawAmount = amountStr.replace(/\s/g, "");
                const kurusIndex = rawAmount.length - 3;
                if (rawAmount[kurusIndex] === "." || rawAmount[kurusIndex] === ",") {
                    rawAmount = rawAmount.substring(0, kurusIndex).replace(/[.,]/g, "") + "." + rawAmount.substring(kurusIndex + 1);
                }

                const amount = Math.abs(parseFloat(rawAmount));
                if (!isNaN(amount)) {
                    // SENİN KURALIN: SGK MAYIS İSE -> HAZİRAN EKSTRESİNE GİRMELİ!
                    let [, d, m, y] = date.match(/(\d{2})\/(\d{2})\/(\d{2,4})/);
                    let monthInt = parseInt(m) + 1;
                    let yearInt = y.length === 2 ? 2000 + parseInt(y) : parseInt(y);
                    // Aralık'tan (12) Ocak'a (1) geçerken yılı 1 arttır
                    if (monthInt > 12) { monthInt = 1; yearInt++; }
                    
                    const targetEkstreID = `${yearInt}-${String(monthInt).padStart(2, '0')}`;
                    
                    if (!allMonths[targetEkstreID]) allMonths[targetEkstreID] = { items: {} };

                    const crypto = require("crypto");
                    const itemId = "tx_" + crypto.createHash("md5").update(`${date}_${desc}_${amount}`).digest("hex");

                    allMonths[targetEkstreID].items[itemId] = {
                        date: date,
                        time: "Hesap Özeti",
                        desc: desc,
                        amount: amount,
                        category: "dukkan"
                    };
                    totalItemsAdded++;
                }
            });
        }
    }

    // 3. FIREBASE'E TÜM GEÇMİŞİ TOPLUCA YAZ (Eski verileri silmez, üstüne ekler)
    for (const [ekstreID, data] of Object.entries(allMonths)) {
        const dbRef = database.ref(`ekstreler/${ekstreID}`);
        const snapshot = await dbRef.once("value");
        let existingData = snapshot.val() || {
            title: data.title || "Geçmiş Enpara İşlemleri",
            createdAt: Date.now(),
            items: {}
        };
        
        if (!existingData.items) existingData.items = {};

        // Sadece daha önce eklenmemiş yeni harcamaları ekle
        Object.keys(data.items).forEach(k => {
            if (!existingData.items[k]) {
                existingData.items[k] = data.items[k];
            }
        });

        await dbRef.set(existingData);
    }

    res.json({ success: true, message: `✅ Geçmiş taranıp listeye eklendi! Toplam ${totalItemsAdded} kalem bulundu.` });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Olimpiyat Arka Uç (Backend) İşçisi ${PORT} portunda çalışıyor!`);
});
