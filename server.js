const express = require('express');
const cors = require('cors'); // Farklı domainden gelen isteklere izin verir

const app = express();
const PORT = process.env.PORT || 10000;

// ÇOK ÖNEMLİ: Statik siten (olimpiyat.onrender.com) bu sunucuya bağlanabilsin diye izin veriyoruz
app.use(cors({
    origin: '*' // Güvenliği artırmak için ileride buraya 'https://olimpiyat.onrender.com' yazabilirsin
}));

app.use(express.json());

// Gmail'den çekim yapacak asıl API Rotamız
app.post('/api/fetch-latest-ekstreler', async (req, res) => {
    try {
        // BURAYA GMAIL'DEN PDF ÇEKME VE FIREBASE'E YAZMA KODLARIN GELECEK
        // Şimdilik sistemin çalıştığını test etmek için başarılı mesajı dönüyoruz:
        
        console.log("Admin panelinden tetikleme geldi, çalışıyorum!");
        
        return res.json({ 
            success: true, 
            message: "Node.js İşçisi: Ekstreler başarıyla çekildi ve Firebase'e yazıldı!" 
        });

    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// Sunucuyu ateşle
app.listen(PORT, () => {
    console.log(`Gizli Node.js API işçisi ${PORT} portunda emre amade!`);
});