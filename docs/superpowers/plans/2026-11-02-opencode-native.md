# Integração nativa do OpenCode — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** transformar o MVP somente leitura do OpenCode na integração local completa: descoberta automática do serviço, sessões abertas e ociosas, eventos ao vivo, status/atividades, subagentes, terminal, histórico, mensagens, permissões e interrupção — sem dependências de runtime e sem tocar no Habblaud World.

**Architecture:** o Habblaud passa a falar com o mesmo serviço local que a TUI do OpenCode já usa. A descoberta lê o registro padrão `$XDG_STATE_HOME/opencode/service.json` (ou `~/.local/state/opencode/service.json`), valida PID/versão contra `/api/info` e usa Basic Auth com a senha do registro. Um stream SSE em `/api/event` alimenta o escritório ao vivo; `/api/session` e `/api/session/active` reconciliam no boot e a cada reconexão. Terminal e histórico são montados sob demanda a partir de `/api/session/:id/message`, sem ler banco, credenciais ou arquivos internos.

**Tech Stack:** Node.js >= 22.12, TypeScript, Vitest, `fetch` nativo, SSE, sem dependências de runtime.

**Spec:** `docs/OPENCODE-INTEGRATION.md` (contrato atual, a ser reescrito na Task 6) + as decisões fixadas neste plano.

## Global Constraints

- **Zero dependências de runtime.** Não adicionar `@opencode/client` nem outro pacote ao `dependencies`; replicar apenas o contrato público necessário.
- **Somente loopback.** URL do OpenCode precisa ser `http(s)://localhost`, `127.0.0.0/8` ou `::1`, sem credenciais, caminho, query ou hash.
- **Segredo nunca sai do servidor.** A senha do serviço só existe em memória e no cabeçalho `Authorization: Basic base64("opencode:" + senha)`. Nunca logar, nunca pôr na URL, nunca mandar ao cliente.
- **Nada de arquivos internos.** Não ler `opencode.db`, `auth.json`, transcripts ou estado da TUI; só a API HTTP v2 e o registro de serviço.
- **World intocado.** `shared/world/` e `server/world/` ficam fora desta entrega; nenhum agente OpenCode é enviado ao World nesta fase.
- **Compatibilidade.** Claude Code e Codex continuam com o comportamento atual; campos novos no protocolo são opcionais.
- **Texto visível** sempre por `tr('texto em PT')`, com `shared/locales/` atualizado e `npm run i18n:check` passando.
- **CHANGELOG:** toda mudança visível entra em “Não lançado”.
- **Verificação:** `npm run typecheck` e `npx vitest run` verdes antes de cada commit.

## Review Focus

1. **Registro velho ou morto:** `service.json` aponta para PID que não existe, porta fechada ou versão incompatível. O Habblaud deve continuar subindo, mostrar “aguardando conexão” e nunca derrubar as fontes Claude/Codex.
2. **Serviço reiniciou noutra porta:** o SSE cai e o registro muda. A fonte deve redescobrir sozinha, sem exigir reiniciar o Habblaud e sem duplicar agentes.
3. **Sessão ociosa:** ao terminar o turno, a sessão deve continuar no escritório como `idle` por uma janela de recência (30 min por padrão), em vez de sumir em ~3 s.
4. **Falha isolada:** uma sessão ou endpoint com erro não pode fechar todas as outras nem apagar o escritório; o erro fica visível em `meta.sources`.
5. **Corrida de controle:** permissão respondida no terminal, sessão encerrada no meio ou mensagem repetida não podem deixar cartão preso, agente `waiting` eterno ou mensagem duplicada.

---

### Task 1: Descoberta nativa do serviço

**Files:**
- Create: `server/sources/opencode/discovery.ts`
- Create: `server/sources/opencode/discovery.test.ts`
- Modify: `server/config.ts`
- Modify: `server/index.ts`

