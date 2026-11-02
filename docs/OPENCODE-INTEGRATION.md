# Integração OpenCode

O Habblaud mostra as sessões do **OpenCode** como um provedor independente (`opencode`). A integração fala a API
HTTP v2 do serviço local do OpenCode: não lê `opencode.db`, `auth.json`, tokens nem transcripts internos, e não
acrescenta dependências de runtime.

## Como ligar

O observador fica **desligado por padrão**:

```bash
HABBLAUD_OPENCODE=1 npm start
```

Com o OpenCode aberto normalmente, o Habblaud encontra o serviço sozinho. Duas descobertas são tentadas, nesta ordem:

1. **Registro do serviço:** `$XDG_STATE_HOME/opencode/service.json` ou, sem `XDG_STATE_HOME`,
   `~/.local/state/opencode/service.json` (o arquivo que a TUI grava com `{ id, version, url, pid, password }`). O
   Habblaud confere que o PID ainda existe e pergunta a `/api/info` qual versão/PID o serviço informa; só aceita
   quando os dois batem e a versão é da série **2.x**.
2. **Endereço explícito:** `HABBLAUD_OPENCODE_URL` (e `HABBLAUD_OPENCODE_PASSWORD` para Basic Auth). Sem registro
   válido nem URL explícita, ele tenta o endereço histórico `http://127.0.0.1:4096`.

Só são aceitos endereços de loopback (`localhost`, `127.0.0.0/8` ou `::1`). A senha lida do registro, ou vinda de
`HABBLAUD_OPENCODE_PASSWORD`, fica só em memória e no cabeçalho Basic Auth; nunca entra na URL, no snapshot, nos logs
ou nas mensagens de erro.

```bash
# Só é preciso quando o registro automático não existe (OpenCode antigo, outra porta ou outro processo).
HABBLAUD_OPENCODE=1 \
HABBLAUD_OPENCODE_URL=http://127.0.0.1:4096 \
HABBLAUD_OPENCODE_PASSWORD='a-mesma-senha-do-serviço' npm start
```

## O que aparece no escritório

- **Sessões ativas** (as que o serviço informa como em execução) aparecem como `working`.
- **Sessões recentes** encerradas há menos de **30 minutos** continuam no escritório como `idle`; passado esse tempo,
  elas saem. A lista é reconciliada com `/api/session` e `/api/session/active` no boot, a cada reconexão e a cada
  15 segundos, porque o stream de eventos não tem replay.
- **Status e atividades:** `session.status` (busy/idle), execução, shells em segundo plano, permissões pendentes
  (`waiting`), chamadas de ferramenta, passos, raciocínio e texto.
- **Subagentes:** sessões filhas (`parentID`) viram subagentes do principal (`Office.addSub`).
- **Terminal e histórico:** o terminal mostra a conversa real (prompts, respostas, ferramentas e resultados) pela
  API; o histórico lista as sessões recentes não arquivadas, abertas ou encerradas, e abre a mesma conversa.
- **Mensagens:** a caixa de mensagem envia um `prompt` à sessão, como se o usuário tivesse digitado. Uma mensagem por
  agente de cada vez, na ordem; `delivered` = a API aceitou o prompt, e o texto nunca vai para o log. Sem o serviço
  local, o agente não aparece como `canMessage` e a caixa explica o motivo.
- **Permissões:** um pedido aberto na API vira o cartão “Pede permissão” da gaveta (só com página local aberta e
  sessão conhecida). Aprovar responde `once`; recusar responde `reject` com o motivo; **interromper** também chama
  `POST /api/session/:id/interrupt`. O pedido que a ferramenta responder por fora (ou que a sessão deixar) sai do
  escritório sem decisão.

## Segurança e limites

- A API é consultada só em loopback, com timeout e validação dos envelopes das respostas.
- Nada de banco SQLite, credenciais da TUI ou arquivos internos do OpenCode; nenhum segredo em log, UI ou URL.
- O SSE (`/api/event`) alimenta o ao vivo, mas **não tem replay**: eventos perdidos são recuperados pela
  reconciliação por polling.
- A janela de sessões recentes é de 30 minutos; sessões mais antigas ficam só no histórico da API.
- O **Habblaud World** fica **fora do escopo** desta entrega: as sessões `opencode` continuam explicitamente
  excluídas da projeção (o World ainda não negocia `provider: 'opencode'`), em vez de serem convertidas para Claude.
- Projetado para o Habblaud rodando localmente com Node. Dentro de um container Docker, o loopback não aponta para o
  serviço do OpenCode no host; esse caso não é suportado nesta versão.
