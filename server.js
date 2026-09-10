require("dotenv").config();
const express = require("express");
const cors = require("cors");
const imaps = require("imap-simple");
const simpleParser = require("mailparser").simpleParser;
const pdfParse = require("pdf-parse");
const crypto = require("crypto");

// 🕷️ YENİ BOT KÜTÜPHANELERİ
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

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

// Güvenli başlatma (Render.com ortamında json hatasını önler)
let serviceAccount;
try {
    serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
} catch(e) {
    console.error("Firebase Key JSON formatında değil veya eksik!", e);
}

if(serviceAccount) {
    initializeApp({
      credential: cert(serviceAccount),
      databaseURL: "https://olimpiyatkokorecmenu-default-rtdb.europe-west1.firebasedatabase.app",
    });
}
const database = getDatabase();

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

// =================================================================================
// 🚀 YENİ ROTA: YEMEKSEPETİ BOTU (Terminatör Scraper)
// =================================================================================
app.post("/api/fetch-ys-prices", async (req, res) => {
    let browser;
    try {
        console.log("🍔 Yemeksepeti Botu Uyandı. Fiyatlar süzülüyor...");
        
        const targetUrl = "https://www.yemeksepeti.com/restaurant/hk8c/olimpiyat-kokorec-and-fast-food-hk8c";

        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--window-size=1920x1080'
            ],
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null 
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        console.log("🔗 Adrese gidiliyor...");
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });

        console.log("📜 Sayfa aşağı kaydırılıyor (Tüm ürünlerin yüklenmesi için)...");
        // Sayfanın en altına kadar yavaşça kaydır (Lazy load ürünlerin yüklenmesi için)
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                let distance = 300;
                let timer = setInterval(() => {
                    let scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;
                    if(totalHeight >= scrollHeight - window.innerHeight){
                        clearInterval(timer);
                        resolve();
                    }
                }, 150); // Her 150ms'de bir kaydır
            });
        });

        // Ürünlerin tam belirmesi için fazladan 2 saniye bekle
        await new Promise(r => setTimeout(r, 2000));

        console.log("🧹 Ürünler ve Fiyatlar toplanıyor...");
        
        // Zeki Kazıma (Scraping) Algoritması - YENİ YEMEKSEPETİ DOM YAPISINA GÖRE GÜNCELLENDİ
        const scrapedData = await page.evaluate(() => {
            const results = {};
            
            // Tüm ürün kartlarını bul (Gönderilen HTML'e göre data-testid="menu-product" kullanılmış)
            const productCards = document.querySelectorAll('li[data-testid="menu-product"], div[data-testid="menu-product"]');
            
            productCards.forEach(card => {
                // 1. Ürün İsmini Yakala
                const nameEl = card.querySelector('[data-testid="menu-product-name"]');
                let name = "";
                if (nameEl) {
                    name = nameEl.innerText.trim();
                } else {
                    // Eğer testid yoksa alternatif başlık arayışı
                    const h3 = card.querySelector('h3.product-tile__title');
                    if (h3) name = h3.innerText.trim();
                }

                // 2. Ürün Fiyatını Yakala
                const priceEl = card.querySelector('[data-testid="menu-product-price"]');
                let price = 0;
                
                if (priceEl) {
                    // İçindeki eski/üzeri çizili fiyatları (<span class="strike-through">) hesaba katmamak için sadece ana text nodelarını al
                    let rawPriceText = "";
                    priceEl.childNodes.forEach(node => {
                        // Sadece metin düğümlerini al (element düğümlerini yani üzeri çizili fiyatları es geç)
                        if (node.nodeType === Node.TEXT_NODE) {
                            rawPriceText += node.textContent;
                        }
                    });
                    
                    // Rakamları ve virgülü/noktayı çek
                    const priceMatch = rawPriceText.match(/(\d+(?:[.,]\d+)?)/);
                    if (priceMatch) {
                        price = parseFloat(priceMatch[1].replace(',', '.'));
                    }
                }

                if (name && price > 0) {
                    results[name] = price;
                }
            });

            // Yöntem 2: Eğer liste boş dönerse (Platform tekrar tasarım değiştirirse yedek sistem)
            if (Object.keys(results).length === 0) {
                const altNames = document.querySelectorAll('h3');
                altNames.forEach(h3 => {
                    const name = h3.innerText.trim();
                    let parent = h3.parentElement;
                    for (let i = 0; i < 3; i++) {
                        if (!parent) break;
                        const text = parent.innerText;
                        // Üzeri çizili fiyatları pas geçmek için genellikle ilk rakamı hedefler
                        const match = text.match(/(?:^|\s)(\d+(?:[.,]\d{2})?)\s*(?:TL|₺)/i);
                        if (match && name.length > 3) {
                            results[name] = parseFloat(match[1].replace(',', '.'));
                            break;
                        }
                        parent = parent.parentElement;
                    }
                });
            }

            return results;
        });

        console.log(`✅ İşlem Tamam. Toplam ${Object.keys(scrapedData).length} ürün çekildi.`);

        await browser.close();
        
        return res.json({ 
            success: true, 
            message: "Fiyatlar başarıyla çekildi.",
            data: scrapedData 
        });

    } catch (error) {
        console.error("❌ Bot Hatası:", error);
        if (browser) await browser.close();
        return res.status(500).json({ success: false, error: error.message });
    }
});
// =================================================================================