**Interfaces:**
- Produces:
  - `type OpenCodeOrigin = 'explicit' | 'service' | 'fallback'`
  - `interface OpenCodeEndpoint { url: string; password?: string; version?: string; pid?: number; origin: OpenCodeOrigin }`
  - `function serviceFilePath(env: NodeJS.ProcessEnv, home: string): string`
  - `function parseServiceFile(raw: string): { id?: string; version?: string; url: string; pid: number; password?: string } | undefined`
  - `async function discoverEndpoint(options: { home: string; env?: NodeJS.ProcessEnv; explicitUrl?: string; explicitPassword?: string; fetchImpl?: typeof fetch; timeoutMs?: number; pidAlive?: (pid: number) => boolean }): Promise<OpenCodeEndpoint>`
  - `async function probeEndpoint(endpoint: OpenCodeEndpoint, options?: { fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<{ version: string; pid: number } | undefined>`

- [ ] **Step 1: Escrever os testes de descoberta**

`server/sources/opencode/discovery.test.ts` deve cobrir, com `fetchImpl` falso e `pidAlive` injetado:

```ts
it('lê o registro padrão e aceita um serviço cujo /api/info casa PID e versão')
// arquivo em <home>/.local/state/opencode/service.json; url http://127.0.0.1:49374; pid 123; version 2.2.4
// probe responde { version: '2.2.4', pid: 123 }
// espera origin 'service', url e password do arquivo

it('ignora registro com PID morto, JSON inválido ou versão fora da 2.x')
// pidAlive false -> cai no fallback 4096; JSON inválido -> fallback; probe version 3.0.0 -> fallback

it('HABBLAUD_OPENCODE_URL explícita tem precedência e não lê o registro')
// explicitUrl http://127.0.0.1:4096; password da env; origin 'explicit'

it('recusa URL explícita não loopback, com caminho ou com credenciais')
// lança /endereço local/ e /somente origem/

it('aceita XDG_STATE_HOME e o fallback ~/.local/state')
// serviceFilePath({XDG_STATE_HOME:'/x'}, '/h') === '/x/opencode/service.json'
// serviceFilePath({}, '/h') === '/h/.local/state/opencode/service.json'

it('não vaza a senha em mensagens de erro')
// fetch rejeita; o erro não contém o password
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run server/sources/opencode/discovery.test.ts`
Expected: FAIL porque `discovery.ts` ainda não existe.

- [ ] **Step 3: Implementar `discovery.ts`**

Regras exatas:
- `serviceFilePath(env, home)` = `join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'opencode', 'service.json')`.
- `parseServiceFile` aceita somente objeto com `url` string, `pid` inteiro >= 0, `password` string opcional, `version` string opcional; devolve `undefined` em qualquer outro caso.
- `discoverEndpoint`:
  1. `explicitUrl` presente: validar com a mesma função de origem do `OpenCodeApiClient` (extrair `validateOrigin` para exportar ou duplicar a checagem) e devolver `{ url, password: explicitPassword, origin: 'explicit' }`.
  2. Ler o arquivo com `readFile`; se ausente/ inválido, ir ao passo 4.
  3. Se `pidAlive` (padrão: `process.kill(pid, 0)` sem matar) for falso, ir ao passo 4. Senão `probeEndpoint`; exigir `pid` igual e versão com major `2`; devolver `origin: 'service'`.
  4. Fallback `{ url: 'http://127.0.0.1:4096', password: explicitPassword, origin: 'fallback' }`.
- `probeEndpoint` chama `GET /api/info` com Basic Auth quando houver senha e `AbortSignal.timeout`; valida `{ version: string, pid: number }`.
- Nenhuma mensagem de erro interpola `password` ou a URL com credenciais.

- [ ] **Step 4: Ajustar `config.ts` e `index.ts`**

Em `ServerConfig`, trocar `opencodeUrl: string` por `opencodeUrl?: string` e adicionar `opencodePassword?: string`. Em `loadConfig`:

```ts
opencodeUrl: env.HABBLAUD_OPENCODE_URL?.trim() || undefined,
opencodePassword: env.HABBLAUD_OPENCODE_PASSWORD?.trim() || undefined,
```

Em `server/index.ts`, passar `baseUrl: config.opencodeUrl`, `password: config.opencodePassword` e `env: process.env` para `OpenCodeSource`.

