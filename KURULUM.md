# JİBER Saha Denetim Portalı — Vercel Kurulumu

Her şey Vercel'in içinde: portal, veritabanı ve fotoğraflar. Kodda hiçbir şeyi değiştirmeniz gerekmez.
Toplam süre yaklaşık 15 dakika.

---

## Adım 1 — Dosyaları GitHub'a yükle (5 dk)
1. https://github.com adresine girin (hesabınız yoksa **Sign up** ile ücretsiz açın).
2. Sağ üstteki **+** › **New repository**.
3. Repository name: `jiber-denetim` · **Private** seçin · **Create repository**.
4. Açılan sayfada **uploading an existing file** bağlantısına tıklayın.
5. Zip'ten çıkardığınız `jiber-denetim-vercel` klasörünü açın. İçindeki **her şeyi** (`api` klasörü, `public` klasörü,
   `package.json`, `vercel.json`, `KURULUM.md`) seçip sayfaya sürükleyin.
6. Aşağıdaki yeşil **Commit changes** düğmesine basın.

## Adım 2 — Vercel'de projeyi aç (3 dk)
1. https://vercel.com adresine girin › **Continue with GitHub** ile giriş yapın.
2. **Add New…** › **Project** › listede `jiber-denetim` yanındaki **Import**.
   (Liste boşsa "Adjust GitHub App Permissions" ile bu depoya izin verin.)
3. Hiçbir ayarı değiştirmeden **Deploy**'a basın. Bitince "Congratulations" ekranı gelir.
   Bu aşamada portalı açarsanız "Veritabanı bağlı değil" yazar — normal, sıradaki adımda bağlıyoruz.

## Adım 3 — Veritabanını bağla (3 dk)
1. Vercel'de projenizin sayfasında üstteki **Storage** sekmesi › **Create Database**.
2. Listeden **Neon** (Serverless Postgres) seçin › **Continue**.
   ⚠ Prisma, Supabase vb. değil, **Neon** olsun.
3. Bölge: **Frankfurt (fra1)** veya Avrupa'daki herhangi biri · Plan: **Free** › **Create**.
4. "Connect to project" penceresinde projeniz seçili olsun, **Connect**.
5. Üstte **Deployments** sekmesi › en üstteki satırın sağındaki **⋯** › **Redeploy** › **Redeploy**.

## Adım 4 — Giriş yap
1. Proje sayfasında **Visit** (veya Domains altındaki `jiber-denetim.vercel.app` gibi adres).
2. Giriş: `cihankaymaaz@gmail.com` / `212121`
3. **Hemen şifrenizi değiştirin:** sağ üstte isminize dokunun › **Şifremi değiştir**.
4. **Yönetim › Sorular** › "Örnek mağaza denetim sorularını yükle" (veya kendi sorularınız).
5. **Yönetim › Mağazalar** › mağazaları ekleyin. Koordinat için Google Haritalar'da mağazaya sağ tıklayın,
   çıkan `37.91441, 40.23063` gibi değere tıklayıp kopyalayın, **Enlem** kutusuna yapıştırın (ikisi otomatik ayrılır).
6. **Yönetim › Kullanıcılar** › denetçileri ekleyin, mağaza yetkisi verin, ilk şifreyi kendilerine iletin.
7. **Yönetim › Ayarlar** › fotoğraf zorunluluğu, termin, mesafe sınırı (varsayılan 300 m).

Bu adresi telefon, tablet ve bilgisayardan açabilirsiniz; hepsi aynı verileri görür.
Telefonda tarayıcı menüsünden **Ana ekrana ekle** derseniz uygulama gibi açılır.

---

## Adım 5 (isteğe bağlı) — "Şifremi Unuttum" e-postası
Bu adım yapılmadan da portal tam çalışır; şifresini unutan kullanıcıya **Yönetim › Kullanıcılar › Düzenle**
bölümünden yeni şifre verebilirsiniz. Kullanıcıların kendi kendine e-postayla sıfırlaması için:

