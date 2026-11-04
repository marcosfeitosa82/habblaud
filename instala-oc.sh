#!/bin/bash
# instala-oc.sh — instala o comando `oc` no sistema (padrão: /usr/local/bin/oc).
#
# Uso:
#   bash instala-oc.sh            # instala em /usr/local/bin/oc
#   bash instala-oc.sh ~/bin/oc   # instala em outro caminho
#
# Depois de instalar, use:
#   oc          abre o OpenCode CLI e sobe o Habblaud integrado em segundo plano
#   oc status   mostra o estado dos dois
#   oc restart  reinicia o Habblaud com as credenciais atuais do OpenCode
#   oc stop     para o Habblaud
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$ROOT/scripts/oc"
DEST="${1:-/usr/local/bin/oc}"

if [ ! -f "$SRC" ]; then
  echo "ERRO: $SRC não encontrado (rode este script na pasta do Habblaud)." >&2
  exit 1
fi

install -m 755 "$SRC" "$DEST"
echo "Instalado: $DEST"
echo "Teste com: oc status"
