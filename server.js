require('dotenv').config();
const express = require('express');
const cors = require('cors');
const imaps = require('imap-simple');
const simpleParser = require('mailparser').simpleParser;
const pdfParse = require('pdf-parse');

// 🎯 ÇÖZÜM: Firebase'in en yeni (Modüler) versiyonuna göre parçalayarak çağırıyoruz!
const { initializeApp, cert } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

const app = express();
const PORT = process.env.PORT || 10000;

// İzinler (Frontend sitenin bu arka kapıya erişebilmesi için)
app.use(cors({ origin: '*' }));
app.use(express.json());

// --- 1. FIREBASE ADMIN KURULUMU ---
// DİKKAT: Proje ayarlarından indirdiğin firebase-adminsdk.json dosyasını klasörüne koymalısın.
const serviceAccount = require('./firebase-adminsdk.json'); 

const firebaseApp = initializeApp({
    credential: cert(serviceAccount),
    databaseURL: "https://olimpiyatkokorecmenu-default-rtdb.europe-west1.firebasedatabase.app"
});

// Eski komutların aynen çalışabilmesi için veritabanı bağlantısı
const database = getDatabase(firebaseApp);

// --- 2. GMAIL IMAP BAĞLANTI AYARLARI ---
// (BU SATIRDAN AŞAĞISI SENDE ZATEN VAR, AYNEN KALSIN)

// --- 2. GMAIL IMAP BAĞLANTI AYARLARI ---
const imapConfig = {
    imap: {
        user: process.env.EMAIL_USER, // Render'a girilecek (uguraydin1640@gmail.com)
        password: process.env.EMAIL_PASSWORD, // Render'a girilecek (Google Uygulama Şifresi)
        host: 'imap.gmail.com',
        port: 993,
        tls: true,
        authTimeout: 3000,
        tlsOptions: { rejectUnauthorized: false }
    }
};

