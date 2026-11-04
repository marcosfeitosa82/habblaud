#!/bin/bash
# inicia-opencode-habblaud.sh
# Garante que o Habblaud inicie corretamente quando o OpenCode estiver ativo
# Roda no host (Termux/Proot) ou dentro do Alpine — o /root/habblaud é o mesmo inode

PROJECT=/root/habblaud

# 1. Confirma que estamos na pasta do projeto (evita o ENOENT de /root/package.json)
cd "$PROJECT" || { echo "ERRO: $PROJECT não encontrado"; exit 1; }

# 2. Se o serviço do OpenCode não estiver respondendo, avisa — mas não bloqueia (o serviço pode subir depois)
if ! curl -fs -o /dev/null --max-time 2 http://127.0.0.1:49374/api/info 2>/dev/null; then
  echo "AVISO: serviço OpenCode não respondendo ainda em 127.0.0.1:49374"
  echo "Iniciando habblaud mesmo assim. O OpenCode pode subir depois; a integração funcionará assim que estiver ativo."
fi

# 3. Seta a descoberta automática; se quiser forçar URL explícita, descomente abaixo
export HABBLAUD_OPENCODE=1
# export HABBLAUD_OPENCODE_URL=http://127.0.0.1:49374
# export HABBLAUD_OPENCODE_PASSWORD=$(python3 -c "import json; print(json.load(open('/root/.local/state/opencode/service.json'))['password'])" 2>/dev/null || echo "")

# 4. Remove o log antigo e inicia em background
echo "Iniciando Habblaud com OpenCode (porta 4747). Acesse http://localhost:4747"
rm -f /tmp/habblaud-start.log
nohup npm start > /tmp/habblaud-start.log 2>&1 &
HABBLAUD_PID=$!
echo "PID do Habblaud: $HABBLAUD_PID  (log: /tmp/habblaud-start.log)"
echo "Para parar: kill $HABBLAUD_PID  ou  kill \$(cat /tmp/habblaud.pid 2>/dev/null)"
echo "OpenCode descoberto em $(curl -fs http://127.0.0.1:49374/api/info | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.url + ("/pid:" + str(d.pid) if d.pid else ""))' 2>/dev/null || echo '127.0.0.1:49374')"
