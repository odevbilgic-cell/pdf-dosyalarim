require("dotenv").config();
const express = require("express");
const cors = require("cors");
const imaps = require("imap-simple");
const simpleParser = require("mailparser").simpleParser;
const pdfParse = require("pdf-parse");

const { initializeApp, cert } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({ origin: "*" }));
app.use(express.json());

const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
initializeApp({
  credential: cert(serviceAccount),
  databaseURL: "https://olimpiyatkokorecmenu-default-rtdb.europe-west1.firebasedatabase.app",
});

const database = getDatabase();
const imapConfig = {
  imap: {
    user: process.env.EMAIL_USER,
    password: process.env.EMAIL_PASSWORD,
    host: "imap.gmail.com",
    port: 993,
    tls: true,
    authTimeout: 5000,
  },
};

app.post("/api/fetch-latest-ekstreler", async (req, res) => {
  try {
    console.log("Çekim emri alındı. Gmail taranıyor...");
    const connection = await imaps.connect(imapConfig);
    await connection.openBox("INBOX");

    // HEM EKSTRE HEM HESAP ÖZETİ MAİLLERİNİ BUL
    const searchCriteria = ["ALL", ["FROM", "enpara@enpara.com"]];
    const messages = await connection.search(searchCriteria, { bodies: [""], markSeen: false });
    
    if (messages.length === 0) {
      connection.end();
      return res.json({ success: false, error: "Enpara'dan gelen mail bulunamadı." });
    }

    const processedItems = {};
    let itemIndex = 0;
    let ekstreID = null;
    let title = "";

    // MAİLLERİ GERİDEN (YENİDEN ESKİYE) TARA
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const rawEmail = msg.parts.find((p) => p.which === "").body;
      const mail = await simpleParser(rawEmail);
      
      // Sadece "Ekstre" veya "Hesap Özeti" olanları işleyelim
      if (!mail.subject.includes("ekstreniz") && !mail.subject.includes("Hesap Özeti")) continue;

      const pdfAtt = mail.attachments.find(a => a.filename.endsWith('.pdf'));
      if (!pdfAtt) continue;

      const pdfData = await pdfParse(pdfAtt.content);
      const text = pdfData.text;

      // 1. Ekstre ise Tarih Belirle
      if (mail.subject.includes("ekstreniz") && !ekstreID) {
        const dateMatch = text.match(/Ekstre tarihi[\s\S]*?(\d{2}\/\d{2}\/\d{4})/i);
        if (dateMatch) {
          const [, m, y] = dateMatch[1].split("/");
          ekstreID = `${y}-${m}`;
          title = `Haziran 2026 Enpara Ekstresi`; // İstersen bunu dinamik yapabilirsin
        }
      }

      // 2. SGK / HESAP ÖZETİ MOTORU
      if (mail.subject.includes("Hesap Özeti")) {
        text.split('\n').forEach(line => {
            if (line.toLowerCase().includes("sgk") || line.toLowerCase().includes("prim")) {
                const match = line.match(/(.*SGK.*?)[\s]+([\d\.,]+)\s*TL/i);
                if (match) {
                    processedItems[`item_${itemIndex++}`] = {
                        date: new Date().toLocaleDateString("tr-TR"),
                        desc: match[1].trim(),
                        amount: parseFloat(match[2].replace(/\./g, "").replace(",", ".")),
                        category: "dukkan"
                    };
                }
            }
        });
      }

      // 3. KREDİ KARTI EKSTRESİ MOTORU
      const cleanText = text.replace(/["\n\r]/g, " ").replace(/\s{2,}/g, " ");
      const parts = cleanText.split(/(?=\d{2}\/\d{2}\/\d{4})/);
      parts.forEach(part => {
        const dateMatch = part.match(/^(\d{2}\/\d{2}\/\d{4})/);
        if (!dateMatch) return;
        const lastAmountMatch = [...part.matchAll(/(-?\s*\d{1,3}(?:[.,]\d{3})*[.,]\d{2})\s*TL/gi)].pop();
        if (!lastAmountMatch) return;

        const desc = part.substring(dateMatch[1].length, lastAmountMatch.index).trim();
        if (desc.toLowerCase().includes("ödeme") || desc.toLowerCase().includes("önceki ekstre")) return;

        let rawAmount = lastAmountMatch[1].replace(/\s/g, "");
        const kurusIndex = rawAmount.length - 3;
        if (rawAmount[kurusIndex] === "." || rawAmount[kurusIndex] === ",") {
            rawAmount = rawAmount.substring(0, kurusIndex).replace(/[.,]/g, "") + "." + rawAmount.substring(kurusIndex + 1);
        }
        
        processedItems[`item_${itemIndex++}`] = {
            date: dateMatch[1],
            desc: desc,
            amount: parseFloat(rawAmount),
            category: (desc.toLowerCase().includes("is net") || desc.toLowerCase().includes("umraniye")) ? "dukkan" : "ev"
        };
      });
    }
    connection.end();

    if (!ekstreID) return res.json({ success: false, error: "İşlenecek ekstre bulunamadı." });

    // FİREBASE'E TEK SEFERDE YAZ
    await database.ref(`ekstreler/${ekstreID}`).set({
      title: title || "Ekstre Özeti",
      createdAt: Date.now(),
      items: processedItems
    });

    res.json({ success: true, message: "✅ Ekstre ve Hesap Özeti birleştirilip işlendi." });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => console.log(`🚀 İşçi ${PORT} portunda!`));
