#!/usr/bin/env bash
# 按时间批量清理 ghcr 上的历史镜像版本。
#
# 与 prune-ci-images.sh 的区别：那个按「保留最近 N 次」滚动清理，
# 这个按「早于某日期」一次性清理历史欠账，且默认为 dry-run。
#
# 环境变量：
#   GH_TOKEN    必填，需要 read:packages + delete:packages（CI 里是 GITHUB_TOKEN）
#   IMAGE_NAME  必填，形如 owner/name（大小写不限）
#   OWNER       可选，缺省取 IMAGE_NAME 第一段
#   BEFORE      必填，删除早于此日期的版本（YYYY-MM-DD）
#   DRY_RUN     'true' 只列出不删除
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN required}"
: "${IMAGE_NAME:?IMAGE_NAME required}"
: "${BEFORE:?BEFORE required}"
DRY_RUN="${DRY_RUN:-true}"
OWNER="${OWNER:-$(echo "$IMAGE_NAME" | cut -d/ -f1)}"
PKG="$(echo "$IMAGE_NAME" | cut -d/ -f2 | tr '[:upper:]' '[:lower:]')"

API="https://api.github.com/orgs/${OWNER}/packages/container/${PKG}/versions"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

page=1
while :; do
  curl -sS -H "Authorization: Bearer ${GH_TOKEN}" \
       -H 'Accept: application/vnd.github+json' \
       -H 'X-GitHub-Api-Version: 2022-11-28' \
       -o "${WORK}/p-${page}.json" "${API}?per_page=100&page=${page}&state=active"
  kind="$(jq -r 'type' "${WORK}/p-${page}.json")"
  if [ "$kind" != 'array' ]; then
    echo "::error::列举版本失败：$(jq -r '.message // "未知错误"' "${WORK}/p-${page}.json")"
    exit 1
  fi
  n="$(jq 'length' "${WORK}/p-${page}.json")"
  echo "  page ${page}: ${n} 个"
  [ "$n" -lt 100 ] && break
  page=$((page+1))
done

for f in "${WORK}"/p-*.json; do jq -c '.[]' "$f"; done > "${WORK}/all.jsonl"
total_all="$(grep -c . "${WORK}/all.jsonl" || true)"
echo "总版本数: ${total_all}"

# 保留规则：带版本号、latest、beta、ci、nightly 的一律不动；
# 无标签的也不动——它们是多架构 index 的子 manifest 与 attestation，删了会破坏现存镜像。
jq -s -r --arg before "${BEFORE}T00:00:00Z" '
  [ .[]
    | { id, created_at, tags: (.metadata.container.tags // []) }
    | select(.created_at < $before)
    | select((.tags | length) > 0)
    | select([ .tags[] | select(test("^v?[0-9]+\\.[0-9]+\\.[0-9]+") or . == "latest" or . == "beta" or . == "ci" or . == "nightly") ] | length == 0)
  ]
  | sort_by(.created_at)
  | .[]
  | "\(.id)\t\(.created_at[0:10])\t\(.tags | join(","))"
' "${WORK}/all.jsonl" > "${WORK}/cand.tsv"

cand="$(grep -c . "${WORK}/cand.tsv" || true)"
echo "早于 ${BEFORE} 且仅带非正式标签: ${cand} 个"
if [ "${cand:-0}" -eq 0 ]; then echo '无需清理'; exit 0; fi

echo '前 5 个样例:'
head -5 "${WORK}/cand.tsv" | sed 's/^/  /'

if [ "$DRY_RUN" = 'true' ]; then
  echo ''
  echo '::notice::DRY_RUN=true，未删除任何版本'
  exit 0
fi

ok=0; fail=0; first_fail=''
while IFS=$'\t' read -r id date tags; do
  [ -z "$id" ] && continue
  code="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' "${API}/${id}" || echo 000)"
  case "$code" in
    204|200) ok=$((ok+1)) ;;
    *) fail=$((fail+1)); [ -z "$first_fail" ] && first_fail="${id} (HTTP ${code})" ;;
  esac
done < "${WORK}/cand.tsv"

echo "已删除: ${ok}  失败: ${fail}"
[ -n "$first_fail" ] && echo "::warning::首个失败: ${first_fail}"
exit 0
