#!/usr/bin/env bash
# 清理无标签的孤儿镜像版本。
#
# 为什么需要这么小心：ghcr 里一次多架构推送会产生多个「版本」——
# index（有标签）+ 各平台子 manifest（无标签）+ buildx attestation（无标签）。
# 直接删无标签版本会把现存镜像打断成拉取失败。
#
# 因此流程是「先算引用，再删」：
#   1. 列出仓库里所有现存标签
#   2. 对每个标签 docker manifest inspect，收集它引用的子 digest（含 index 的子层）
#   3. 引用集合 = 所有标签自身的 digest ∪ 所有被引用的子 digest
#   4. 只删「无标签 且 digest 不在引用集合里 且 早于 BEFORE」的版本
#
# 任一步 inspection 失败即整体退出（宁可不删，不可删错）。
#
# 环境变量：
#   GH_TOKEN    必填（需 read:packages + delete:packages）
#   IMAGE_NAME  必填，形如 owner/name
#   OWNER       可选
#   BEFORE      必填，只处理早于此日期的版本（YYYY-MM-DD）
#   DRY_RUN     'true' 只列出不删除
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN required}"
: "${IMAGE_NAME:?IMAGE_NAME required}"
: "${BEFORE:?BEFORE required}"
DRY_RUN="${DRY_RUN:-true}"
OWNER="${OWNER:-$(echo "$IMAGE_NAME" | cut -d/ -f1)}"
PKG="$(echo "$IMAGE_NAME" | cut -d/ -f2 | tr '[:upper:]' '[:lower:]')"
REF="ghcr.io/${OWNER,,}/${PKG}"

API="https://api.github.com/orgs/${OWNER}/packages/container/${PKG}/versions"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

echo "== 1. 列举版本 =="
page=1
while :; do
  curl -sS -H "Authorization: Bearer ${GH_TOKEN}" \
       -H 'Accept: application/vnd.github+json' \
       -H 'X-GitHub-Api-Version: 2022-11-28' \
       -o "${WORK}/p-${page}.json" "${API}?per_page=100&page=${page}"
  kind="$(jq -r 'type' "${WORK}/p-${page}.json")"
  if [ "$kind" != 'array' ]; then
    echo "::error::列举版本失败：$(jq -r '.message // "未知错误"' "${WORK}/p-${page}.json")"; exit 1
  fi
  n="$(jq 'length' "${WORK}/p-${page}.json")"
  [ "$n" -lt 100 ] && break
  page=$((page+1))
done
for f in "${WORK}"/p-*.json; do jq -c '.[]' "$f"; done > "${WORK}/all.jsonl"
echo "  总版本数: $(grep -c . "${WORK}/all.jsonl")"

echo "== 2. 收集现存标签 =="
jq -s -r '[ .[].metadata.container.tags[] ] | unique | .[]' "${WORK}/all.jsonl" > "${WORK}/tags.txt"
tagcount="$(grep -c . "${WORK}/tags.txt" || true)"
echo "  标签数: ${tagcount}"
if [ "${tagcount:-0}" -eq 0 ]; then echo '::error::仓库里没有任何标签，拒绝继续'; exit 1; fi

echo "== 3. 登录并逐个解析引用 =="
echo "${GH_TOKEN}" | docker login ghcr.io -u "${OWNER}" --password-stdin >/dev/null 2>&1 \
  || { echo '::error::docker login 失败'; exit 1; }

: > "${WORK}/refs.txt"
fail=0
while read -r tag; do
  [ -z "$tag" ] && continue
  if ! out="$(docker manifest inspect "${REF}:${tag}" 2>/dev/null)"; then
    echo "::error::无法解析 ${tag} 的 manifest"; fail=$((fail+1)); continue
  fi
  # index 的 .manifests[].digest 是子 manifest；单架构 manifest 没有 .manifests
  echo "$out" | jq -r '.manifests[]?.digest // empty' >> "${WORK}/refs.txt"
  # 再把子 digest 里可能嵌套的 index 也展开一层
  echo "$out" | jq -r '.manifests[]?.digest // empty' | while read -r d; do
    [ -z "$d" ] && continue
    docker manifest inspect "${REF}@${d}" 2>/dev/null | jq -r '.manifests[]?.digest // empty' >> "${WORK}/refs.txt" || true
  done
done < "${WORK}/tags.txt"

if [ "$fail" -ne 0 ]; then
  echo "::error::有 ${fail} 个标签解析失败，为安全起见中止（不删任何版本）"
  exit 1
fi

# 标签自身指向的 digest 同样要保护
jq -s -r '[ .[] | select((.metadata.container.tags // []) | length > 0) | .name ] | .[]' "${WORK}/all.jsonl" >> "${WORK}/refs.txt"
sort -u "${WORK}/refs.txt" > "${WORK}/refs.sorted"
echo "  受保护的 digest 数: $(grep -c . "${WORK}/refs.sorted")"
if [ "$(grep -c . "${WORK}/refs.sorted")" -lt 10 ]; then
  echo '::error::受保护 digest 数量异常偏少，中止'; exit 1
fi

echo "== 4. 筛选候选：无标签 + 早于 ${BEFORE} + 未被引用 =="
jq -s -r --arg before "${BEFORE}T00:00:00Z" --rawfile refs "${WORK}/refs.sorted" '
  ($refs | split("\n") | map(select(. != ""))) as $ref
  | [ .[]
      | select((.metadata.container.tags // []) | length == 0)
      | select(.created_at < $before)
      # 必须先把 .name 绑到变量：管道里 . 已经变成 $ref 了，直接写 .name 会取到 null
      | .name as $n
      | select(($ref | index($n)) == null)
      | { id, name: $n, created_at }
    ]
  | sort_by(.created_at)
  | .[]
  | "\(.id)\t\(.created_at[0:10])\t\(.name)"
' "${WORK}/all.jsonl" > "${WORK}/cand.tsv"

cand="$(grep -c . "${WORK}/cand.tsv" || true)"
echo "  可删候选: ${cand} 个"
if [ "${cand:-0}" -eq 0 ]; then echo '没有可清理的孤儿版本'; exit 0; fi

if [ "$DRY_RUN" = 'true' ]; then
  echo '  前 5 个样例:'
  head -5 "${WORK}/cand.tsv" | sed 's/^/    /'
  echo '::notice::DRY_RUN=true，未删除任何版本'
  exit 0
fi

ok=0; bad=0; first_bad=''
while IFS=$'\t' read -r id date digest; do
  [ -z "$id" ] && continue
  code="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' "${API}/${id}" || echo 000)"
  case "$code" in
    204|200) ok=$((ok+1)) ;;
    *) bad=$((bad+1)); [ -z "$first_bad" ] && first_bad="${id} (HTTP ${code})" ;;
  esac
done < "${WORK}/cand.tsv"

echo "已删除: ${ok}  失败: ${bad}"
[ -n "$first_bad" ] && echo "::warning::首个失败: ${first_bad}"
exit 0
