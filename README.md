# Discord VDO Share

Plugin para o [BetterDiscord](https://betterdiscord.app) que usa o próprio botão **"Compartilhar Tela"** do Discord para transmitir sua tela via [VDO.Ninja](https://vdo.ninja). A transmissão é **P2P (WebRTC)** e não passa pelos servidores de mídia do Discord: sem limite de 720p/30fps, sem Nitro.

Quando você inicia uma transmissão:

1. O seu navegador abre o **seletor nativo** de tela / janela / aba, com a opção de **incluir o áudio do sistema**.
2. O seu perfil ganha um **Rich Presence** com o botão **"Assistir Transmissão"**.
3. Quem clicar nesse botão abre o link no navegador e assiste na hora: sem conta, sem instalar nada, sem configurar sala.
4. Clicar de novo no botão de compartilhar tela **encerra** a transmissão e remove o Rich Presence.

---

## Como funciona

```
 Discord (BetterDiscord)                          Navegador padrão (Chrome/Edge)
 ┌─────────────────────────────┐   abre link     ┌──────────────────────────────┐
 │ clique em "Compartilhar     │ ──────────────► │ vdo.ninja/?push=ID           │
 │ Tela" (interceptado)        │                 │   &screenshare&autostart     │
 │                             │                 │   &api=CHAVE ...             │
 │ Rich Presence               │                 │ seletor nativo + áudio       │
 │  [Assistir Transmissão] ────┼──┐              └──────────────┬───────────────┘
 └──────────────┬──────────────┘  │                             │ WebRTC P2P
                │ hangup/getDetails│                             ▼
                ▼                  │  link        ┌──────────────────────────────┐
        api.vdo.ninja (HTTP) ──────┘ ──────────►  │ vdo.ninja/?view=ID  (quem    │
                                                  │ assiste, em qualquer browser)│
                                                  └──────────────────────────────┘
```

- **Captura fora do Discord.** O Electron do Discord não expõe o seletor de tela do navegador e tem limitações de áudio. Por isso o plugin abre a página de transmissão no seu **navegador padrão**. Ali você tem exatamente a experiência de um navegador moderno: escolher tela, janela ou aba e marcar "compartilhar áudio".
- **Interceptação do botão.** Um listener de clique (fase de captura) reconhece o botão de compartilhar tela pelo `aria-label`, em vários idiomas, e impede o Discord de abrir o Go Live nativo.
- **Rich Presence** via `LOCAL_ACTIVITY_UPDATE`, o mesmo mecanismo usado por plugins de RPC personalizado.
- **Encerramento remoto.** O link do transmissor inclui `&api=CHAVE`. Ao encerrar, o plugin chama `https://api.vdo.ninja/CHAVE/hangup`. Enquanto a transmissão está ativa, ele consulta `getDetails` a cada 15 s. Se a aba for fechada, o Rich Presence é removido sozinho.

### Links gerados (padrão)

Transmissor (abre no seu navegador; **contém sua chave privada**):

```
https://vdo.ninja/?push=ID&screenshare&autostart&screensharequality=0&screensharefps=60&screensharecontenthint=motion&stereo&api=CHAVE&easyexit
```

Espectador (vai no botão do Rich Presence):

```
https://vdo.ninja/?view=ID&stereo&bitrate=6000&waitmessage=A%20transmiss%C3%A3o%20vai%20come%C3%A7ar%20em%20instantes...&waittimeout=0
```

| Parâmetro | Lado | Por quê |
|---|---|---|
| `&push=ID` / `&view=ID` | ambos | Transmissão direta, sem sala (`&room`). |
| `&screenshare` + `&autostart` | transmissor | Vai direto ao seletor de tela e começa assim que a fonte é escolhida. |
| `&screensharequality=0` | transmissor | Alvo de 1080p (`-1` = resolução nativa). |
| `&screensharefps=60` | transmissor | FPS alvo da captura. |
| `&screensharecontenthint=motion` | transmissor | Prioriza fluidez (`detail` prioriza nitidez de texto). |
| `&stereo` | ambos | Áudio estéreo de alta qualidade, sem cancelamento de eco/ruído (ideal para áudio do sistema). |
| `&api=CHAVE` | transmissor | Permite que o plugin encerre a transmissão e detecte se a aba fechou. |
| `&easyexit` | transmissor | Sem o pop-up "deseja sair?" ao fechar a aba. |
| `&bitrate=6000` | espectador | Pede 6 Mbps ao transmissor (o bitrate é definido no lado de quem assiste). |
| `&waitmessage` + `&waittimeout=0` | espectador | Mensagem amigável enquanto a transmissão conecta. |

---

## Requisitos

- Discord desktop com **BetterDiscord** atualizado (usa `BdApi.UI.buildSettingsPanel`, `BdApi.Net.fetch` e, se disponível, `BdApi.Commands`).
- **Google Chrome ou Microsoft Edge como navegador padrão.** O Firefox não captura áudio do sistema. Se o seu padrão for outro, use **Configurações → Copiar link do transmissor** e abra no Chrome/Edge.
- Em **Configurações do Discord → Privacidade de atividade**, ative **"Compartilhar a sua atividade detectada com outras pessoas"**. Sem isso, o Rich Presence não aparece.
- Upload suficiente: cada espectador recebe um stream P2P direto de você. Veja [Muitos espectadores](#muitos-espectadores).

## Instalação

1. Baixe [`VDOShare.plugin.js`](./VDOShare.plugin.js).
2. No Discord: **Configurações → BetterDiscord → Plugins → Abrir pasta de plugins** e coloque o arquivo lá.
3. Ative o plugin **VDOShare**.
4. Configure o **Application ID** (próxima seção).

### Criando o Application ID (necessário para o botão)

O Discord só exibe botões de Rich Presence ligados a uma aplicação.

1. Acesse <https://discord.com/developers/applications> → **New Application**.
2. Dê o nome que quiser (ex.: "Transmissão ao vivo") e crie.
3. Copie o **Application ID** da página *General Information*.
4. No plugin: **Configurações → Rich Presence → Application ID** e cole.

Não é preciso bot, token nem OAuth: só o ID.

---

## Uso

1. Entre em um canal de voz (ou chamada) e clique em **Compartilhar Tela**.
2. O navegador abre o VDO.Ninja com o seletor nativo. Escolha **tela inteira, janela ou aba** e marque **compartilhar áudio** se quiser.
3. Pronto: o botão fica verde no Discord e o seu perfil mostra **"Assistir Transmissão"**. O link de visualização também é copiado para a área de transferência.
4. Para encerrar, clique de novo em **Compartilhar Tela**. Fechar a aba do navegador também funciona: o Rich Presence some em até ~45 s.

Alternativas ao botão:

- **Comando `/vdoshare`** no chat (BetterDiscord recente). Alterna a transmissão e mostra o link para você.
- **Configurações do plugin → Alternar transmissão.**

### Áudio do sistema: o que esperar

| Fonte escolhida | Windows (Chrome/Edge) | macOS (Chrome/Edge) | Linux |
|---|---|---|---|
| Aba do navegador | ✅ áudio da aba | ✅ áudio da aba | ✅ áudio da aba |
| Tela inteira | ✅ áudio do sistema | depende da versão do sistema/navegador | depende do PipeWire/Pulse |
| Janela | ❌ (limitação do navegador) | ❌ | ❌ |

> Dica: para transmitir o áudio de um jogo ou app junto com a janela, escolha **Tela inteira** com "Compartilhar áudio do sistema".

---

## Configurações

| Seção | Opção | Padrão |
|---|---|---|
| Transmissão | ID fixo (link permanente) ou novo a cada transmissão | Fixo |
| | Qualidade: 1080p / nativa / 720p / 360p | 1080p |
| | FPS alvo | 60 |
| | Tipo de conteúdo: movimento / detalhe / automático | Movimento |
| | Áudio em alta qualidade (`&stereo`) | Ligado |
| | Botão antes do seletor (`&screenshare2`) | Desligado |
| | Meshcast (muitos espectadores) | Desligado |
| | Parâmetros extras do transmissor | — |
| Visualização | Bitrate solicitado (kbps) | 6000 |
| | Codec preferido | Automático |
| | Mensagem de espera | "A transmissão vai começar em instantes..." |
| | Parâmetros extras do espectador | — |
| Rich Presence | Ativar / Application ID / nome / tipo (Assistindo, Jogando…) / linhas / texto do botão / imagem | Assistindo |
| Comportamento | Interceptar o botão do Discord | Ligado |
| | Rótulos extras do botão (calibração) | — |
| | Copiar link ao iniciar | Ligado |
| | Detectar fim da transmissão | Ligado |
| | URL do VDO.Ninja / da API (instância própria) | vdo.ninja |

---

## Experiência de quem assiste

- O link abre direto no player do VDO.Ninja. Não há sala, conta, instalação nem botão de "entrar".
- Se a transmissão ainda não começou, aparece a mensagem de espera. O vídeo entra sozinho assim que você escolhe a tela.
- **Autoplay com som:** navegadores podem bloquear vídeo **com áudio** até haver uma interação com a página. Quando isso acontece, o VDO.Ninja mostra um botão de play em tela cheia: **um clique** e pronto. Nenhum parâmetro de URL consegue contornar essa política do navegador. Quem assiste com frequência pode liberar o som permanentemente em `chrome://settings/content/sound`, adicionando `vdo.ninja` em "Permitido reproduzir som".
- Você **não vê** o botão do seu próprio Rich Presence (comportamento do Discord), mas todos os outros veem. Para testar, peça para alguém ou use uma segunda conta.

## Muitos espectadores

Por ser P2P, cada espectador consome upload seu (≈ o bitrate pedido por espectador). Para mais do que alguns espectadores, ative **Meshcast**: você envia um único stream a um servidor do VDO.Ninja, que distribui para todos. A latência aumenta um pouco.

## Privacidade e segurança

- O **Stream ID** (12 caracteres aleatórios) funciona como a "senha" da transmissão: quem tem o link de visualização pode assistir. Com o ID fixo, o link continua o mesmo entre transmissões. Use **"Novo a cada transmissão"** ou **"Gerar novo ID e chave"** se quiser invalidar links antigos.
- A **chave de API** fica só no link do transmissor, nunca no link de visualização. Não compartilhe o link do transmissor: quem tiver a chave pode encerrar a sua transmissão.
- A mídia vai direto de você para quem assiste (WebRTC, criptografado). Os servidores do VDO.Ninja só fazem a sinalização, além do relay se você usar Meshcast ou se um TURN for necessário.

## Solução de problemas

| Problema | Solução |
|---|---|
| Clicar em "Compartilhar Tela" abre o Go Live do Discord | O rótulo do botão não foi reconhecido (idioma ou layout novo). Use **Configurações → Calibrar** e clique no botão. Ou adicione o `aria-label` em **Rótulos extras**. |
| O botão "Assistir Transmissão" não aparece para os outros | Confira o **Application ID** e a opção de compartilhar atividade nas configurações de privacidade do Discord. |
| O navegador não abre o seletor de tela | Ative **"Mostrar botão antes do seletor"** (`&screenshare2`). |
| Sem áudio | Escolha **Tela inteira** ou **Aba** e marque compartilhar áudio. Use Chrome/Edge. Não adicione `&noaudio`. |
| Qualidade baixa / travando | Diminua a qualidade para 720p ou o FPS, reduza o bitrate do espectador ou ative Meshcast. |
| Rich Presence ficou preso | Clique em **Alternar transmissão** nas configurações ou desative e reative o plugin. |

## Referências

- [VDO.Ninja: screen-share parameters](https://docs.vdo.ninja/advanced-settings/screen-share-parameters)
- [VDO.Ninja: HTTP/WSS API](https://docs.vdo.ninja/advanced-settings/api-and-midi-parameters/api/api-reference)
- [VDO.Ninja: autoplay](https://docs.vdo.ninja/common-errors-and-known-issues/autoplay-doesnt-work-in-chrome-or-vmix-v77)
- [VDO.Ninja: Meshcast](https://docs.vdo.ninja/advanced-settings/meshcast-parameters/and-meshcast)
- [BetterDiscord: documentação de plugins](https://docs.betterdiscord.app/plugins)