- [ ] **Step 5: Rodar testes e typecheck**

Run: `npx vitest run server/sources/opencode/discovery.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/sources/opencode/discovery.ts server/sources/opencode/discovery.test.ts server/config.ts server/index.ts
git commit -m "feat(opencode): descobre o serviço local pelo registro padrão"
```

---

### Task 2: Cliente HTTP v2 e stream de eventos

**Files:**
- Modify: `server/sources/opencode/client.ts`
- Create: `server/sources/opencode/events.ts`
- Create: `server/sources/opencode/events.test.ts`
- Modify: `server/sources/opencode/client.test.ts`

**Interfaces:**
- Produces:
  - `interface OpenCodeSessionsQuery { limit?: number; order?: 'asc' | 'desc'; archived?: boolean; parentID?: string; cursor?: string; directory?: string }`
  - `interface OpenCodeEvent { id?: string; type: string; data: unknown; created?: number }`
  - `OpenCodeApiClient.sessions(query?): Promise<OpenCodeSession[]>`
  - `OpenCodeApiClient.messages(sessionId, query?): Promise<unknown[]>`
  - `OpenCodeApiClient.permissions(sessionId): Promise<OpenCodePermission[]>`
  - `OpenCodeApiClient.replyPermission(sessionId, requestId, decision: 'once' | 'always' | 'reject', message?): Promise<void>`
  - `OpenCodeApiClient.interrupt(sessionId, resume?): Promise<void>`
  - `OpenCodeApiClient.prompt(sessionId, text): Promise<void>`
  - `OpenCodeApiClient.eventResponse(signal: AbortSignal): Promise<Response>`
  - `function parseEventFrame(frame: string): OpenCodeEvent | undefined`
  - `class OpenCodeEventStream { constructor(opts: { open: (signal: AbortSignal) => Promise<Response>; onEvent: (e: OpenCodeEvent) => void; onState?: (s: 'open' | 'closed') => void; onError?: (e: unknown) => void; reconnectMs?: number; maxReconnectMs?: number; now?: () => number }); start(): void; stop(): void }`

- [ ] **Step 1: Escrever os testes do cliente**

Em `client.test.ts`, adicionar:

```ts
it('lista sessões com limit/order/archived e valida o envelope')
// fetch recebe /api/session?limit=50&order=desc&archived=false
// devolve { data: [ { id:'ses_1' } ] }

it('lê mensagens e permissões de uma sessão')
// GET /api/session/ses_1/message e /api/session/ses_1/permission
// valida array em data

it('responde permissão, interrompe e manda prompt com POST e JSON')
// confere método, content-type e corpo { decision:'once' }, { text:'oi' }, etc.

it('eventResponse não usa timeout curto e envia accept text/event-stream')
```

- [ ] **Step 2: Escrever os testes do parser/stream**

`events.test.ts`:

```ts
it('ignora heartbeats e comentários e devolve o evento JSON')
// frame ': heartbeat\n\ndata: {"id":"evt_1","type":"server.connected","data":{}}\n\n'

it('junta data: em várias linhas e descarta JSON inválido')
it('reconecta com backoff crescente e para quando stop() é chamado')
// open falso: primeiro Response 500/erro, depois um stream com server.connected; usa now/reconnectMs injetados
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run server/sources/opencode/client.test.ts server/sources/opencode/events.test.ts`
Expected: FAIL pelos métodos ausentes.

- [ ] **Step 4: Implementar o cliente e o stream**

No cliente, extrair um `request<T>(method, path, body?)` único, com `AbortSignal.timeout(this.timeoutMs)` para JSON e sem timeout para o SSE. `eventResponse` usa `accept: 'text/event-stream'` e o mesmo `authorization`.

No `OpenCodeEventStream`:
- `open(signal)` devolve `Response`; se `!ok` ou `body` nulo, lançar.
- Ler `response.body` com `getReader()`, decodificar com `TextDecoder`, acumular e separar frames por `\n\n` (aceitar `\r\n\r\n`).
- `parseEventFrame`: ignorar linhas iniciadas por `:`; juntar `data:` com `\n`; `JSON.parse`; exigir `type` string; devolver `{ id?, type, data, created? }`.
- Ao receber `server.connected`, `onState?.('open')` e zerar o backoff.
- Em erro/fim, `onState?.('closed')`, agendar reconexão com `min(maxReconnectMs, reconnectMs * 2^n)` + jitter determinístico injetável; `stop()` aborta e não reconecta.

