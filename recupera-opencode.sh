#!/bin/bash
# recupera-opencode.sh — restaura e reinicia se algo falhar
# Uso: bash /root/habblaud/recupera-opencode.sh
set -u

echo "=== RECUPERACAO HABBLAUD + OPENCODE ==="

# 1. Confirma que o opencode real (symlink) existe
if ! test -L /usr/local/bin/opencode; then
  echo "ERRO CRITICO: /usr/local/bin/opencode nao e symlink. Nao sobrescreva o binario real!"
  exit 1
fi
echo "OK: /usr/local/bin/opencode e symlink (binario real intacto)"

# 2. Confirma dist do Habblaud
if ! test -s /root/habblaud/dist/server/index.js; then
  echo "Habblaud dist nao encontrado. Compilando..."
  cd /root/habblaud && npm run build
fi
echo "OK: dist/server/index.js presente"

# 3. Confirma wrapper oc
if ! test -x /usr/local/bin/oc; then
  echo "Wrapper /usr/local/bin/oc nao encontrado. Recriando..."
  cat > /usr/local/bin/oc << 'OCEOF'
#!/bin/bash
# /usr/local/bin/oc — inicia Habblaud + OpenCode juntos via Alpine
set -u
ALPINE="proot-distro login alpine --"
if ! curl -fs -o /dev/null --max-time 2 http://127.0.0.1:4747/ 2>/dev/null; then
  echo ">>> Iniciando Habblaud (porta 4747)..." >&2
  $ALPINE bash -c "cd /root/habblaud && HABBLAUD_OPENCODE=1 nohup npm start > /tmp/habblaud.log 2>&1 &"
  for i in $(seq 1 10); do
    curl -fs -o /dev/null --max-time 1 http://127.0.0.1:4747/ 2>/dev/null && echo ">>> Habblaud subiu" >&2 && break
    sleep 1
  done
fi
echo ">>> Iniciando OpenCode (Habblaud em http://localhost:4747)..." >&2
exec $ALPINE opencode
OCEOF
  chmod +x /usr/local/bin/oc
fi
echo "OK: /usr/local/bin/oc presente"

# 4. Mata Habblaud antigo na porta 4747 se houver
OLD_PID=$(lsof -ti:4747 2>/dev/null | head -1)
if [ -n "$OLD_PID" ]; then
  echo "Matando Habblaud antigo (PID $OLD_PID) na porta 4747..."
  kill -9 "$OLD_PID" 2>/dev/null
  sleep 1
fi

# 5. Inicia Habblaud com OpenCode
echo "Iniciando Habblaud (HABBLAUD_OPENCODE=1)..."
cd /root/habblaud
HABBLAUD_OPENCODE=1 nohup npm start > /tmp/habblaud.log 2>&1 &
HABBLAUD_PID=$!
echo "PID Habblaud: $HABBLAUD_PID (log: /tmp/habblaud.log)"

# 6. Aguarda porta 4747 responder
echo "Aguardando Habblaud subir..."
for i in $(seq 1 15); do
  if curl -fs -o /dev/null --max-time 1 http://127.0.0.1:4747/ 2>/dev/null; then
    echo "Habblaud subiu em http://localhost:4747"
    break
  fi
  sleep 1
  if [ $i -eq 15 ]; then
    echo "ERRO: Habblaud nao respondeu em 15s. Log:"
    tail -30 /tmp/habblaud.log
    exit 1
  fi
done

# 7. Executa verificação final
bash /root/habblaud/verifica-opencode.sh

# 8. Abre OpenCode em primeiro plano (exec substitui o processo)
echo "=== RECUPERACAO CONCLUIDA ==="
echo "Iniciando OpenCode em primeiro plano..."
exec proot-distro login alpine -- opencode
