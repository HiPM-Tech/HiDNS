#!/usr/bin/env bash
# 清理 ghcr 上旧的 CI 构建：只保留最近 KEEP 次 `*-ci` 构建。
#
# 为什么是独立脚本而不是内联在 workflow 里：内联版本有 60 行、含嵌套引号的
# curl/jq 组合，既没法本地跑也没法本地校验，改一次就要推一次才知道对不对。
#
# 环境变量：
#   GH_TOKEN    必填，需要 packages:write
#   IMAGE_NAME  必填，形如 owner/name（大小写不限，脚本内部转小写）
#   OWNER       可选，组织/用户名；缺省取 IMAGE_NAME 的第一段
#   KEEP        保留的构建数，默认 14
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN required}"
: "${IMAGE_NAME:?IMAGE_NAME required}"
OWNER="${OWNER:-$(echo "$IMAGE_NAME" | cut -d/ -f1)}"
# ghcr 的包名必须小写；组织名保持原样，不依赖 API 路径大小写不敏感
PKG="$(echo "$IMAGE_NAME" | cut -d/ -f2 | tr '[:upper:]' '[:lower:]')"
KEEP="${KEEP:-14}"

API="https://api.github.com/orgs/${OWNER}/packages/container/${PKG}/versions"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ── 1. 分页拉取全部版本 ────────────────────────────────────────────────
page=1
pages=0
while :; do
  url="${API}?per_page=100&page=${page}"
  if ! curl -sS -H "Authorization: Bearer ${GH_TOKEN}" \
       -H 'Accept: application/vnd.github+json' \
       -H 'X-GitHub-Api-Version: 2022-11-28' \
       -o "${WORK}/page-${page}.json" "${url}"; then
    echo '::warning::列举镜像版本失败（网络）'
    exit 0
  fi
  kind="$(jq -r 'type' "${WORK}/page-${page}.json")"
  if [ "$kind" != 'array' ]; then
    msg="$(jq -r '.message // "未知错误"' "${WORK}/page-${page}.json")"
    echo "::warning::无法列举镜像版本（token 权限或包归属问题）：${msg}"
    exit 0
  fi
  n="$(jq 'length' "${WORK}/page-${page}.json")"
  pages=$((pages+1))
  [ "$n" -eq 0 ] && break
  [ "$n" -lt 100 ] && break
  page=$((page+1))
done

if [ "$pages" -eq 0 ]; then
  echo '没有拿到任何版本，跳过'
  exit 0
fi

for f in "${WORK}"/page-*.json; do jq -c '.[]' "$f"; done > "${WORK}/all.jsonl"

# ── 2. 按「一次构建」聚合，挑出最旧的若干部 ──────────────────────────
# 一次 CI 构建产出 <sha>-ci、<sha>-ci-amd64、<sha>-ci-arm64 三个版本，
# 必须整组保留或整组删除，否则会留下悬空的单架构 tag。
# 只认 <7~40 位十六进制>-ci 形态：滚动 ci、latest、beta、版本号标签都不匹配。
jq -s -r --argjson keep "${KEEP}" '
  [ .[]
    | { id: .id, created_at: .created_at, tags: (.metadata.container.tags // []) }
    | .build = ([ .tags[]
                  | (try (capture("^(?<k>[0-9a-f]{7,40})-ci(-amd64|-arm64)?$").k) catch null) ]
                | map(select(. != null)) | first)
    | select(.build != null)
  ]
  | group_by(.build)
  | map({ build: .[0].build, created: (map(.created_at) | max), ids: map(.id) })
  | sort_by(.created) | reverse
  | .[ $keep : ]
  | .[].ids[]
' "${WORK}/all.jsonl" > "${WORK}/prune.txt"

total="$(grep -c . "${WORK}/prune.txt" || true)"
if [ "${total:-0}" -eq 0 ]; then
  echo "CI 构建数量未超过 ${KEEP}，无需清理"
  exit 0
fi

# ── 3. 逐个删除 ────────────────────────────────────────────────────────
echo "将删除 ${total} 个旧版本（保留最近 ${KEEP} 次构建）"
failed=0
while read -r id; do
  [ -z "$id" ] && continue
  code="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    "${API}/${id}" || echo 000)"
  case "$code" in
    204|200) echo "  已删除版本 ${id}" ;;
    *) echo "::warning::删除版本 ${id} 失败（HTTP ${code}）"; failed=$((failed+1)) ;;
  esac
done < "${WORK}/prune.txt"

[ "$failed" -eq 0 ] || echo "::warning::有 ${failed} 个版本未能删除，下次运行会重试"