- [ ] **Step 5: Rodar testes e typecheck**

Run: `npx vitest run server/sources/opencode/client.test.ts server/sources/opencode/events.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/sources/opencode/client.ts server/sources/opencode/client.test.ts server/sources/opencode/events.ts server/sources/opencode/events.test.ts
git commit -m "feat(opencode): amplia o cliente v2 e adiciona stream de eventos"
```

---

### Task 3: Fonte orientada a eventos, sessões ociosas e subagentes

**Files:**
- Modify: `server/sources/opencode/source.ts`
- Modify: `server/sources/opencode/source.test.ts`
- Create: `server/sources/opencode/activity.ts`
- Create: `server/sources/opencode/activity.test.ts`

**Interfaces:**
- Consumes: `discoverEndpoint`, `OpenCodeApiClient`, `OpenCodeEventStream`.
- Produces:
  - `OpenCodeSourceOptions` acrescenta `env?: NodeJS.ProcessEnv`, `recentMs?: number`, `reconcileMs?: number`, `discover?: typeof discoverEndpoint`, `eventStream?: (opts) => Pick<OpenCodeEventStream, 'start' | 'stop'>`.
  - `OpenCodeSource.api(): OpenCodeApiClient | undefined` (para histórico e conversa).
  - `describeOpenCodeTool(name: string, input: unknown): { kind: ActivityKind; icon: string; text: string; detail?: string }`
  - `describeOpenCodePermission(action: string, resources: string[], message?: string): { title: string; text: string; icon: string; input?: string; inputKind?: TerminalInputKind }`

- [ ] **Step 1: Escrever os testes de atividade**

`activity.test.ts`:

```ts
it('mapeia ferramentas comuns para atividades curtas em PT-BR')
// bash -> kind 'run'; read -> 'read'; edit/write -> 'edit'/'write'; grep/glob -> 'search';
// webfetch -> 'web'; task -> 'delegate'; nome desconhecido -> 'other'

it('mascara segredos e corta o detalhe')
// input { command: 'curl -H "Authorization: Bearer abc"' } não contém 'abc' no retorno

it('descreve permissão como "bash(comando)" e limita o título')
```

- [ ] **Step 2: Escrever os testes da fonte**

Substituir/completar `source.test.ts` com:

