# Ortak kurulum: CodeMemory sunucusu

CodeMemory deposu sunucunun kurulu olduğu yerdir; hedef proje ise indekslenecek
depodur. Bunlar farklı klasörler olabilir. Komutlardaki `/absolute/...` değerlerini
kendi tam yollarınızla değiştirin. Yerel Bun ve PostgreSQL kullanılır; API anahtarı
gerekmez. Bu paket kaynak deposuyla çalışır, bağımsız tek dosyalık binary değildir.

## Ön koşullar ve ilk hazırlık

Bun 1.3.3+, Git ve Docker Compose gerekir. macOS/Linux doğrulama kapsamındadır;
Windows henüz doğrulanmamıştır. Docker yerine `vector` ve `pg_trgm` eklentilerini
destekleyen PostgreSQL de kullanılabilir.

```sh
git clone https://github.com/iOwsla/integra-codebase-memory.git
cd integra-codebase-memory
bun install --frozen-lockfile
docker compose up -d --wait
bun run db:migrate
```

Bun ve kurulum klasörünün tam yolunu öğrenin:

```sh
command -v bun
pwd
```

Migration komutu yalnızca CodeMemory'nin indeks veritabanında çalıştırılmalıdır.
Hedef uygulamanın veritabanını `DATABASE_URL` olarak vermeyin. Varsayılan geliştirme
veritabanı `127.0.0.1:55432` üzerindedir; kimlik bilgileri Compose dosyasındadır.
Özel veritabanında `DATABASE_URL` değerini istemcinin ortamında sağlayın; sırları
paylaşılan MCP ayarlarına veya talimat dosyalarına yazmayın.

MCP açılışında migration, Docker başlatma veya bağımlılık kurulumu yapılmaz.
Makine yeniden açıldığında PostgreSQL'in çalışıyor olduğunu doğrulayın. Kaynak
kurulumunu ve `node_modules` dizinini koruyun. Sunucunun başlangıç dosyası:
`/absolute/integra-codebase-memory/apps/cli/src/index.ts`.

## İstemciyi seçin

- [Codex kurulumu](codex.md)
- [Claude Code kurulumu](claude-code.md)

Her hedef proje için ayrı bağlantı oluşturun. Global bir bağlantıya tek sabit
proje yolu yazmak, başka projede çalışırken yanlış indeksi kullanmanıza yol açar.
Aynı hedef için iki istemci açılırsa süreçler ayrı watcher çalıştırabilir; aynı
indeksin yazımı kilitle sıraya alınır. Bu, ortak bir daemon değildir.

## Talimatları yerleştirme

[AGENTS.md şablonu](../instructions/AGENTS.md) ve
[CLAUDE.md şablonu](../instructions/CLAUDE.md) aynı bağımsız talimat bloğunu içerir.
Hedef dosya yoksa uygun şablonu o adla proje köküne kaydedin. Dosya zaten varsa
`integra-code-memory:start/end` bloğunu birleştirin; proje kurallarını ezmeyin.
Güncellemede yalnızca aynı işaretli bloğu değiştirin, ikinci kopyasını eklemeyin.

Önceki `codebase-memory-mcp` talimatları başka sunucuya aittir. İki sunucu da
kullanılacaksa kurallarını sunucu adıyla ayırın. Bizim araçlarda bulunmayan
`search_graph` veya `check_index_coverage` çağrılarını zorunlu tutmayın.
Bu şablonlar AI davranışını yönlendirir; eksiksizlik veya her çağrıda uyum garantisi
veren bir erişim kontrolü değildir.

## Doğrulama ve sorun giderme

İstemciye şunu yazın:

> integra_code_memory üzerinden codebase_status çağır. Proje kökünü, indeks
> sürümünü, bekleyen değişiklikleri ve eksiklikleri bildir. Ardından projede var
> olan bir fonksiyonu search_symbols ile bul ve ID'siyle find_callers sorgula.

Beklenen: doğru kök, READY, autoIndex=true, watcher=true; bekleyen değişiklikler
sonunda sıfırlanır. Dosya hataları ve incomplete ayrıca değerlendirilir. Boş çağıran
listesi tek başına bağlantı hatası veya ölü kod kanıtı değildir.

İstemciden bağımsız protokol kontrolü (CodeMemory kurulum klasöründe):

```sh
bun run verify:mcp /absolute/target-project exactDeclaredFunctionName
```

Bu komut hedefin kalıcı indeksini oluşturur/günceller. İstemcinin kendi araç
listesini yüklediğini tek başına kanıtlamaz. Geçici test için `simulate:project`
kullanın. Yanlış kökte bağlantı varsa sorgulamayı durdurup ayardaki `--project`
yolunu düzeltin. INDEX_BUSY geçiciyse bekleyin; INDEX_NOT_READY sonucunu boş liste
saymayın. Bağlantı hatasında PostgreSQL, bağımlılıklar ve mutlak yolları kontrol
edin. Konfigürasyon değişince istemci bağlantısını yeniden başlatın.
