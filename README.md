# Ahenk Okur

PDF, Word, EPUB ve metin belgelerini **tarayıcıda** Türkçe sese dönüştüren site. Ses,
[Ahenk Cep](https://huggingface.co/ozgurguler/ahenk-cep-tr) modeliyle (8,6 M parametre, 48 kHz) ziyaretçinin kendi
cihazında üretilir; dosya da metin de hiçbir sunucuya gitmez.

**Adres:** https://ozguradmin.github.io/ahenk-cep-pdfreader/

## Ne yapar

1. **Belge.** PDF, DOCX, ODT, EPUB, TXT, Markdown, HTML ya da bir sayfa fotoğrafı yüklenir (sürükle-bırak ya da
   seç); metin yapıştırmak da olur.
   - PDF'lerde satırlar, sütunlar ve paragraflar yeniden kurulur; satır sonunda bölünmüş kelimeler birleştirilir;
     tekrarlayan üst/alt bilgiler ve sayfa numaraları atılır; eski yazı tiplerinin ý/þ/ð hatası ı/ş/ğ'ye çevrilir.
   - Taranmış ya da metni bozuk PDF'ler ve görseller Türkçe OCR ile (Tesseract) okunur.
   - Uzun PDF'lerde sayfa aralığı seçilebilir; parolalı PDF'ler parola sorar.
2. **Metin.** Ayıklanan metin düzenlenebilir. Konuşma hızı (0,8×–1,4×) ve kalite (4 / 8 / 16 adım) seçilir; ses
   süresi ve bu cihazda ne kadar süreceği tahmin edilir.
3. **Ses.** Metin cümle cümle seslendirilir: yüzde, cümle sayısı ve kalan süre canlı görünür. Hazır olan kısım hemen
   dinlenebilir; okunan cümle metinde işaretlenir, bir cümleye dokununca oradan çalar. Durdurulup kaldığı yerden
   devam ettirilebilir. Ses üretilirken MP3'e (64 kbit/s, saatte ~29 MB) çevrilir, bitince beklemeden **MP3**
   indirilir; kısa seslerde (bilgisayarda 30, telefonda 10 dakikaya kadar) **WAV** (48 kHz, kayıpsız) da sunulur.
   Dosyalara “yapay zekâ ile üretilmiş ses” notu yazılır.
4. **Uzun belgeler ve kaldığı yerden devam.** Üretilen ses parça parça cihazdaki tarayıcı deposuna (IndexedDB)
   yazılır: sekme kapansa, sayfa yenilense ya da tarayıcı çökse de iş kaybolmaz; “Kaydedilen dönüştürmeler”den
   kaldığı yerden devam edilir, dinleme konumu da hatırlanır (son 3 dönüştürme tutulur). Ses diskte durduğu için
   bir kitabın tamamı tek seferde dönüştürülebilir; okuyucu metni sayfa sayfa gösterir (~120 cümle), böylece kitap
   boyunda bir metinde de sayfa akıcı kalır. Depolamanın olmadığı tarayıcılarda ses bellekte tutulur ve çok uzun
   belgeler bölümlere ayrılır (bilgisayarda ~6, telefonda ~2 saat). OCR bitince OCR motoru ve PDF bellekten bırakılır.
   Uzun bir belge en iyi kalitede saatler sürecekse sayfa “Dengeli” kalitenin ne kadar kazandıracağını söyler.

Model sayfa açılır açılmaz kendiliğinden yüklenir (ilk ziyarette ~17 MB, sonra önbellekten); ilerlemesi yüzde olarak
gösterilir. Telefonlarda ekran üretim boyunca açık tutulur (Wake Lock), kilit ekranından oynatıcı denetlenebilir
(Media Session).

## Nasıl çalışır

| Parça | Dosya |
|---|---|
| Sayfa, adımlar, ilerleme, indirme | `docs/index.html`, `docs/css/style.css`, `docs/js/app.js` |
| Belge okuma (pdf.js, DOCX/ODT/EPUB XML'i, metin kodlaması) | `docs/js/extract.js` |
| PDF düzeni, metin temizliği, cümlelere bölme (DOM'suz, Node'da test edilir) | `docs/js/text.js` |
| OCR (tesseract.js, yalnızca gerektiğinde yüklenir) | `docs/js/ocr.js` |
| Model: indirme + sha256 + önbellek, iş parçacıkları, bölüm bölüm sentez, iptal | `docs/js/worker.js` |
| Ahenk Cep'in örnekleme döngüsü, arka uç seçimi, trnorm ön ucu, torch.randn | `docs/js/engine.js`, `backend.js`, `front.js`, `randn.js`, `docs/py/` |
| Sesin saklanması (MP3 parçaları, kısa seslerde PCM) ve oynatıcı (üretilirken dinleme, dalga biçimi, kilit ekranı) | `docs/js/player.js` |
| İşlerin cihazda saklanması (IndexedDB) ve kaldığı yerden devam | `docs/js/storage.js` |
| MP3 (lamejs, ses üretilirken ayrı worker'da), WAV ve ID3 etiketi | `docs/js/mp3.js`, `docs/js/wav.js` |
| GitHub Pages'te çapraz köken yalıtımı (çok iş parçacıklı WebAssembly için) | `docs/coi-serviceworker.js` |

Motor, [ahenk-turkish-tts](https://github.com/ozguradmin/ahenk-turkish-tts) deposundaki tarayıcı demosundan
alındı (`docs/js/engine.js` vb., Apache-2.0); orada PyTorch'la birebir karşılaştırılmıştır. Bu depoda eklenenler:
uzun belgeler için bölüm bölüm sentez, iptal ve devam, üretilirken dinleme, belge okuma ve OCR.

Model dosyaları depoda değildir: sayfa onları Hugging Face model deposundan (`onnx/`, f16, sha256 denetimli) indirir
ve Cache Storage'a koyar. Aynı adresteki (`ozguradmin.github.io`) Ahenk Cep demosu da aynı önbellek adını kullanır;
birinde inen model ötekinde yeniden inmez. İki site birbirinin ayarına ya da servis çalışanına dokunmaz.

Kütüphaneler jsdelivr'den, sabit sürümle gelir (`docs/js/config.js`): onnxruntime-web 1.30.0, Pyodide 0.27.7,
pdf.js 5.7.284 (legacy derleme), fflate 0.8.2, lamejs 1.2.7, tesseract.js 7.0.0.

Adres satırı seçenekleri: `?variant=fp32|f16|int8`, `?ep=wasm|webgpu`.

## Yerelde açmak

```bash
python3 tools/serve.py --isolate     # http://127.0.0.1:8000/  (çok iş parçacıklı)
python3 tools/serve.py               # GitHub Pages'in sunduğu gibi, başlıksız
npm test                             # metin işleme testleri (node --test)
```

## Yayınlama

Site `docs/` klasöründen GitHub Pages ile, derleme adımı ve GitHub Actions olmadan yayınlanır (`docs/.nojekyll`
dosyaları olduğu gibi sunar). Bir kerelik ayar: **Settings → Pages → Build and deployment → Source: Deploy from a
branch → Branch: varsayılan dal, klasör `/docs` → Save**. Sonraki her gönderim kendiliğinden yayına çıkar.

Cloudflare Pages'e de aynı klasör olduğu gibi konabilir (`wrangler pages deploy docs --project-name ahenk-okur`);
ancak bazı Türk internet sağlayıcıları `*.pages.dev` adreslerini engelliyor, bu yüzden ana adres GitHub Pages.

## Lisans ve atıf

Kod Apache-2.0 (`LICENSE`); üçüncü taraf parçalar ve atıflar `NOTICE` dosyasında. Ses modeli Ahenk Cep,
CC BY 4.0: “Ahenk Cep, Ahenk (https://github.com/ozguradmin/ahenk-turkish-tts), CC BY 4.0”.

**Bu ses yapaydır.** Ahenk Cep'in sesi (f022) bir metin tarifinden tasarlandı, gerçek bir kişi değildir. Ürettiğiniz
sesi paylaşırken yapay zekâ ile üretildiğini belirtin; kimseyi taklit etmek ya da yanıltmak için kullanmayın.