```ts
it('no boot, mostra sessões ativas como working e recentes como idle')
// /api/session devolve uma ativa (updated agora) e uma ociosa (updated 5 min atrás)
// ambas entram; a ativa working, a ociosa idle

it('não mostra sessão mais velha que recentMs nem filha como principal')
// updated 2 h atrás fica fora; parentID vira subagente do pai

it('mapeia session.status busy/idle e session.idle')
// eventos mudam working -> idle sem polling

it('permission.asked deixa waiting; permission.replied volta ao status anterior')
// chama onPermission/onPermissionGone injetados

it('um erro numa chamada não fecha as outras sessões')
// /api/session ok, /api/session/active falha: mantém as sessões e reporta error em sources()

it('redescobre quando o stream cai')
// discover é chamado de novo e o cliente passa a usar a URL nova

it('shell em segundo plano vira status shell e termina em idle')
// session.shell.started/ended + setShells
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run server/sources/opencode/activity.test.ts server/sources/opencode/source.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implementar `activity.ts`**

Usar `maskSecrets`, `truncate` e os tipos de `shared/activity`/`shared/types`. Tabela de nomes OpenCode (`bash`, `read`, `edit`, `write`, `grep`, `glob`, `webfetch`, `task`, `todowrite`, `skill`, `mcp*`) para `ActivityKind`, ícone e texto. Nenhum texto com o comando cru sem máscara.

- [ ] **Step 5: Reescrever `OpenCodeSource`**

Estrutura:
- `start()`: `beginBoot`; `endBoot` no `finally`; `await this.connect()` (descobre + cria cliente + `reconcile()` + inicia stream); timer de `reconcileMs` (15 s).
- `connect()`: `discoverEndpoint`; se falhar, `this.error` e mantém o timer tentando; se o endpoint mudou (url/pid/version), recria o cliente e reseta o mapa de status.
- `reconcile()`:
  - `sessions = await client.sessions({ limit: 100, order: 'desc', archived: false })`
  - `active = await client.activeSessions()` com `Promise.allSettled` isolado.
  - Candidatos: `!archived`, `isAbsolute(location.directory)`, `active[id] || now - time.updated <= recentMs`.
  - Principais: `addMain` com `status = statusOf(id)` (waiting se permissão pendente; shell se shells ativos e idle; senão active ? working : idle).
  - Filhos: se o pai está no Office, `addSub({ id, parentId, sessionId, role: agent ?? 'subagente', title, background: true, startedAt })`; se não está ativo, `completeSub`.
  - Fecha somente os ids presentes que saíram da lista.
- `handleEvent`: implementar a tabela abaixo; cada atividade usa `ev.id` como id para ser idempotente.

| Evento | Efeito |
|---|---|
| `server.connected` | `reconcile()` + recuperar permissões pendentes |
| `session.status` | `busy`→working; `idle`→idle; `retry`→working + atividade “Tentando de novo (N)” |
| `session.idle` | idle |
| `session.execution.started` | working + atividade “Trabalhando” |
| `session.execution.succeeded` | idle |
| `session.execution.failed` | idle + atividade de erro com a mensagem estruturada |
| `session.execution.interrupted` | idle + atividade “Interrompido” |
| `session.step.started` | atividade “Pensando” (kind `think`) |
| `session.reasoning.started` | atividade “Pensando” |
| `session.text.started` | atividade “Escrevendo resposta” |
| `session.tool.called` | `describeOpenCodeTool`; se `bash`, adiciona `ShellJob` em primeiro plano |
| `session.tool.success` | se era `bash`, `shellDone`; remove o job |
| `session.tool.failed` | atividade de erro; se era `bash`, `shellDone` com `failed` |
| `session.shell.started` | adiciona `ShellJob` em segundo plano |
| `session.shell.ended` | remove o job e `shellDone` conforme `exit`/`status` |
| `session.compaction.started/ended` | atividade `compact` |
| `permission.asked` | `onPermission?.({...})` e `setStatus(waiting, 'aprovar uma permissão')` |
| `permission.replied` | `onPermissionGone?.(sessionID, requestID)` e restaura status |
| `session.renamed`/`session.moved` | `reconcile()` |

- [ ] **Step 6: Rodar testes e typecheck**

Run: `npx vitest run server/sources/opencode && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/sources/opencode/source.ts server/sources/opencode/source.test.ts server/sources/opencode/activity.ts server/sources/opencode/activity.test.ts
git commit -m "feat(opencode): observa eventos, sessões ociosas e subagentes"
```

---

### Task 4: Conversa e histórico pela API

**Files:**
- Modify: `server/sources/source.ts`
- Create: `server/sources/opencode/conversation.ts`
- Create: `server/sources/opencode/conversation.test.ts`
- Create: `server/sources/opencode/history.ts`
- Create: `server/sources/opencode/history.test.ts`
- Modify: `server/http/terminal.ts`
- Modify: `server/http/sessions.ts`
- Modify: `server/index.ts`

**Interfaces:**
- Produces:
  - `interface ConversationSource { readonly intervalMs: number; load(): TerminalInit; poll(): { init?: TerminalInit; append?: TerminalEntry[]; stop?: boolean } }` em `server/sources/source.ts`.
  - `AgentSource.conversationOf?(agentId: string): ConversationSource | undefined`
  - `SourceSet.conversationOf(agentId)`
  - `HistorySession` passa a aceitar `{ path?: string; createParser?: () => TerminalParser; conversation?: () => ConversationSource }`.
  - `class OpenCodeConversation implements ConversationSource`
  - `class OpenCodeHistory implements HistoryProvider`

- [ ] **Step 1: Escrever os testes da conversa**

`conversation.test.ts`:

```ts
it('monta user, assistant, thinking, tool e result na ordem')
// mensagem user + assistant completo com text, reasoning e tool completed

