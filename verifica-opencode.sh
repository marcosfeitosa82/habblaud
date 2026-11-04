#!/bin/bash
# verifica-opencode.sh — cada etapa tem criterio PASS/FAIL
# Uso: bash /root/habblaud/verifica-opencode.sh
set -u
PASS=0; FAIL=0
check() {
  local desc="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "PASS: $desc"; PASS=$((PASS+1))
  else
    echo "FAIL: $desc"; FAIL=$((FAIL+1))
  fi
}
check "OpenCode CLI real intacto (symlink)" test -L /usr/local/bin/opencode
check "OpenCode CLI binario responde" bash -c '/usr/local/bin/opencode --version 2>/dev/null | grep -q v2'
check "Habblaud dist compilado" test -s /root/habblaud/dist/server/index.js
check "Habblaud package.json existe" test -s /root/habblaud/package.json
check "Wrapper /usr/local/bin/oc existe" test -x /usr/local/bin/oc
check "service.json do OpenCode existe" test -s /root/.local/state/opencode/service.json
check "service.json tem version 2.x" grep -q 'version' /root/.local/state/opencode/service.json 2>/dev/null
check "Habblaud respondendo na porta 4747" curl -fs -o /dev/null --max-time 2 http://127.0.0.1:4747/
echo "=== RESULTADO: $PASS PASS, $FAIL FAIL ==="
exit $FAIL
