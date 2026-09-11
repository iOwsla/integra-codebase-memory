MİMARİ GÜNCELLEME:
OTURUMA BAĞLI PROJE İZOLASYONU VE OTOMATİK İNDEKSLEME

Bu bölüm, önceki şartnamedeki kapsamla çelişen maddelerin
yerine geçer.

Amaç:
CodeMemory yalnızca bağlı MCP oturumunun açıkça seçilmiş
projesini indekslemeli ve izlemelidir.

Veritabanında kayıtlı başka projeler bulunması, onları
tarama, indeksleme, izleme veya sorgulama yetkisi vermez.

1. OTURUMUN PROJE SINIRI

Her MCP sunucu süreci bir ProjectContext ile başlatılsın:

- sessionId
- projectScopeId
- canonicalRoot
- effectiveConfig
- indexVersion

Bu bağlam uygulama servislerine taşınsın.

Global, değiştirilebilir bir "activeProject" değişkeni kullanma.

A projesinde açılan oturumun bağlamı, B projesinde başka
bir oturum açılması nedeniyle değişmemelidir.

2. AÇIK PROJE SEÇİMİ

Şu CLI sözleşmesini uygula:

codememory mcp --project <absolute-path> --auto-index --watch

İlk sürümde MCP modu için --project zorunlu olsun.

Sadece process.cwd() değerine bakarak proje tahmin etme.
Sunucunun kurulu olduğu klasörü proje kabul etme.
Son kullanılan projeye otomatik dönme.
Veritabanındaki ilk projeyi varsayılan seçme.

Proje sınırı belirlenemiyorsa PROJECT_ROOT_REQUIRED döndür.
Bu durumda dosya taraması veya watcher başlatma.

3. PROJE SINIRINI OTOMATİK GENİŞLETME

Verilen proje yolu gerçek yoluna normalize edilsin.

Seçilen klasörden otomatik olarak üst Git köküne çıkma.
Monorepo içindeki bir alt proje seçilmişse tüm monorepoyu
kendiliğinden kapsama alma.

Kardeş projeleri, üst klasörleri, nested repository'leri
ve submodule kaynaklarını otomatik kapsama ekleme.

Kapsam dışındaki bağımlılıklar external/unresolved olarak
gösterilebilir; kaynaklarını indekslemek için sınırı genişletme.

Standart derleyici kütüphaneleri veya gerekli dış metadata
okumaları gerekiyorsa bunları ayrı, açık bir allowlist ile
yönet. Bunları proje kaynak indeksi veya izlenecek proje
olarak değerlendirme.

4. GLOBAL TARAMA YOK

Şunları gerçekleştiren hiçbir otomatik yol oluşturma:

- Kullanıcının home klasöründe repo arama.
- Projects klasöründeki bütün repoları keşfetme.
- Veritabanındaki bütün repolar için watcher başlatma.
- Bütün kayıtlı projeleri açılışta yeniden indeksleme.
- Zamanlayıcıyla açık olmayan projeleri güncelleme.

Global kurulum, global tarama anlamına gelmemelidir.

5. İLK İNDEKS VE YENİDEN AÇILIŞ

Açıkça seçilmiş proje için auto-index etkinse:

İndeks yok:
- Yalnızca proje sınırındaki uygun dosyaları indeksle.

İndeks var:
- Kayıtlı indeksi kullan.
- Dosya ekleme, değiştirme ve silmeleri tespit et.
- Değişiklik yoksa sembol ve ilişki verisini yeniden yazma.

Parser, konfigürasyon ve şema sürümlerini hesaba kat.
Sadece dosya hash'ini karşılaştırmayı yeterli sayma.

6. ARTIMLI İNDEKSLEME DOĞRULUĞU

Değişen dosyayı yeniden analiz et.

Export, tip, import veya modül çözümleme değişikliği varsa
etkilenen bağımlı dosyaların ilişkilerini de yeniden çözümle.

Silinen hedeflerin gelen ilişkilerini temizle veya unresolved
durumuna getir. Hayalet sembol ve dangling edge bırakma.

Güvenli etki kapsamı hesaplanamıyorsa sadece bağlı proje içinde
daha geniş bir yeniden analiz yapabilirsin.

Bunun nedenini status ve log çıktısında belirt.
Başka projelere hiçbir zaman yayılma.

7. WATCHER YAŞAM DÖNGÜSÜ

Watcher yalnızca doğrulanmış canonicalRoot altında çalışsın.

Create, change, delete ve rename olaylarını işle.
Hızlı kayıt olaylarını debounce et.
Aynı dosyanın aynı içerik sürümü için işleri birleştir.

Aynı projeye bağlı eşzamanlı süreçlerde proje bazlı indeksleme
kilidi kullan; çakışan yazımları engelle.

Oturum kapandığında:
- Yeni otomatik iş kabulünü durdur.
- Watcher'ı kapat.
- Bekleyen işleri güvenle sonlandır.
- Sürmekte olan işlemi güvenli sınırda bitir veya geri al.
- Yalnızca bu sürecin sahip olduğu kilitleri bırak.

STDIN EOF, transport kapanması, SIGINT ve SIGTERM durumlarını
test et.

İlk sürümde oturumlardan bağımsız yaşayan global daemon yapma.

Aynı projeye bağlı başka oturum varsa onun çalışmasını kesme.
Son oturum kapandıktan sonra o projeye ait otomatik dosya
izleme veya indeksleme kalmamalıdır.

8. KAYNAK DOSYALAR VE HARİÇ TUTMALAR

.gitignore ve proje exclude kurallarını uygula.

Git'e henüz eklenmemiş ama ignore edilmemiş kaynak dosyaları
da izle. Yalnızca commit değişikliklerine bakma.