it('não emite mensagem/ferramenta ainda em streaming; emite quando completa')
// primeiro poll vazio; segundo poll com time.completed -> entradas

it('faz diff por id e não repete entradas')
// load + poll com a mesma lista -> append vazio

it('sessão apagada (404) devolve stop')
```

- [ ] **Step 2: Escrever os testes do histórico**

`history.test.ts`:

```ts
it('lista sessões recentes com provider opencode, projeto, título e horários')
it('exclui filhas e arquivadas')
it('resolve uma sessão da conta com conversation; id inválido = 400; conta errada = 404')
it('não aceita id com path traversal')
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run server/sources/opencode/conversation.test.ts server/sources/opencode/history.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implementar `OpenCodeConversation`**

- `load()`: `client.messages(sessionId, { limit: 200, order: 'asc' })`; mapear com `toEntries(messages)`; guardar `seen`; devolver `{ agentId, entries: last N, truncated }`.
- `poll()`: nova busca; `fresh = entries.filter(e => !seen.has(e.id))`; adicionar ao `seen`; devolver `{ append: fresh }`; se o cliente responder 404, `{ stop: true }`.
- `toEntries`: para cada mensagem pronta (user sempre; assistant só com `time.completed` ou `finish`; tool só em `completed`/`error`), gerar ids estáveis `${msg.id}:${index}`. Result id `${msg.id}:${index}:result`, `toolUseId` igual ao id da ferramenta. Usar `describeOpenCodeTool` para título/entrada e `maskSecrets`/`truncate` para conteúdo. Ignorar partes desconhecidas.
- Limitar o `seen` a 5.000 ids (descartar os mais antigos) para não crescer sem fim.

- [ ] **Step 5: Implementar `OpenCodeHistory`**

- `list()`: `client.sessions({ limit: HISTORY_LIMIT, order: 'desc', archived: false })`; excluir `parentID`; montar `RecentSession` com `provider:'opencode'`, `project: location.directory`, `projectDir: encodeCwd(cwd)` (reutilizar `encodeCwd` de `sources/watcher`), `title`, `firstAt: time.created`, `lastAt: time.updated`, `size: 0`, `open`/`agentId` via `openAgentOf`.
- `resolve(account, sessionId)`: conta conhecida; id `/^ses_[A-Za-z0-9]{10,64}$/`; devolver `{ conversation: () => new OpenCodeConversation({ client, sessionId, agentId: ... }) }`; erro 400/404 como os outros provedores.
- `client` vem de `opencode.api()`; se `undefined`, `list()` lança “serviço OpenCode indisponível” (o `HistorySet` isola).

- [ ] **Step 6: Integrar terminal e rotas**

- `SourceSet.conversationOf(agentId)` percorre as fontes.
- `TerminalStreams` ganha `conversationOf?: (agentId) => ConversationSource | undefined`; em `sourceFor`, antes do transcript, usar a conversa da fonte.
- `attachSession` ganha irmão `attachConversation(req, res, streamId, source)`; `sessions.ts` usa `found.conversation?.()` quando existir, senão o caminho atual.
- `server/index.ts`: `TerminalStreams({ ..., conversationOf: (id) => agents.conversationOf(id) })`; adicionar `new OpenCodeHistory({ client: () => opencode?.api(), accounts: () => accounts.entriesOf('opencode'), openAgentOf: ... })` ao `HistorySet` quando `opencode` existir.
- `OpenCodeSource.conversationOf(agentId)` devolve `new OpenCodeConversation(...)` para agentes principais da conta.

- [ ] **Step 7: Rodar testes e typecheck**

Run: `npx vitest run server/sources/opencode server/http/terminal.test.ts server/http/sessions.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/sources/source.ts server/sources/opencode/conversation.ts server/sources/opencode/conversation.test.ts server/sources/opencode/history.ts server/sources/opencode/history.test.ts server/http/terminal.ts server/http/sessions.ts server/index.ts
git commit -m "feat(opencode): conversa e histórico pela API v2"
```

