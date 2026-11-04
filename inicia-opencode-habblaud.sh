#!/bin/bash
# inicia-opencode-habblaud.sh (atalho legado)
# O comando recomendado agora é `oc` (instale com `bash instala-oc.sh`).
# Este script apenas delega para ele, mantendo compatibilidade com quem já usa
# o nome antigo. O `oc` espera o serviço do OpenCode, lê a URL/senha atuais do
# service.json e reinicia um Habblaud mal configurado sozinho.
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"

if command -v oc >/dev/null 2>&1; then
  exec oc "$@"
fi

exec "$DIR/scripts/oc" "$@"
