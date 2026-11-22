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

### Qualidade: integrada ao Go Live do Discord

**Uma fonte da verdade.** Resolução e FPS são sempre os do próprio Go Live do Discord, ou seja, o que aparece no resumo da janela de compartilhar ("Personalizada · 1440p · 60fps"). O VDOShare lê essas configurações, captura exatamente isso e grava de volta no Discord o que está usando. Assim, a janela do Go Live, o menu ⚙ dela, o menu "Configurações da transmissão" durante a live e o resto do Discord mostram sempre a mesma coisa.

**Opções Nitro liberadas em todo o Discord** ("Liberar opções Nitro da transmissão", ligado por padrão):

- **Menu ⚙ da janela do Go Live:** em "Personalizada", as listas completas aparecem **sem o ícone de Nitro**:
  - Resolução da tela: 480p, 720p, 1080p, 1440p, **4K (2160p)** e Fonte;
  - Taxa de quadros: 5, 15, 30, 60, **90, 120, 144, 240** fps.
- **Rodapé da janela:** o seletor **SD/HD** e o banner **"Transmita em resolução HD com Nitro / Obter o Nitro"** somem.
- **Durante a live:** em **Configurações da transmissão** (menu do botão de transmissão no painel de voz), as mesmas resoluções e FPS ficam disponíveis.
- **Validador:** o validador do Discord (`canStreamWithSettings`, o mesmo ponto que o [YABDP4Nitro](https://github.com/riolubruh/YABDP4Nitro) usa) aceita qualquer combinação. Por isso o Discord não volta para 720p30 ao iniciar.

**Opções do VDOShare dentro do menu do Discord.** No fim do menu ⚙ do Go Live, e dentro de "Configurações da transmissão" durante a live, há um submenu **VDOShare** com:

- **Bitrate máximo:** Automático (mostra o valor calculado), 2,5 / 4 / 6 / 8 / 12 / 20 / 30 Mbps;
- **Codec de vídeo:** Automático, H.264, VP9, AV1, VP8;
- **Copiar link de visualização**;
- **Mais opções de qualidade…:** janela com resolução, FPS (os mesmos do Go Live), bitrate máximo/mínimo, bitrate do áudio e codec. Também abre com **`/vdoshare-qualidade`**.

**Aplica na hora, sem compartilhar de novo.** Qualquer mudança feita com a transmissão no ar é aplicada na mesma conexão, sem derrubar quem assiste. Vale para o menu do Discord, o submenu VDOShare, a janela "Mais opções" e as configurações do plugin.

| Mudança | O que acontece |
|---|---|
| Resolução ou FPS | a fonte é recapturada e a faixa de vídeo é trocada (`replaceTrack`) |
| Som ligado/desligado | a faixa de áudio é adicionada ou removida (`addTrack`/`removeTrack`) |
| Bitrate ou codec | aplicado direto nas conexões (`updatePublisherMedia`), sem recapturar |

Bitrate automático: de 1,5 a 20 Mbps, conforme resolução × FPS. Cada espectador consome esse upload. Com 15 fps ou menos (modo "Compartilhamento de tela"), o plugin usa `contentHint = detail`; acima disso, usa `motion`.

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

**Qualidade:** escolha resolução e FPS no menu ⚙ da janela do Go Live, como sempre; as opções Nitro ficam liberadas. Bitrate e codec ficam no submenu **VDOShare** do mesmo menu. Para mudar com a transmissão no ar, use "Configurações da transmissão" no botão de transmissão do painel de voz: a mudança vale na hora, sem compartilhar de novo.

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
| Qualidade | Resolução e FPS (mostra os atuais do Go Live; botão "Alterar") | os do Go Live do Discord |
| | Liberar opções Nitro da transmissão | Ligado |
| | Bitrate máx./mín., bitrate do áudio, codec | Automático |
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
| Opções do Go Live continuam com cadeado, ou o SD/HD e o banner do Nitro aparecem | Uma atualização do Discord mudou a janela. Use `/vdoshare-qualidade` (resolução, FPS e bitrate funcionam mesmo assim) e abra uma issue com o erro do console. |
| O submenu VDOShare não aparece no menu ⚙ | Mesmo caso: use `/vdoshare-qualidade` ou as configurações do plugin. |
| Travando ou com baixa qualidade | Reduza a resolução, o FPS ou o bitrate máximo. Cada espectador consome upload. |
| Quero o Go Live normal do Discord | Desative **"Usar o Go Live do Discord"** ou o plugin. |

## Créditos

- Ponte do Go Live nativo adaptada de [ADCDS/discord-byo-stream](https://github.com/ADCDS/discord-byo-stream) (MIT; veja [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)).
- [VDO.Ninja](https://vdo.ninja) e o [SDK do VDO.Ninja](https://github.com/steveseguin/ninjasdk), de Steve Seguin (MPL-2.0).
- Rich Presence local inspirado no plugin CustomRPC do Vencord.
- Desbloqueio da qualidade do Go Live derivado do [YABDP4Nitro](https://github.com/riolubruh/YABDP4Nitro), de Riolubruh e colaboradores (OSL-3.0). O aviso de atribuição dele está mantido no topo do plugin.

## Licença

[Open Software License 3.0 (OSL-3.0)](./LICENSE.md), por ser obra derivada do YABDP4Nitro. Partes adaptadas do discord-byo-stream são MIT; veja [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
