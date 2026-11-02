# Integração OpenCode

## Escopo desta entrega

A integração inicial adiciona o OpenCode como provedor independente (`opencode`) e consulta a API HTTP v2 do backend local. O conector é somente leitura: descobre execuções ativas, diretório do projeto, título e modelo. Não lê `opencode.db`, `auth.json`, tokens ou arquivos internos de sessão.

O recurso é opt-in (`HABBLAUD_OPENCODE=1`) e aceita somente endpoints loopback. A autenticação Basic é montada no servidor usando `HABBLAUD_OPENCODE_PASSWORD`; a senha nunca vai para a interface, URL ou logs.

## Contrato implementado

- `OpenCodeApiClient`: valida origem local, aplica Basic Auth, timeout e valida envelopes das respostas.
- `OpenCodeSource`: implementa `AgentSource`, consulta `/api/info`, `/api/session/active` e `/api/session/:id` a cada 1,5 s.
- `AccountsService`: registra uma conta OpenCode sem interferir nas contas Claude Code ou Codex.
- `Office.addMain`: recebe título e modelo para a sessão OpenCode.
- UI: identifica OpenCode, não oferece envio de mensagens e mantém o botão de terminal desabilitado até existir um transporte de conversa.
- Habblaud World: sessões OpenCode são explicitamente excluídas da projeção atual, em vez de serem convertidas incorretamente para Claude.

O backend precisa ser o dono das sessões observadas. Inicie `opencode serve` em loopback e conecte a CLI com `opencode attach http://127.0.0.1:4096`. Sessões executadas por outro processo OpenCode independente não são garantidas no endpoint de sessões ativas desse backend.

## Próximas fases

1. **Eventos e reconciliação:** consumir `/api/event` (SSE) e manter polling de reconciliação para recuperar eventos perdidos.
2. **Conversas:** normalizar mensagens, blocos de texto, chamadas de ferramentas e resultados para o modelo de terminal do Habblaud.
3. **Histórico:** implementar `HistoryProvider` com paginação e resolução de sessão pela API, sem depender do SQLite.
4. **Subagentes:** mapear `parentID` em `AgentInfo.parentId` e validar a semântica dos eventos de sessão filha.
5. **Controle:** somente depois, implementar envio de prompts, interrupção e respostas a permissões, usando endpoints oficiais e autorização explícita.

## Arquitetura reutilizável para a plataforma própria

A integração não deve se tornar o núcleo da plataforma futura. Extraia os conceitos para contratos neutros de provedor:

- `ProviderAdapter`: conexão, autenticação, descoberta e ciclo de vida.
- `Session`: identidade, workspace, pai, estado e timestamps.
- `Agent`: papel, modelo, capacidades e vínculo com sessão.
- `Event`: execução iniciada/concluída, mensagem, ferramenta, permissão e erro.
- `Message`: conteúdo estruturado, partes, anexos e metadados.
- `ToolCall`: nome, argumentos, resultado, duração e estado.
- `PermissionRequest`: ação solicitada, escopo, política e decisão.
- `Workspace`: diretório, repositório, branch e contexto do projeto.
- `EventBus`: distribuição ordenada, deduplicação, replay e reconciliação.
- `PermissionEngine`: política central independente do provedor.

O núcleo deve consumir eventos normalizados e não conhecer os formatos privados de cada CLI. Adaptadores devem permanecer responsáveis por traduzir APIs e protocolos oficiais. Credenciais ficam em um cofre/ambiente do lado servidor; nunca em snapshots ou no navegador.

## Limites conhecidos

- A API HTTP v2 é a interface suportada por esta integração; o conector não depende do schema SQLite interno.
- Esta versão mostra apenas sessões ativas do backend conectado; não importa histórico antigo.
- Sessões filhas são ignoradas temporariamente.
- O terminal de conversa e ações de controle permanecem desabilitados para OpenCode.
- A integração foi desenhada para Habblaud executado localmente com Node. O endereço loopback dentro de um container Docker não aponta automaticamente para o host.