// --- ANA ROTA: AKILLI EŞLEŞTİRME VE ÇEKİM MOTORU (EKSTRE İÇİN) ---
app.post("/api/fetch-latest-ekstreler", async (req, res) => {
  let connection; 

  try {
    console.log("Ekstre çekim emri alındı. Gmail'e bağlanılıyor...");
    connection = await imaps.connect(imapConfig);
    await connection.openBox("INBOX");

    // 🎯 Klon Harcama Koruması (Aynı gün aynı fiyattan 2 harcama varsa ezilmesini önler)
    const generatedHashes = {};
    function generateItemId(date, desc, amount) {
        let baseHash = crypto.createHash("md5").update(`${date}_${desc}_${amount}`).digest("hex");
        if (generatedHashes[baseHash]) {
            generatedHashes[baseHash]++;
            return `tx_${baseHash}_${generatedHashes[baseHash]}`;
        } else {
            generatedHashes[baseHash] = 1;
            return `tx_${baseHash}_1`;
        }
    }

    // =======================================================================
    // AŞAMA 1: EN SON KREDİ KARTI EKSTRESİNİ BUL VE TARİHİNİ ÇIKAR
    // =======================================================================
    const ekstreSearch = ["ALL", ["FROM", "enpara@enpara.com"], ["SUBJECT", "ekstreniz"]];
    const ekstreMessages = await connection.search(ekstreSearch, { bodies: [""], markSeen: false });
    
    if (ekstreMessages.length === 0) {
      return res.json({ success: false, error: "Gelen kutusunda hiç Enpara ekstresi bulunamadı." });
    }

    const latestEkstreMsg = ekstreMessages[ekstreMessages.length - 1];
    const rawEkstreData = latestEkstreMsg.parts.find((part) => part.which === "").body;
    const parsedEkstreEmail = await simpleParser(rawEkstreData);
    const ekstrePdfAtt = parsedEkstreEmail.attachments.find((att) => att.contentType === "application/pdf" || att.filename.endsWith(".pdf"));

    if (!ekstrePdfAtt) {
      return res.json({ success: false, error: "Ekstre bulundu ama içinde PDF eki yok!" });
    }

    const ekstrePdfData = await pdfParse(ekstrePdfAtt.content);
    const ekstreText = ekstrePdfData.text;

    const dateMatch = ekstreText.match(/Ekstre tarihi[\s\S]*?(\d{2}\/\d{2}\/\d{4})/i);
    if (!dateMatch) {
      return res.json({ success: false, error: "Ekstre PDF formatı anlaşılamadı, tarih bulunamıyor." });
    }

    const ekstreTarihiStr = dateMatch[1];
    const [, ekstreMonthStr, ekstreYearStr] = ekstreTarihiStr.split("/");
    const ekstreMonth = parseInt(ekstreMonthStr);
    const ekstreYear = parseInt(ekstreYearStr);
    const ekstreID = `${ekstreYear}-${ekstreMonthStr}`;

    const ayIsimleri = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
    const ekstreAyAdi = ayIsimleri[ekstreMonth - 1];

    // =======================================================================
    // AŞAMA 2: GEÇMİŞ AYI HESAPLA VE EŞLEŞEN HESAP ÖZETİNİ BUL
    // =======================================================================
    let ozetMonth = ekstreMonth - 1;
    let ozetYear = ekstreYear;
    if (ozetMonth === 0) { 
        ozetMonth = 12;
        ozetYear -= 1;
    }
    const ozetAyAdi = ayIsimleri[ozetMonth - 1];

    console.log(`Eşleştirme: ${ekstreAyAdi} ${ekstreYear} ekstresi. Aranacak Ozet: ${ozetAyAdi} ${ozetYear}`);

    const ozetSearch = ["ALL", ["FROM", "enpara@enpara.com"], ["SUBJECT", "hesap"]];
    const ozetMessages = await connection.search(ozetSearch, { bodies: [""], markSeen: false });
    
    let targetOzetMailData = null;
    
    for (let i = ozetMessages.length - 1; i >= 0; i--) {
        const msg = ozetMessages[i];
        const rawBody = msg.parts.find(p => p.which === "").body;
        const mail = await simpleParser(rawBody);
        
        // Türkçe karakter korumalı eşleştirme
        const subject = mail.subject.toLocaleLowerCase('tr-TR');
        if (subject.includes(ozetYear.toString()) && subject.includes(ozetAyAdi.toLocaleLowerCase('tr-TR'))) {
            targetOzetMailData = mail;
            console.log(`Eşleşen Hesap Özeti Maili Bulundu: ${mail.subject}`);
            break; 
        }
    }

    // =======================================================================
    // AŞAMA 3: İKİ PDF'İ DE AYIKLA VE LİSTEYİ HAZIRLA
    // =======================================================================
    const newParsedItems = {};

    // --- KREDİ KARTI EKSTRESİ MOTORU ---
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

      const descLower = desc.toLocaleLowerCase('tr-TR');
      let assignedCategory = "ev";

      if (descLower.includes("MOKA U /IS NET ELEKTRON") || 
      descLower.includes("is net") || 
        descLower.includes("ıs net") || 
        descLower.includes("iş net") ||
        descLower.includes("umraniye v.d") || 
        descLower.includes("umranıye v.d") || 
        descLower.includes("ümraniye v.d") ||
        descLower.includes("2163357920") ||
        descLower.includes("7040551588") ||
        descLower.includes("faiz") ||
        descLower.includes("bsmv") ||
        descLower.includes("kkdf")) {
        assignedCategory = "dukkan";
      }

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
                if (!part.toLocaleLowerCase('tr-TR').includes("sgk")) return;

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

    let cleanedOldData = false;
    Object.keys(currentEkstre.items).forEach(key => {
        if (key.startsWith("item_")) {
            delete currentEkstre.items[key];
            cleanedOldData = true;
        }
    });

    let addedCount = 0;
    
    Object.keys(newParsedItems).forEach(key => {
        if (!currentEkstre.items[key]) {
            currentEkstre.items[key] = newParsedItems[key];
            addedCount++;
        }
    });

    if (addedCount === 0 && !cleanedOldData) {
        return res.json({ success: true, message: `⚠️ Postalar tarandı ancak eklenecek yeni bir harcama bulunamadı. Hepsi zaten kayıtlı.` });
    }

    await dbRef.set(currentEkstre);

    console.log(`Başarılı! Sisteme ${addedCount} yeni harcama eklendi ve varsa eski çöpler temizlendi.`);
    return res.json({
      success: true,
      message: `✅ Başarılı! Sistem temizlendi ve ${addedCount} adet yeni işlem dahil edildi.`,
    });

  } catch (error) {
    console.error("Beklenmeyen Hata:", error);
    return res.status(500).json({ success: false, error: error.message });
  } finally {
    if (connection) {
        connection.end();
    }
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Olimpiyat Arka Uç (Backend) İşçisi ${PORT} portunda çalışıyor!`);
});