1. Gönderici olacak Gmail hesabında **2 Adımlı Doğrulama** açık olmalı (myaccount.google.com › Güvenlik).
2. https://myaccount.google.com/apppasswords › uygulama adı `JIBER Denetim` › **Oluştur** › çıkan 16 harfli şifreyi kopyalayın.
3. Vercel › projeniz › **Settings** › **Environment Variables** › iki kayıt ekleyin:
   - `SMTP_USER` = gmail adresiniz (ör. `cihankaymaaz@gmail.com`)
   - `SMTP_PASS` = kopyaladığınız 16 harfli şifre
4. **Deployments** › **⋯** › **Redeploy**.
5. Kontrol: **Yönetim › Ayarlar** altında "E-posta: Kurulu" yazmalı.

---

## Güncelleme nasıl yapılır?
GitHub'daki depoya değişen dosyayı tekrar yükleyin (aynı **Add file › Upload files**). Vercel otomatik yeniden yayınlar.
Veriler veritabanında olduğu için güncellemede hiçbir kayıt kaybolmaz.

## Son kontrol listesi
- [ ] Bilgisayarda mağaza ekleyin → telefondan girin, mağaza görünüyor mu?
- [ ] Telefondan denetim başlatın, birkaç cevap verip kapatın → bilgisayardan girin, "Devam eden denetimleriniz"de duruyor mu?
- [ ] Mağazada denetimi tamamlayın → raporda "✓ GPS Onaylı", konum, mesafe ve fotoğraflar var mı?
- [ ] Tarayıcı geçmişini/önbelleğini silin → tekrar girince raporlar duruyor mu?
- [ ] **Paylaş** bağlantısını başka cihazda açın → girişten sonra aynı rapor açılıyor mu?
- [ ] Denetçi hesabıyla girin → yalnızca yetkili mağazalar var, Yönetim menüsü yok mu?

## Nasıl çalışıyor (özet)
- **Şifreler** şifrelenmiş (scrypt) saklanır; düz metin tutulmaz. 8 hatalı denemede hesap 15 dk kilitlenir.
  Şifre değişince diğer cihazlardaki oturumlar kapanır.
- **Yetki** her istekte sunucuda kontrol edilir. Denetçi başka mağazanın / denetçinin verisini, fotoğrafını,
  raporunu açamaz; yönetim işlemleri yapamaz. Pasif yapılan kullanıcının oturumu anında düşer.
- **Tarih-saat** sunucuda yazılır, cihaz saatinden etkilenmez. **Rapor numarası** sunucuda sırayla verilir.
- **GPS**: Mesafe ve "GPS Onaylı" kararı **sunucuda** hesaplanır; telefondan gönderilen değer kabul edilmez.
  "Mesafe dışında engelle" açıksa sunucu dışarıdan tamamlamayı reddeder.
- **Kayıt kaybı yok**: Cevaplar her değişiklikte buluta kaydedilir; tamamlanan denetim silinemez/değiştirilemez.
- **Fotoğraflar** sıkıştırılıp veritabanına yazılır, yalnızca yetkili kişiye gösterilir.

## Bilinmesi gerekenler
- **Kapasite:** Neon ücretsiz planı 0,5 GB'dır, yaklaşık 2.000–3.000 fotoğraf eder. Dolmaya yaklaşınca Neon
  planını yükseltmek yeterli (Vercel › Storage › Neon › plan); kodda değişiklik gerekmez.
- **Sahte GPS uygulamaları:** Tarayıcı telefonun verdiği konumu kullanır; telefona sahte konum uygulaması kuran biri
  bunu atlatabilir. Rapordaki konum, doğruluk ve harita bağlantısı bunu fark etmeye yardımcı olur.
- Ana yönetici hesabı yalnızca veritabanı boşken ilk açılışta oluşturulur.