---

### Task 5: Mensagens, permissões e interrupção

**Files:**
- Modify: `server/messages/registry.ts`
- Modify: `server/messages/registry.test.ts`
- Modify: `server/permissions/registry.ts`
- Modify: `server/permissions/registry.test.ts`
- Modify: `server/sources/opencode/client.ts` (se faltar `interrupt`)
- Modify: `server/index.ts`
- Modify: `client/src/ui/composer-model.ts`
- Modify: `client/src/ui/composer-model.test.ts`
- Modify: `client/src/ui/permission.ts`
- Modify: `client/src/ui/permission.test.ts`
- Modify: `client/src/ui/drawer.ts`

**Interfaces:**
- Consumes: `OpenCodeApiClient.prompt/replyPermission/interrupt`.
- Produces:
  - `MessageRegistryOptions.opencode?: { prompt: (sessionId: string, text: string) => Promise<void> }`
  - `PermissionRegistry.askExternal(input: { provider: 'opencode'; agentId: string; sessionId: string; requestId: string; action: string; resources: string[]; message?: string; onDecide: (d: PermissionDecision) => void }): boolean`
  - `PermissionRegistry.resolveExternal(provider: Provider, sessionId: string, requestId: string): void`
  - `PermissionRegistry.dropSession(sessionId: string): void`

- [ ] **Step 1: Escrever os testes de mensagens**

```ts
it('agente OpenCode com entregador aparece como canMessage e recebe prompt')
// reachable inclui o principal opencode; send -> prompt(sessionId, texto) chamado; status delivered

it('falha do prompt marca failed sem duplicar')
// prompt rejeita; status failed; segunda tentativa não reenvia

it('sem entregador, OpenCode não aparece como canMessage')
```

- [ ] **Step 2: Escrever os testes de permissão**

```ts
it('askExternal publica o pedido e decide chamando onDecide')
// viewers > 0; snapshot tem o agente; decide allow -> onDecide({behavior:'allow'})

it('resolveExternal tira o cartão e não deixa waiting órfão')
it('dropSession descarta pedidos da sessão encerrada')
it('sem página aberta, askExternal não desvia')
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `npx vitest run server/messages/registry.test.ts server/permissions/registry.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implementar a entrega de mensagens**

- `reachable()`: se `this.opencodeAvailable()`, incluir principais `provider === 'opencode'` presentes.
- `canMessage()`: branch OpenCode com `opencodeAvailable() && present && main`.
- `send()`: marcar `entry.opencode = true`; chamar `pumpOpenCode()`.
- `pumpOpenCode()`: processar uma mensagem por agente; `await prompt(sessionId, text)`; sucesso → `finish(delivered)` + atividade `describeMessage`; erro → `fail` com mensagem curta. Nunca logar o texto.
- `opencodeAvailable()` = `!!this.opts.opencode`.

- [ ] **Step 5: Implementar permissões externas**

- `Pending` ganha `external?: { key: string; onDecide: (d: PermissionDecision) => void }`.
- `askExternal`: validar agente OpenCode presente, `viewers() > 0`, limite `maxPending`; montar `PermissionRequestInfo` com `provider:'opencode'`, `tool: action`, `title/text/icon/input` de `describeOpenCodePermission`; `expiresAt = now + 10 min`; `noticePermission`; guardar.
- `decide`: após validar, se `p.external`, chamar `p.external.onDecide(d)` (uma vez) e resolver o `Pending`.
- `resolveExternal` e `dropSession`: remover do mapa e `markDirty`.
- `server/index.ts`: no `OpenCodeSource`, `onPermission` chama `late.permissions?.askExternal({...})`; o `onDecide` do source chama `replyPermission` (`allow`→`once`, `deny`→`reject` + `message`, e `interrupt` → `client.interrupt`). `onPermissionGone` chama `resolveExternal('opencode', sessionID, requestID)`.
- `client/src/ui/permission.ts`: OpenCode com `{ always: false, interrupt: true, reasonRequired: false, seconds: false, note: tr('...') }`; `PermissionDecision` já suporta `interrupt`.

