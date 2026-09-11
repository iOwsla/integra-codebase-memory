# Codex kurulumu

Önce [ortak kurulumu](common.md) tamamlayın. CodeMemory kurulum klasöründe:

```sh
bun run connect:codex /absolute/target-project
bun run connect:codex /absolute/target-project --write
```

İlk komut önizleme yapar; ikincisi hedef projenin `.codex/config.toml` dosyasını
oluşturur. Mevcut farklı ayarlar ezilmez: bu durumda önizlemedeki tabloyu mevcut
dosyaya birleştirin. Aynı kurulum tekrar çalıştırılabilir. Üretilen dosyada makineye
özel yollar vardır; hedef projenin Git ignore kurallarına ekleyin.

Manuel ayar örneği:

```toml
[mcp_servers.integra_code_memory]
command = "/absolute/path/to/bun"
args = ["/absolute/integra-codebase-memory/apps/cli/src/index.ts", "mcp", "--project", "/absolute/target-project", "--auto-index", "--watch"]
cwd = "/absolute/target-project"
env_vars = ["DATABASE_URL"]
startup_timeout_sec = 30
tool_timeout_sec = 60
enabled = true
```

Codex güvenilen projelerde proje kapsamlı `.codex/config.toml` dosyasını yükler.
Bağlantı ayarı ile AI talimatları ayrı dosyalardır. Hedef proje kökündeki
`AGENTS.md` içine [hazır bloğu](../instructions/AGENTS.md) yerleştirin. Bu deponun
kendi AGENTS.md dosyası zaten bloğu içerir. Global kurallar başka bir sunucunun
araçlarını zorunlu tutuyorsa bu ayrımı orada da netleştirin.

Codex bağlantısını yeniden başlatın veya uygulamayı kapatıp açın; hedef projeyi
açın. MCP listesinde `integra_code_memory` görünmesini ve [canlı sorgu
kontrolünü](common.md#doğrulama-ve-sorun-giderme) doğrulayın. Bazı istemciler araç
adlarına sunucu öneki ekler; talimattaki kısa adların sunucuya ait sürümünü kullanın.

Kurulum komutu diğer MCP sunucularını kapatmaz, global ayarları değiştirmez ve
çalışan sohbeti otomatik yenilemez. Bu depoda bağlantı ve doğrudan sohbetten
`codebase_status` sorgusu doğrulanmıştır; başka makinede yeniden kontrol gerekir.

Kaynak: [Resmî Codex MCP yapılandırması](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
