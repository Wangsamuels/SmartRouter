#!/usr/bin/env bash
# Idempotent Heroku setup via the Platform API (no CLI needed).
# Usage: HEROKU_API_KEY=... infra/heroku-setup.sh   (or put the key in ./.heroku-key)
set -euo pipefail
KEY="${HEROKU_API_KEY:-$(cat "$(dirname "$0")/../.heroku-key")}"
H=(-sS -H "Accept: application/vnd.heroku+json; version=3" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json")
api() { curl "${H[@]}" -X "$1" "https://api.heroku.com$2" ${3:+-d "$3"}; }

PIPELINE=smartrouter
declare -A NET=([smartrouter-testnet]=moderato [smartrouter-mainnet]=tempo)
declare -A STAGE=([smartrouter-testnet]=staging [smartrouter-mainnet]=production)

pid=$(api GET /pipelines | python3 -c "import json,sys;print(next((p['id'] for p in json.load(sys.stdin) if p['name']=='$PIPELINE'),''))")
[ -z "$pid" ] && pid=$(api POST /pipelines "{\"name\":\"$PIPELINE\"}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
echo "pipeline $PIPELINE: $pid"

for app in smartrouter-testnet smartrouter-mainnet; do
  if ! api GET "/apps/$app" | grep -q '"git_url"'; then
    api POST /apps "{\"name\":\"$app\",\"region\":\"us\",\"stack\":\"heroku-24\"}" >/dev/null && echo "created $app"
  fi
  api PUT "/apps/$app/buildpack-installations" '{"updates":[{"buildpack":"heroku/nodejs"}]}' >/dev/null
  have=$(api GET "/apps/$app/addons" | python3 -c 'import json,sys;print(" ".join(a["addon_service"]["name"] for a in json.load(sys.stdin)))')
  for plan in heroku-postgresql:essential-0 heroku-redis:mini; do
    svc=${plan%%:*}; [[ " $have " == *" $svc "* ]] || { api POST "/apps/$app/addons" "{\"plan\":\"$plan\"}" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(" ", d.get("name") or d)'; }
  done
  secret=$(python3 -c 'import secrets;print(secrets.token_hex(32))')
  mppsecret=$(python3 -c 'import secrets;print(secrets.token_hex(32))')
  cur=$(api GET "/apps/$app/config-vars")
  vars=$(CUR="$cur" NETWORK="${NET[$app]}" SECRET="$secret" MPPSECRET="$mppsecret" python3 -c '
import json,os
cur=json.loads(os.environ["CUR"]); n=os.environ["NETWORK"]
want={"TEMPO_NETWORK":n,"NODE_ENV":"production","MAX_PROVIDER_PRICE_MULTIPLIER":"2","FEE_PCT":"10","DEFAULT_ALLOCATION_USD":"2","NODE_MODULES_CACHE":"true"}
if "SESSION_SECRET" not in cur: want["SESSION_SECRET"]=os.environ["SECRET"]
if "MPP_SECRET_KEY" not in cur: want["MPP_SECRET_KEY"]=os.environ["MPPSECRET"]
if n=="moderato": want.setdefault("FEE_PAYER_URL","https://sponsor.moderato.tempo.xyz")
print(json.dumps({k:v for k,v in want.items() if cur.get(k)!=v}))')
  [ "$vars" != "{}" ] && api PATCH "/apps/$app/config-vars" "$vars" >/dev/null
  # pipeline coupling
  api POST /pipeline-couplings "{\"app\":\"$app\",\"pipeline\":\"$pid\",\"stage\":\"${STAGE[$app]}\"}" >/dev/null 2>&1 || true
  echo "$app ready (${NET[$app]})"
done
