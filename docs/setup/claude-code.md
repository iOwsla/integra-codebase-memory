# Claude Code kurulumu

Önce [ortak kurulumu](common.md) tamamlayın ve Claude Code CLI'ın kurulu olduğundan
emin olun. Aşağıdaki komutu **hedef proje klasöründe** çalıştırın:

```sh
cd /absolute/target-project
claude mcp add --transport stdio --scope local integra_code_memory -- \
  /absolute/path/to/bun \
  /absolute/integra-codebase-memory/apps/cli/src/index.ts \
  mcp --project /absolute/target-project --auto-index --watch
```

`local` kapsamı bu kaydı yalnızca o proje için, kişisel Claude ayarlarında tutar.
Makineye özel yolları diğer projelere yaymaz. Kayıt zaten varsa önce
`claude mcp get integra_code_memory` ile inceleyin; aynı adla ikinci kayıt eklemeyin.
Özel veritabanı kullanılacaksa Claude Code'u CodeMemory'ye ait `DATABASE_URL`
ortamıyla başlatın. Bağlantı sırrını komut geçmişine veya ortak dosyaya yazmayın.

## Ekip için alternatif: .mcp.json

Proje kökündeki `.mcp.json` dosyasına aşağıdaki sunucu kaydı birleştirilebilir.
Diğer `mcpServers` kayıtlarını koruyun. Bu, yukarıdaki local kurulumun alternatifidir;
ikisini aynı adla birlikte kurmayın. Örnek yollar makineye özeldir; paylaşmadan önce
ekibin yol/ortam stratejisini belirleyin ve sırları çıkarın.

```json
{
  "mcpServers": {
    "integra_code_memory": {
      "type": "stdio",
      "command": "/absolute/path/to/bun",
      "args": [
        "/absolute/integra-codebase-memory/apps/cli/src/index.ts",
        "mcp", "--project", "/absolute/target-project",
        "--auto-index", "--watch"
      ]
    }
  }
}
```

Claude Code proje kapsamlı MCP kayıtları için güven/onay adımı gösterebilir.
Bu onay istemci davranışıdır; bağlantının doğrulanması sırasında kontrol edin.

## CLAUDE.md talimatları

Claude Code için talimat dosyası proje kökündeki `CLAUDE.md` dosyasıdır.
[Bağımsız hazır bloğu](../instructions/CLAUDE.md) mevcut kuralları koruyarak ekleyin.

Aynı proje Codex de kullanıyorsa, AGENTS.md içine hazır bloğu koyup CLAUDE.md'de
onu içe almak tercih edilebilir:

```markdown
@AGENTS.md
```

İçe alma kullanıyorsanız aynı bloğu CLAUDE.md'ye ayrıca kopyalamayın. Bu CodeMemory
deposu bu yöntemi kullanır; iki istemci aynı talimatı okur.

## Bağlantıyı doğrulama

```sh
claude mcp list
claude mcp get integra_code_memory
```

Hedef klasörde Claude Code'u başlatın/yeniden açın. `/mcp` ile sunucunun bağlantısını,
`/context` ile CLAUDE.md talimatlarının yüklenmesini kontrol edin. Ardından
[canlı sorgu kontrolünü](common.md#doğrulama-ve-sorun-giderme) yaptırın. Proje kökü
ve indeks durumunu gerçek araç yanıtından görmeden çalışıyor saymayın.

Bu rehber resmî istemci belgelerine dayanır. STDIO sunucumuz gerçek SDK istemcisiyle
test edilmiştir; bu değişiklikte Claude Code oturumunda uçtan uca kurulum çalıştırılmadı.

Kaynaklar: [Claude Code MCP](https://code.claude.com/docs/en/mcp),
[CLAUDE.md ve AGENTS.md içe alma](https://code.claude.com/docs/en/memory).
