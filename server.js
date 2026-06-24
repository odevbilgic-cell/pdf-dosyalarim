require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const imaps = require('imap-simple');
const simpleParser = require('mailparser').simpleParser;
const pdf = require('pdf-parse');

const app = express();
const PORT = process.env.PORT || 10000;

// İzinler (Frontend sitenin bu arka kapıya erişebilmesi için)
app.use(cors({ origin: '*' }));
app.use(express.json());

// --- 1. FIREBASE ADMIN KURULUMU ---
// DİKKAT: Proje ayarlarından indirdiğin firebase-adminsdk.json dosyasını klasörüne koymalısın.
// Veya Render ortam değişkenleri (ENV) üzerinden bağlamalısın.
const serviceAccount = require('./firebase-adminsdk.json'); // JSON dosyasının yolu
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://olimpiyatkokorecmenu-default-rtdb.europe-west1.firebasedatabase.app"
});
const database = admin.database();

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

// --- ANA ROTA: MAİLİ ÇEK, PDF'İ OKU, AYRIŞTIR VE KAYDET ---
app.post('/api/fetch-latest-ekstreler', async (req, res) => {
    try {
        console.log("Ekstre çekim emri alındı. Gmail'e bağlanılıyor...");
        const connection = await imaps.connect(imapConfig);
        await connection.openBox('INBOX');

        // KURAL: Kimden "enpara" olan ve konusunda "Ekstre" geçen en son mailleri ara
        const searchCriteria = ['ALL', ['FROM', 'enpara'], ['SUBJECT', 'Ekstreniz']];
        const fetchOptions = { bodies: ['HEADER.FIELDS (FROM TO SUBJECT DATE)', 'TEXT'], struct: true };
        
        const messages = await connection.search(searchCriteria, fetchOptions);
        if (messages.length === 0) {
            connection.end();
            return res.json({ success: false, error: "Gelen kutusunda hiç Enpara ekstresi bulunamadı." });
        }

        // En son (en yeni) maili alıyoruz
        const latestMessage = messages[messages.length - 1];
        const parts = imaps.getParts(latestMessage.attributes.struct);
        
        // Ekleri bul
        const attachments = parts.filter(part => part.disposition && part.disposition.type.toUpperCase() === 'ATTACHMENT');
        if (attachments.length === 0) {
            connection.end();
            return res.json({ success: false, error: "Mail bulundu ama içinde PDF eki yok!" });
        }

        const attachment = attachments[0];
        const partData = await connection.getPartData(latestMessage, attachment);
        connection.end(); // Maille işimiz bitti, bağlantıyı kapat

        console.log("PDF Mailden başarıyla indirildi. Okunuyor...");

        // --- 3. PDF'İ OKUMA VE YAZIYA ÇEVİRME ---
        const pdfData = await pdf(partData);
        const text = pdfData.text;

        // Ekstre Tarihini ve Ayını bulmak (Örn: "03/06/2026") - Benzersiz ID yapmak için
        const dateMatch = text.match(/Ekstre tarihi\s*(\d{2}\/\d{2}\/\d{4})/);
        if (!dateMatch) {
            return res.json({ success: false, error: "PDF formatı anlaşılamadı, ekstre tarihi bulunamıyor." });
        }
        
        const ekstreTarihiStr = dateMatch[1]; // "03/06/2026"
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
                time: '--:--', // PDF'lerde saat genellikle yazmaz
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
        console.error(error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Olimpiyat Arka Uç (Backend) İşçisi ${PORT} portunda çalışıyor!`);
});