// --- ANA ROTA: MAİLİ ÇEK, ÇEVİRMENDEN GEÇİR, PDF'İ OKU VE KAYDET ---
// --- ANA ROTA: MAİLİ ÇEK, ÇEVİRMENDEN GEÇİR, PDF'İ OKU VE KAYDET ---
app.post('/api/fetch-latest-ekstreler', async (req, res) => {
    try {
        console.log("Ekstre çekim emri alındı. Gmail'e bağlanılıyor...");
        const connection = await imaps.connect(imapConfig);
        await connection.openBox('INBOX');

        // 1. MAİLİ BUL 
        const searchCriteria = ['ALL', ['FROM', 'enpara@enpara.com'], ['SUBJECT', 'ekstreniz']];
        const fetchOptions = { bodies: [''], markSeen: false }; 
        
        const messages = await connection.search(searchCriteria, fetchOptions);
        if (messages.length === 0) {
            connection.end();
            return res.json({ success: false, error: "Gelen kutusunda hiç Enpara ekstresi bulunamadı." });
        }

        // En son (en yeni) maili alıyoruz
        const latestMessage = messages[messages.length - 1];
        const rawEmailData = latestMessage.parts.find(part => part.which === '').body;
        connection.end(); // Bağlantıyı kapatabiliriz

        console.log("Mail bulundu. Çevirmen (Mailparser) PDF'i ayıklıyor...");

        // 2. ÇEVİRMEN İLE PDF'İ GERÇEK BUFFER'A ÇEVİR
        const parsedEmail = await simpleParser(rawEmailData);
        
        // Eklentiler (Attachments) arasından PDF olanı bul
        const pdfAttachment = parsedEmail.attachments.find(att => att.contentType === 'application/pdf' || att.filename.endsWith('.pdf'));
        
        if (!pdfAttachment) {
            return res.json({ success: false, error: "Mail bulundu ama içinde PDF eki tespit edilemedi!" });
        }

        const pdfBuffer = pdfAttachment.content; 

        console.log("PDF %100 başarıyla ayıkladı. Yazılar okunuyor...");

        // --- 3. YENİ NESİL PDF OKUMA MOTORU (ESM UYUMLU) ---
        // ÇÖZÜM: Yeni paket ESM formatında olduğu için 'require' yerine dinamik 'import' ile çağırıp kutuyu açıyoruz!
        const pdfParseModule = await import('pdf-parse');
        
        // Modülün içindeki asıl fonksiyonu yakalıyoruz (Garantili yöntem)
        const parsePdf = pdfParseModule.default || pdfParseModule; 
        
        // PDF'i fonksiyona verip yazıları çekiyoruz
        const pdfData = await parsePdf(pdfBuffer);
        const text = pdfData.text;

        // Ekstre Tarihini ve Ayını bulmak (Örn: "03/06/2026")
        const dateMatch = text.match(/Ekstre tarihi\s*(\d{2}\/\d{2}\/\d{4})/);
        if (!dateMatch) {
            return res.json({ success: false, error: "PDF formatı anlaşılamadı, ekstre tarihi bulunamıyor." });
        }
        
        const ekstreTarihiStr = dateMatch[1]; 
        const [, month, year] = ekstreTarihiStr.split('/');
        const ekstreID = `${year}-${month}`; // "2026-06" (Firebase için benzersiz ID)

        // --- 4. FIREBASE DUPLİKASYON KONTROLÜ (Aynı Ayı Bir Daha Çekmeme) ---
        const dbRef = database.ref(`ekstreler/${ekstreID}`);
        const snapshot = await dbRef.once('value');
        if (snapshot.exists()) {
            return res.json({ success: true, message: `⚠️ ${month}. Ay ${year} ekstresi zaten sistemde kayıtlı. Es geçildi!` });
        }

        // --- 5. YAPAY ZEKA GİBİ SATIR AYRIŞTIRMA VE "EV/DÜKKAN" KATEGORİZASYONU ---
        // Harcama satırlarını bulan Regex (Örn: 18/05/2026 TIKLA GELSIN 395,00 TL)
        const itemRegex = /(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+(\d{1,3}(?:\.\d{3})*,\d{2})\s*TL/g;
        let match;
        const processedItems = {};
        let itemIndex = 0;

        while ((match = itemRegex.exec(text)) !== null) {
            const date = match[1].trim();
            const desc = match[2].replace(/\n/g, ' ').trim();
            const amountStr = match[3];
            
            // Türk Lirası formatını "1.240,50" -> 1240.50 Float'a çevir
            const amount = parseFloat(amountStr.replace(/\./g, '').replace(',', '.'));

            // Eğer "Ödeme" veya "Bir önceki ekstre" satırlarıysa atla (Gider hesaplamıyoruz)
            if (desc.toLowerCase().includes('ödeme -') || desc.toLowerCase().includes('önceki ekstre')) continue;

            const descLower = desc.toLowerCase();
            let assignedCategory = 'ev'; // Varsayılan Şahsi Gider

            // 🎯 SENİN İSTEDİĞİN DÜKKAN FİLTRELEME ŞARTLARI
            if (
                descLower.includes('is net elektron') ||
                descLower.includes('umraniye v.d') ||
                descLower.includes('2163357920') ||
                descLower.includes('7040551588') ||
                descLower.includes('faiz')
            ) {
                assignedCategory = 'dukkan'; // Eşleştiği an Dükkan'a fırlat!
            }

            processedItems[`item_${itemIndex}`] = {
                date: date,
                time: '--:--', 
                desc: desc,
                amount: amount,
                category: assignedCategory
            };
            itemIndex++;
        }

        if (itemIndex === 0) {
            return res.json({ success: false, error: "PDF okundu ama içinde hiçbir harcama satırı bulunamadı." });
        }

        // --- 6. FIREBASE'E İLK KEZ KAYDETME ---
        const ayIsimleri = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
        const ayAdi = ayIsimleri[parseInt(month) - 1];

        await dbRef.set({
            title: `${ayAdi} ${year} Enpara Ekstresi`,
            createdAt: Date.now(),
            items: processedItems
        });

        console.log(`Bitti! ${ayAdi} ekstresi Firebase'e başarıyla yazıldı.`);
        return res.json({ success: true, message: `✅ ${ayAdi} ${year} ekstreniz başarıyla Gmail'den çekildi, ${itemIndex} harcama Ev/Dükkan olarak ayrıştırılıp sisteme işlendi!` });

    } catch (error) {
        console.error("Beklenmeyen Hata:", error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Olimpiyat Arka Uç (Backend) İşçisi ${PORT} portunda çalışıyor!`);
});
