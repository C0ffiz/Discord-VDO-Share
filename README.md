# Discord VDO Share

Plugin para o [BetterDiscord](https://betterdiscord.app) que **reativa o Go Live nativo do Discord** (o botão **"Compartilhar Tela"**) e transmite a sua tela **direto do Discord** via [VDO.Ninja](https://vdo.ninja), sem abrir navegador. A mídia é P2P (WebRTC) e não passa pelos servidores de mídia do Discord. Por isso funciona onde o Go Live está bloqueado (como no Brasil desde agosto de 2026) e chega a 1080p+ sem Nitro.

- Você usa a interface de sempre do Discord: botão **Compartilhar Tela**, seletor de janela/tela, qualidade, selo **AO VIVO**, a sua prévia da transmissão e **Parar transmissão**.
- O seu perfil ganha um **Rich Presence** com o botão **"Assistir Transmissão"** e o número de espectadores.
- Quem clicar no botão assiste **no navegador**: não precisa de conta, de instalação, de configurar sala nem do plugin.
- Parar a transmissão no Discord encerra tudo e remove o Rich Presence.

> [!WARNING]
> Mods de cliente (BetterDiscord incluído) violam os Termos de Serviço do Discord. Use por sua conta e risco.

---

## Como funciona

```
Discord + BetterDiscord                                   Navegador de quem assiste
┌────────────────────────────────────────────┐            ┌───────────────────────────┐
│ Botão "Compartilhar Tela" (desbloqueado)   │            │ vdo.ninja/?view=ID        │
│   → seletor do Discord → "Go Live"         │   WebRTC   │ (sem conta, sem instalar) │
│ VDOShare intercepta as ações do Go Live,   │ ─────────► │                           │
│ captura a fonte no próprio Discord e       │    P2P     └───────────────────────────┘
│ publica com o SDK do VDO.Ninja             │                        ▲
│ Rich Presence: [Assistir Transmissão] ─────┼────────── link ────────┘
└────────────────────────────────────────────┘
```

**Ponte do Go Live nativo.** A abordagem é adaptada de [ADCDS/discord-byo-stream](https://github.com/ADCDS/discord-byo-stream) (`plugin/src/native.js`):

1. **Desbloqueio.** Sobrescreve o experimento do cliente `2026-08-video-guard` (`videoEnabled: true`), que é o que esconde ou trava o Go Live por região.
2. **Seletor.** No Windows e no macOS, desativa o seletor de sistema e as prévias do motor nativo, para que a janela de fontes do próprio Discord entregue IDs que o Chromium consegue capturar. No Linux, o seletor do sistema (portal) é aberto pelo Chromium.
3. **Ações.** Um interceptor no Flux Dispatcher trata `MEDIA_ENGINE_SET_GO_LIVE_SOURCE`, `STREAM_START`, `STREAM_WATCH` (a sua prévia) e `STREAM_STOP`. As chamadas de gateway **da sua transmissão** (`streamCreate`, `streamDelete`, …) são descartadas. As transmissões de outras pessoas não são afetadas.
4. **Estado na interface.** O plugin despacha localmente `STREAM_UPDATE`, `VOICE_STATE_UPDATES` (`selfStream`) e `RTC_CONNECTION_VIDEO`. O selo AO VIVO e o bloco da sua transmissão aparecem como num Go Live normal, e o bloco mostra a sua captura.

**Captura e envio.**
- **Captura:** `getUserMedia` com `chromeMediaSource: "desktop"` e o ID da fonte escolhida no seletor do Discord.
- **Telas paradas:** quando a imagem não muda, o plugin reenvia o último quadro (≥ 5 fps), para quem entra não ver tela preta.
- **Envio:** pelo [SDK do VDO.Ninja](https://github.com/steveseguin/ninjasdk) (`@vdoninja/sdk` **1.6.2**, MPL-2.0) com `salt: "vdo.ninja"`. Assim, um link comum `https://vdo.ninja/?view=ID` assiste à transmissão.
- **Download do SDK:** o SDK é baixado do jsDelivr (ou unpkg) ao iniciar. O plugin confere o **SHA-256** fixado e recusa qualquer arquivo diferente.

### Qualidade: desbloqueada e personalizável

**Seletor do Go Live desbloqueado (sem Nitro).** O plugin sobrescreve as duas verificações que o seletor do Discord consulta: o validador `canStreamWithSettings` e a checagem de preset/resolução/FPS. São os mesmos pontos documentados pelo [YABDP4Nitro](https://github.com/riolubruh/YABDP4Nitro); a implementação aqui é própria. Com isso, todas as opções ficam selecionáveis: 720p, 1080p, 1440p, **Nativa**, 15/30/**60** fps. O que você escolher é o que o plugin captura e envia.

**Qualidade personalizada.** Para valores fora do seletor (4K, 120 fps, um bitrate fixo…), ligue **"Usar qualidade personalizada"**. Ela pode ser ajustada em três lugares:

- pelo botão **⚙ VDOShare** no rodapé da janela do Go Live;
- pelo comando **`/vdoshare-qualidade`**;
- em **Configurações → Qualidade**.

| Opção | Padrão | Observação |
|---|---|---|
| Resolução (altura) | a do seletor | 0 = nativa; até 4320 px. Telas ultrawide mantêm a altura pedida |
| FPS | o do seletor | 1–240 |
| Bitrate máximo | automático (1,5–20 Mbps conforme resolução × FPS) | cada espectador consome esse upload |
| Bitrate mínimo | nenhum | nem todo navegador respeita |
| Bitrate do áudio | padrão do SDK | — |
| Codec de vídeo | automático | H.264 / VP9 / AV1 / VP8 (preferência do transmissor) |

Predefinições de um clique: **4K 60**, **1440p 60**, **1080p 120**, **1080p 60**, **720p 60**, **Texto (1440p 15)**, **Nativa 60** e **Seguir o Discord**.

**Mudanças ao vivo, sem derrubar quem assiste:**
- **Resolução ou FPS:** a fonte é recapturada e a faixa é trocada na mesma conexão (`replaceTrack`).
- **Bitrate ou codec:** aplicados direto nas conexões (`updatePublisherMedia`).
- **Pelo Discord:** mudar a qualidade durante a transmissão no próprio popout do Discord também funciona.

Com "Melhor legibilidade" (≤ 15 fps), o plugin usa `contentHint = detail`. Acima disso, usa `motion`.

### Áudio

O Discord não tem o seletor de áudio do navegador. O plugin captura áudio pela API de captura do Electron, que só funciona assim:

| Sistema | Com "Som" ligado no seletor do Go Live |
|---|---|
| **Windows** | ✅ Áudio **do sistema inteiro**. ⚠️ Isso inclui o som da chamada de voz: quem estiver na chamada e assistindo pode se ouvir com atraso. |
| macOS | ❌ sem áudio |
| Linux | ❌ sem áudio |

Para transmitir **só o áudio de uma aba** com o seletor nativo do Chrome, use o **Modo navegador** (veja abaixo).

---

## Requisitos

- Discord desktop com o **BetterDiscord** atualizado.
- Em **Configurações do Discord → Privacidade de atividade**, ative **"Compartilhar a sua atividade detectada com outras pessoas"**. Sem isso, o Rich Presence não aparece.
- Upload suficiente: cada espectador recebe uma conexão P2P direta sua.

## Instalação

1. Baixe [`VDOShare.plugin.js`](./VDOShare.plugin.js).
2. **Configurações → BetterDiscord → Plugins → Abrir pasta de plugins** e coloque o arquivo lá.
3. Ative o **VDOShare**.
4. Configure o **Application ID** (próxima seção).

> Se você usava a v1, basta substituir o arquivo. As configurações e o Stream ID são mantidos.

### Application ID (necessário para o botão do Rich Presence)

1. Acesse <https://discord.com/developers/applications> → **New Application**.
2. Dê um nome (ex.: "Transmissão ao vivo") e crie.
3. Copie o **Application ID** em *General Information*.
4. Cole em **Configurações do plugin → Rich Presence → Application ID**.

Não é preciso bot nem token.

---

## Uso

1. Entre em um canal de voz e clique em **Compartilhar Tela**, como sempre.
2. Escolha a janela ou tela, a qualidade e se quer **som**, e clique em **Transmitir** (Go Live).
3. O seu nome ganha o selo **AO VIVO**, o perfil mostra **"Assistir Transmissão"** e o link de visualização é copiado.
4. Para encerrar, use **Parar transmissão** no Discord. Fechar a janela compartilhada também encerra a transmissão.

**Qualidade:** no seletor do Go Live, todas as resoluções e FPS ficam liberadas. O botão **⚙ VDOShare** no rodapé (ou `/vdoshare-qualidade`) abre o ajuste fino, que pode ser usado também com a transmissão no ar.

**Sem canal de voz:** o comando **`/vdoshare`** abre um seletor do plugin (com opção de áudio no Windows) e transmite do mesmo jeito. Rode `/vdoshare` de novo para encerrar.

**Modo navegador:** em **Configurações → Ações → Navegador**, o plugin abre o VDO.Ninja no seu navegador padrão. Ali o seletor do Chrome/Edge permite compartilhar o **áudio de uma aba**. O encerramento usa o API remoto do VDO.Ninja (`&api=`), e o plugin percebe quando você fecha a aba.

### Quem assiste

- O link abre direto no player do VDO.Ninja, em qualquer navegador moderno.
- Antes de você escolher a fonte, aparece a mensagem de espera. O vídeo entra sozinho em seguida.
- **Som:** o navegador pode exigir **um clique** no play antes de tocar vídeo com áudio. Nenhum parâmetro de URL contorna isso. Quem assiste sempre pode liberar `vdo.ninja` em `chrome://settings/content/sound`.
- Outros usuários do Discord **não** veem a sua transmissão dentro do Discord. Eles assistem pelo botão "Assistir Transmissão".
- Você não vê o botão do próprio Rich Presence (limitação do Discord), mas os outros veem.

---

## Configurações

| Seção | Opção | Padrão |
|---|---|---|
| Ações | Transmitir/encerrar (escolher fonte), modo navegador, copiar link, gerar novo ID | — |
| Transmissão | Usar o Go Live do Discord | Ligado |
| | Manter imagem em telas paradas | Ligado |
| | ID fixo ou novo a cada transmissão, Stream ID, rótulo | Fixo |
| | Servidor de sinalização | Padrão do VDO.Ninja |
| Qualidade | Ajuste rápido (predefinições, aplica ao vivo) | — |
| | Desbloquear todas as opções do Go Live | Ligado |
| | Qualidade personalizada: resolução, FPS, bitrate máx./mín., bitrate do áudio, codec | Desligado (segue o seletor) |
| Link de visualização | `&stereo`, `&bitrate`, `&codec`, mensagem de espera, parâmetros extras | `&stereo` + mensagem |
| Rich Presence | Ativar, Application ID, nome, tipo (Assistindo…), linhas, nº de espectadores, texto do botão, imagem, copiar link | Assistindo |
| Modo navegador | Parâmetros extras do transmissor, URL da API | — |

## Privacidade e segurança

- O **Stream ID** (12 caracteres aleatórios) é o que dá acesso à transmissão: quem tem o link pode assistir. Use **"Novo a cada transmissão"** ou **"Gerar novo ID"** para invalidar links antigos.
- A mídia vai de você direto para quem assiste, criptografada pelo WebRTC. Os servidores do VDO.Ninja fazem só a sinalização, e um relay TURN quando a conexão direta não é possível.
- O SDK é baixado em uma versão fixa e conferido por hash antes de ser executado.

## Solução de problemas

| Problema | Solução |
|---|---|
| O botão "Compartilhar Tela" continua travado | Veja o status em **Configurações → Ações**. Uma atualização do Discord pode ter mudado o experimento ou os módulos: use `/vdoshare` enquanto isso e abra uma issue com o erro do console (Ctrl+Shift+I). |
| "não foi possível carregar o SDK" | O jsDelivr e o unpkg estão inacessíveis na sua rede ou o arquivo mudou. Tente de novo mais tarde. |
| Tela preta para quem assiste | Aguarde alguns segundos. Confirme que "Manter imagem em telas paradas" está ligado. |
| Sem som | Só o Windows captura áudio no Discord. No macOS e no Linux, use o Modo navegador com uma aba. |
| O botão "Assistir Transmissão" não aparece para os outros | Confira o **Application ID** e a opção de compartilhar atividade. |
| O seletor do Go Live continua com opções travadas | Uma atualização do Discord mudou as verificações. Use **qualidade personalizada** (funciona mesmo assim) e abra uma issue. |
| O botão ⚙ VDOShare não aparece na janela do Go Live | O layout da janela mudou. Use `/vdoshare-qualidade` ou as configurações do plugin. |
| Travando ou com baixa qualidade | Reduza a resolução, o FPS ou o bitrate máximo. Cada espectador consome upload. |
| Quero o Go Live normal do Discord | Desative **"Usar o Go Live do Discord"** ou o plugin. |

## Créditos

- Ponte do Go Live nativo adaptada de [ADCDS/discord-byo-stream](https://github.com/ADCDS/discord-byo-stream) (MIT; veja [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)).
- [VDO.Ninja](https://vdo.ninja) e o [SDK do VDO.Ninja](https://github.com/steveseguin/ninjasdk), de Steve Seguin (MPL-2.0).
- Rich Presence local inspirado no plugin CustomRPC do Vencord.
- Pontos de desbloqueio da qualidade do Go Live identificados a partir do [YABDP4Nitro](https://github.com/riolubruh/YABDP4Nitro) (OSL-3.0). Nenhum código dele foi copiado; a implementação é própria.