node_modules, build çıktıları, gizli anahtarlar ve secret
dosyalarını varsayılan olarak indeksleme.

.codememory içindeki uygulama durum dosyalarını watcher
kapsamından çıkar; kendi çıktısıyla indeksleme döngüsü yaratma.

Branch değişimi ve kaçırılan dosya olayları için yalnızca
aktif proje içinde sınırlandırılmış uzlaştırma mekanizması kur.

9. MONOREPO VE WORKTREE

Monorepo kökü açıkça seçilmişse kapsamı o kök belirler.

Alt proje açıkça seçilmişse üst projeye otomatik çıkılmaz.

Git worktree'leri ortak Git metadata dizini kullanıyor diye
aynı kaynak indeksi altında birleştirme.

Farklı checkout kökleri için ayrı indeks kimliği kullan.
Sadece remote URL veya proje adına göre kimlik oluşturma.

10. SORGULAR DA PROJEYE BAĞLI OLMALI

İzolasyon yalnızca indexer'da değil şu alanlarda da geçerli:

- Sembol arama ve sembol ID ile getirme.
- Caller/callee ve reference sorguları.
- Dosya içeriği ve outline.
- Graph traversal.
- Hafıza okuma ve yazma.
- Cache anahtarları.
- Hata ve durum çıktıları.
- Temizleme işlemleri.

Repository ID'yi modelin keyfi belirlemesine izin verme.
Bağlı projectScopeId değerini sunucu tarafından enjekte et.

Başka projeye ait symbolId veya memoryId verilince o projeyi
açığa çıkaran içerik döndürme.

Bir projede sonuç bulunamazsa otomatik olarak bütün projelerde
arama yapma.

11. HAFIZA İZOLASYONU

Kod indeksi yeniden oluşturulduğunda proje hafızasını silme.

Ancak başka projelerin hafızalarını otomatik yükleme.
Önceki şartnamedeki global hafıza scope'unu varsayılan MCP
erişiminden çıkar.

Çapraz proje hafızası ileride ayrı, açık izinli özellik olsun.

12. YOL GÜVENLİĞİ

Sadece startsWith(root) kontrolü kullanma.

Path normalization, platforma uygun containment kontrolü ve
symlink çözümlemesini birlikte uygula.

../ ile dışarı çıkışı ve proje dışına yönlenen symlink'leri
reddet.

Watcher, parser ve dosya okuma servisleri aynı sınır
politikasını kullansın.

Bu kontrolleri OS sandbox garantisi olarak tanıtma.

13. İNDEKS HAZIRLIĞI VE GÜNCELLİĞİ

MCP initialization yanıtını ilk indeksin tamamlanmasına bağlama.

Uzun indeksleme işi sunucu oturumu açıkken yürüyebilir.
İstemci durum aracından ilerlemeyi sorgulayabilsin.

İndeks hazır değilken boş sonuç döndürüp
"bu sembol mevcut değil" izlenimi verme.

Gerekirse INDEX_NOT_READY veya açıkça işaretlenmiş kısmi
sonuç döndür.

İndeks güncellenirken:
- Tutarlı son tamamlanmış sürümü sun veya
- Sorguyu sınırlandırılmış süreyle beklet.

Karışık, yarım güncellenmiş graph'ı güncelmiş gibi sunma.

Yanıtta uygun şekilde şunları belirt:
- indexVersion
- indexedAt
- pendingChanges
- freshness
- incomplete

14. DURUM VE TEŞHİS

codebase_status ve doctor şu bilgileri gösterebilsin:

- Bağlı proje kökü.
- Proje sınırının nereden geldiği.
- Proje kapsam kimliği.
- Auto-index açık/kapalı.
- Watcher açık/kapalı.
- İndeksleme durumu.
- Bekleyen değişiklik sayısı.
- Son başarılı indeks.
- Son yeniden analiz nedeni.
- Hariç tutulan dosya sayısı.

Normal proje MCP oturumundan diğer projelerin adlarını,
yollarını veya istatistiklerini listeleme.

15. ZORUNLU KABUL TESTLERİ

A ve B adlı iki geçici proje oluştur.

Test A:
Sadece A oturumunu aç.
B'nin kaynaklarını taramadığını, hash'lemediğini ve
indekslemediğini doğrula.

Test B:
B daha önce veritabanına kaydedilmiş olsun.
A açıldığında B için watcher veya indeks işi başlamasın.

Test C:
A'da kaynak dosyası değiştir.
A güncellensin; B'de işlem oluşmasın.

Test D:
A oturumu açıkken B'nin dosyalarını değiştir.
B için otomatik indeksleme oluşmasın.

Test E:
A ve B oturumlarını birlikte aç.
Her biri yalnızca kendi dosya, graph ve hafızasını görsün.

Test F:
A oturumunu kapat.
A'nın watcher'ı dursun; B çalışmaya devam etsin.

Test G:
A'nın MCP aracına B'ye ait dosya yolu, sembol ID ve hafıza ID
gönder. Kapsam dışı içerik döndürülmesin.

Test H:
Symlink, path traversal, monorepo alt proje ve ayrı Git
worktree senaryolarını doğrula.

Test I:
Değişmeyen projeyi yeniden aç.
Gereksiz sembol veya ilişki yeniden yazımı oluşmasın.

Test J:
Export veya tip değişikliği yap.
Değişmeyen bağımlı dosyaların etkilenen ilişkileri doğru
güncellensin.

Sadece veritabanı kayıtlarını kontrol etmekle yetinme.
Scanner, hasher, parser ve watcher çağrılarını ölçerek kapsam
dışındaki projelerin gerçekten işlenmediğini kanıtla.

Bu davranışları docs/project-isolation.md içinde belgele.
Önceki implementation-status ve kabul kriterlerini güncelle.