- [ ] **Step 6: Liberar o composer e o terminal**

- `composer-model.ts`: remover a linha que desliga `opencode`; `composerTip('opencode')` explica que a mensagem entra na sessão via API.
- `drawer.ts`: remover `supported = provider !== 'opencode'` e o texto “próxima fase”; o terminal fica disponível quando `available && live`.
- Ajustar `provider.ts`/`widgets.ts` se algum texto ainda disser “somente leitura”.

- [ ] **Step 7: Rodar testes e typecheck**

Run: `npx vitest run server/messages server/permissions client/src/ui/composer-model.test.ts client/src/ui/permission.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/messages server/permissions server/sources/opencode server/index.ts client/src/ui
git commit -m "feat(opencode): mensagens, permissões e interrupção pela API"
```

---

### Task 6: Acabamento, documentação e verificação completa

**Files:**
- Modify: `docs/OPENCODE-INTEGRATION.md`
- Modify: `server/README.md`
- Modify: `README.pt-BR.md` / `README.md` (seção OpenCode)
- Modify: `CHANGELOG.md`
- Modify: `shared/locales/*` (textos novos)
- Test: suíte completa

- [ ] **Step 1: Atualizar a documentação**

Reescrever `docs/OPENCODE-INTEGRATION.md` com:
- descoberta automática (registro padrão + fallback `HABBLAUD_OPENCODE_URL`);
- `HABBLAUD_OPENCODE=1` e `HABBLAUD_OPENCODE_PASSWORD` (só para modo explícito);
- o que aparece (sessões ativas e recentes, status, subagentes, terminal, histórico);
- mensagens/permissões/interrupção e a trava local;
- limites: sem replay de eventos (reconciliação por polling), janela de 30 min, World fora do escopo.

Atualizar `server/README.md` e o README com os mesmos fatos, sem prometer o World.

- [ ] **Step 2: CHANGELOG e i18n**

Adicionar em “Não lançado” uma entrada sobre a integração nativa do OpenCode. Rodar `npm run i18n:check` e traduzir todas as chaves novas nos locales existentes.

- [ ] **Step 3: Verificação completa**

Run:
```bash
npm run typecheck
npm run i18n:check
npx vitest run
```
Expected: tudo PASS. Se o teste instável de `server/world/uplink.test.ts` falhar, registrar como problema pré-existente e **não** alterar `server/world` nesta entrega; rodar a suíte novamente com `--exclude` apenas para evidência, sem commitar mudança no World.

- [ ] **Step 4: Revisão do diff**

Conferir que `git diff` não contém `shared/world/`, `server/world/`, senha, URL com credenciais ou leitura de `opencode.db`. Conferir que `package.json` não ganhou dependência.

- [ ] **Step 5: Commit final**

```bash
git add docs server/README.md README.pt-BR.md README.md CHANGELOG.md shared/locales
git commit -m "docs(opencode): documenta a integração nativa local"
```

---

## Critérios de aceite

- Com o OpenCode aberto normalmente (sem `opencode serve`/`attach` manual), o Habblaud descobre o serviço e mostra a conta `.opencode`.
- Uma sessão que termina o turno continua no escritório como `idle` por 30 min; uma sessão ativa aparece como `working`.
- Subagentes aparecem como `sub` do principal e saem ao concluir.
- O terminal da gaveta mostra a conversa real (prompts, respostas, ferramentas e resultados) e continua ao vivo.
- O histórico lista sessões OpenCode abertas e encerradas e abre a conversa.
- Mensagens enviadas pelo escritório chegam via `prompt`; permissões aparecem e são respondidas via `reply`; “interromper” chama `/interrupt`.
- Reiniciar o serviço do OpenCode não exige reiniciar o Habblaud.
- Nenhum segredo aparece em log, UI ou URL; nenhuma dependência nova; Claude/Codex intactos.
- `npm run typecheck`, `npm run i18n:check` e `npx vitest run` passam.
